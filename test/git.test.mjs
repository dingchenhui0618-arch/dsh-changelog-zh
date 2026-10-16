// git 层测试：解析器喂字符串，范围/notes/numstat 用真仓库验证。

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  GitError,
  collectCommits,
  defaultRange,
  isGitRepo,
  lastTag,
  listNotesRefs,
  listTags,
  normalizeRename,
  parseGitLog,
  parseNumstat,
  parseNumstatLog,
  repoInfo,
  sanitizeDate,
  sanitizeRev,
  tryGit,
  validateRange,
} from '../src/git.js'
import { cleanupDir, makePlainDir, makeRepo, repoTest } from './helpers/repo.mjs'

const FIELD = '\u001f'
const RECORD = '\u001e'

function logRecord(fields) {
  return fields.join(FIELD) + RECORD
}

test('parseGitLog 解析多行正文、notes 与 numstat 之外的一切', () => {
  const text =
    logRecord(['a'.repeat(40), 'aaaaaaa', '张三', 'z@example.com', '2026-10-16T10:00:00+08:00', '2026-10-16T10:05:00+08:00', 'feat: 支持导出', '第一行\n第二行', '']) +
    logRecord(['b'.repeat(40), 'bbbbbbb', '李四', 'tester@example.com', '2026-10-15T09:00:00+08:00', '2026-10-15T09:00:01+08:00', 'fix: 修掉崩溃', '', '已验证：node --test'])
  const commits = parseGitLog(text)
  assert.equal(commits.length, 2)
  assert.equal(commits[0].sha, 'a'.repeat(40))
  assert.equal(commits[0].short, 'aaaaaaa')
  assert.equal(commits[0].author, '张三')
  assert.equal(commits[0].subject, 'feat: 支持导出')
  assert.equal(commits[0].body, '第一行\n第二行')
  assert.equal(commits[0].notes, '')
  assert.equal(commits[1].notes, '已验证：node --test')
  assert.equal(commits[1].body, '')
})

test('parseGitLog 容忍正文里混进分隔符与畸形记录', () => {
  const text =
    RECORD + 'not-a-record\n' +
    RECORD + logRecord(['c'.repeat(40), 'ccccccc', 'A', 'a@b.c', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'subject', 'body' + FIELD + 'with separator', 'n']) +
    '\n\n' +
    logRecord(['d'.repeat(40), 'ddddddd', 'B', 'b@b.c', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', 'subject2', '', ''])
  const commits = parseGitLog(text)
  assert.equal(commits.length, 2, JSON.stringify(commits.map((c) => c.sha)))
  assert.equal(commits[0].body, 'body' + FIELD + 'with separator')
  assert.equal(commits[0].notes, 'n')
})

test('parseGitLog 空输入与非字符串输入返回空数组', () => {
  assert.deepEqual(parseGitLog(''), [])
  assert.deepEqual(parseGitLog(undefined), [])
  assert.deepEqual(parseGitLog('\n\n'), [])
})

test('parseNumstat 处理普通、二进制与重命名路径', () => {
  const files = parseNumstat([
    '12\t3\tsrc/a.js',
    '-\t-\tassets/logo.png',
    '4\t0\tsrc/{old => new}/b.js',
    '1\t1\told-name.js => new-name.js',
    '',
    'garbage-line',
  ].join('\n'))
  assert.equal(files.length, 4)
  assert.deepEqual(files[0], { path: 'src/a.js', insertions: 12, deletions: 3, binary: false })
  assert.equal(files[1].binary, true)
  assert.equal(files[1].insertions, 0)
  assert.equal(files[2].path, 'src/new/b.js')
  assert.equal(files[3].path, 'new-name.js')
})

test('normalizeRename 只动重命名写法', () => {
  assert.equal(normalizeRename('src/a.js'), 'src/a.js')
  assert.equal(normalizeRename('src/{a => b}/c.js'), 'src/b/c.js')
  assert.equal(normalizeRename('old.js => new.js'), 'new.js')
  assert.equal(normalizeRename('dir/{a => }/c.js'), 'dir//c.js'.replace('//', '/'))
})

test('parseNumstatLog 按提交切分', () => {
  const text = RECORD + 'e'.repeat(40) + '\n1\t2\ta.txt\n3\t4\tb.txt\n' + RECORD + 'f'.repeat(40) + '\n5\t6\tc.txt\n'
  const map = parseNumstatLog(text)
  assert.equal(map.size, 2)
  assert.equal(map.get('e'.repeat(40)).length, 2)
  assert.equal(map.get('f'.repeat(40))[0].path, 'c.txt')
})

test('sanitizeRev 挡住会被 git 当成选项或命令的东西', () => {
  assert.equal(sanitizeRev('v1.0.0..HEAD'), 'v1.0.0..HEAD')
  assert.equal(sanitizeRev(' HEAD '), 'HEAD')
  assert.equal(sanitizeRev('main~3'), 'main~3')
  // `git log --output=file` 会写文件，这是查询接口最需要挡的一种输入。
  assert.throws(() => sanitizeRev('--output=out.txt'), (error) => error instanceof GitError && error.code === 'EBADREV')
  assert.throws(() => sanitizeRev('--all'), (error) => error.code === 'EBADREV')
  assert.throws(() => sanitizeRev('HEAD --author=x'), (error) => error.code === 'EBADREV')
  assert.throws(() => sanitizeRev('HEAD;rm -rf /'), (error) => error.code === 'EBADREV')
  assert.throws(() => sanitizeRev('HEAD\n--all'), (error) => error.code === 'EBADREV')
  assert.throws(() => sanitizeRev(''), (error) => error.code === 'EBADREV')
})

test('sanitizeDate 允许带空格的日期，只挡控制字符', () => {
  assert.equal(sanitizeDate('2026-01-01 10:00'), '2026-01-01 10:00')
  assert.equal(sanitizeDate('2026-01-01'), '2026-01-01')
  assert.throws(() => sanitizeDate('2026-01-01\n--all'), (error) => error.code === 'EBADREV')
  assert.throws(() => sanitizeDate('   '), (error) => error.code === 'EBADREV')
})

repoTest('isGitRepo 区分仓库与普通目录', () => {
  const repo = makeRepo()
  const plain = makePlainDir()
  try {
    assert.equal(isGitRepo(repo.dir), true)
    assert.equal(isGitRepo(plain), false)
    assert.equal(isGitRepo(join(repo.dir, '不存在')), false)
    assert.equal(isGitRepo(''), false)
    assert.equal(isGitRepo(undefined), false)
  } finally {
    repo.cleanup()
    cleanupDir(plain)
  }
})

repoTest('tryGit 失败不抛异常，validateRange 失败抛 GitError', () => {
  const repo = makeRepo()
  try {
    repo.commit('chore: 初始化')
    const bad = tryGit(repo.dir, ['rev-parse', '--verify', '不存在的东西'])
    assert.equal(bad.ok, false)
    assert.ok(bad.status !== 0)
    assert.equal(validateRange(repo.dir, 'HEAD'), 'HEAD')
    assert.throws(() => validateRange(repo.dir, 'no-such-rev..HEAD'), (error) => error.code === 'EBADRANGE')
    // 非 ASCII 的 rev 先在字符白名单这一关就被挡住（git 也不接受这样的 rev 名）。
    assert.throws(() => validateRange(repo.dir, '不存在的东西'), (error) => error.code === 'EBADREV')
  } finally {
    repo.cleanup()
  }
})

repoTest('空仓库里 validateRange 会明确报错，而不是让 git 的报错糊过去', () => {
  const repo = makeRepo()
  try {
    assert.throws(() => validateRange(repo.dir, 'HEAD'), (error) => error.code === 'EBADRANGE')
  } finally {
    repo.cleanup()
  }
})

repoTest('collectCommits 带回文件增减，顺序是从新到旧，limit 生效', () => {
  const repo = makeRepo()
  try {
    repo.commit('chore: 初始化', { file: 'a.txt', content: 'a\n' })
    const second = repo.commit('feat: 加一个文件', { file: 'b.txt', content: 'b\nb\n' })
    repo.commit('fix: 改两处', { file: 'a.txt', content: 'a\na\n' })

    const out = collectCommits(repo.dir, { limit: 10 })
    assert.equal(out.commits.length, 3)
    assert.equal(out.truncated, false)
    assert.equal(out.commits[0].subject, 'fix: 改两处')
    assert.equal(out.commits[1].sha, second)
    const feat = out.commits.find((commit) => commit.subject === 'feat: 加一个文件')
    assert.equal(feat.files.length, 1)
    assert.equal(feat.files[0].path, 'b.txt')
    assert.equal(feat.insertions, 2)
    assert.equal(feat.deletions, 0)

    const limited = collectCommits(repo.dir, { limit: 2 })
    assert.equal(limited.commits.length, 2)
    assert.equal(limited.truncated, true)
  } finally {
    repo.cleanup()
  }
})

repoTest('collectCommits 默认不含合并提交，显式要求时才含', () => {
  const repo = makeRepo()
  try {
    repo.commit('chore: 初始化')
    repo.branch('feature-x')
    repo.commit('feat: 分支上的改动', { file: 'x.txt', content: 'x\n' })
    repo.checkout('main')
    repo.commit('chore: 主干继续', { file: 'main.txt', content: 'm\n' })
    repo.merge('feature-x', 'Merge branch feature-x')

    const without = collectCommits(repo.dir, {})
    assert.ok(!without.commits.some((commit) => /^Merge /.test(commit.subject)), '默认应排除合并提交')

    const withMerges = collectCommits(repo.dir, { includeMerges: true })
    assert.ok(withMerges.commits.some((commit) => /^Merge /.test(commit.subject)), '显式要求时应包含合并提交')
  } finally {
    repo.cleanup()
  }
})

repoTest('git notes 真的能读到（这是证据通道之一）', () => {
  const repo = makeRepo()
  try {
    const sha = repo.commit('feat: 带笔记的提交')
    repo.note(sha, '已验证：node --test 42 passed')
    const out = collectCommits(repo.dir, { notesRefs: listNotesRefs(repo.dir) })
    assert.equal(out.commits[0].notes, '已验证：node --test 42 passed')
    assert.deepEqual(listNotesRefs(repo.dir), ['refs/notes/commits'])
  } finally {
    repo.cleanup()
  }
})

repoTest('listTags 同时认轻量标签与附注标签', () => {
  const repo = makeRepo()
  try {
    const first = repo.commit('chore: 初始化')
    repo.tag('v0.1.0', first)
    const second = repo.commit('feat: 第二个')
    repo.tag('v0.2.0', second, true)
    const map = listTags(repo.dir)
    assert.deepEqual(map.get(first), ['v0.1.0'])
    assert.deepEqual(map.get(second), ['v0.2.0'])
    assert.equal(lastTag(repo.dir), 'v0.2.0')
  } finally {
    repo.cleanup()
  }
})

repoTest('defaultRange：没标签取最近提交，有标签取标签之后，HEAD 已是标签则回退上一个标签', () => {
  const repo = makeRepo()
  try {
    const first = repo.commit('chore: 初始化')
    assert.equal(defaultRange(repo.dir).text, undefined)
    assert.match(defaultRange(repo.dir).basis, /没有标签/)

    repo.tag('v1.0.0', first)
    assert.equal(defaultRange(repo.dir).text, undefined, '只有一个提交且它就是标签时不该给空范围')
    assert.match(defaultRange(repo.dir).basis, /没有更早的标签/)

    const second = repo.commit('feat: 标签之后的改动')
    const range = defaultRange(repo.dir)
    assert.equal(range.text, 'v1.0.0..HEAD')
    assert.equal(range.from, 'v1.0.0')

    // 典型场景：刚打完标签就要写 Release notes —— 自动范围必须回退到上一个标签，
    // 否则本次已发布的提交会被再写一遍。
    repo.tag('v1.1.0', second)
    const afterTagging = defaultRange(repo.dir)
    assert.equal(afterTagging.text, 'v1.0.0..HEAD')
    assert.equal(afterTagging.from, 'v1.0.0')
    assert.match(afterTagging.basis, /v1\.1\.0 已在 HEAD 上/)
  } finally {
    repo.cleanup()
  }
})

repoTest('repoInfo 给出根目录、HEAD、分支与远端', () => {
  const repo = makeRepo()
  try {
    repo.commit('chore: 初始化')
    repo.run(['remote', 'add', 'origin', 'https://github.com/example/repo.git'])
    const info = repoInfo(repo.dir)
    assert.equal(info.head, repo.head())
    assert.equal(info.headShort.length, 7)
    assert.equal(info.branch, 'main')
    assert.equal(info.origin, 'https://github.com/example/repo.git')
    assert.equal(info.dirty, false)
    repo.write('untracked.txt', 'x')
    assert.equal(repoInfo(repo.dir).dirty, true)
  } finally {
    repo.cleanup()
  }
})

repoTest('空仓库里 repoInfo 不炸，HEAD 为空串', () => {
  const repo = makeRepo()
  try {
    const info = repoInfo(repo.dir)
    assert.equal(info.head, '')
    assert.equal(info.headShort, '')
    assert.equal(lastTag(repo.dir), undefined)
    assert.equal(defaultRange(repo.dir).text, undefined)
  } finally {
    repo.cleanup()
  }
})
