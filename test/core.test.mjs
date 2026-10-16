// 端到端测试：真造一个 git 仓库，跑完整的 buildReport / generate。
//
// 这里断言的是「这条设想真的成立」：从真实历史里长出两份中文文案，每条带 sha 与
// 验证标记，凭据在出门前被隐去，且没有证据的东西绝不标「已验证」。

import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { ChangelogError, NAME, VERSION, buildReport, generate, renderBoth } from '../src/core.js'
import { cleanupDir, makePlainDir, makeRepo, repoTest } from './helpers/repo.mjs'

const TOKEN = 'ghp_' + 'C'.repeat(36)

/**
 * 一个「内容分布很典型」的仓库：
 *   v0.1.0 打在那条初始化提交上；之后 4 条提交覆盖四类证据来源 + 一条真的没证据。
 */
function seedRepo(repo) {
  const first = repo.commit('chore: 初始化仓库', { file: 'README.md', content: '# 项目\n' })
  repo.tag('v0.1.0', first)
  const feat = repo.commit('feat(cli): 支持导出 Markdown', {
    file: 'cli.js',
    content: 'export const cli = 1\n',
    body: 'Title-zh: 支持把结果导出成 Markdown\nVerified: node --test → 42 passed',
  })
  const fix = repo.commit('fix: 修复导出时的编码问题', {
    file: 'enc.js',
    content: 'export const enc = 2\n',
    body: '测试：node --test，退出码 0',
  })
  repo.note(fix, '已验证：node --test 42 passed')
  const docs = repo.commit('update docs for the new export', { file: 'docs.md', content: '说明\n' })
  const notify = repo.commit('feat: 接入通知渠道，顺手写了 token ' + TOKEN, {
    file: 'notify.js',
    content: 'export const notify = 3\n',
  })
  return { first, feat, fix, docs, notify }
}

const SESSIONS = (notify) => JSON.stringify([
  { commit: notify.slice(0, 7), title: '接入通知渠道', commands: [{ command: 'node --test', exitCode: 0 }] },
])

repoTest('端到端：范围内 4 条提交，两版都带 sha 与验证标记，且凭据被隐去', () => {
  const repo = makeRepo()
  try {
    const shas = seedRepo(repo)
    const out = generate({
      repo: repo.dir,
      sessionsText: SESSIONS(shas.notify),
      now: '2026-10-16T12:00:00Z',
    })
    const report = out.report
    const meta = report.meta

    assert.equal(meta.range.text, 'v0.1.0..HEAD')
    assert.equal(meta.commitCount, 4)
    assert.equal(meta.unverifiedCount, 1, '只有那条没证据的文档提交是未验证')
    assert.equal(meta.repo.head, shas.notify)
    assert.equal(meta.sessions.loaded, true)
    assert.equal(meta.sessions.matched, 1)
    assert.match(meta.range.basis, /最近标签 v0\.1\.0/)

    // 凭据在出门前被隐去：原文里绝不能再出现这个 token。
    assert.equal(meta.redactions.total >= 1, true)
    assert.ok(meta.redactions.hits.some((hit) => hit.kind === 'github-token'))
    assert.equal(out.markdown.user.includes(TOKEN), false)
    assert.equal(out.markdown.dev.includes(TOKEN), false)
    assert.match(out.markdown.dev, /<已隐去:github-token>/)

    // 每条都带短 sha 与标记，两版都是。
    for (const entry of report.entries) {
      assert.match(out.markdown.user, new RegExp('`' + entry.short + '`，(已验证|未验证)'))
      assert.match(out.markdown.dev, new RegExp('`' + entry.short + '`，(已验证|未验证)'))
      assert.equal(out.markdown.dev.includes('`' + entry.sha + '`'), true)
    }

    // 四类证据各自生效。
    const bySubject = new Map(report.entries.map((entry) => [entry.subjectRaw, entry]))
    assert.equal(bySubject.get('feat(cli): 支持导出 Markdown').evidence.verified, true, 'trailer 证据')
    assert.equal(bySubject.get('feat(cli): 支持导出 Markdown').title, '支持把结果导出成 Markdown')
    assert.equal(bySubject.get('feat(cli): 支持导出 Markdown').titleSource, 'trailer')
    assert.equal(bySubject.get('fix: 修复导出时的编码问题').evidence.verified, true, 'notes 证据')
    assert.equal(bySubject.get('feat: 接入通知渠道，顺手写了 token ' + TOKEN).evidence.verified, true, '会话记录证据')
    assert.equal(bySubject.get('update docs for the new export').evidence.verified, false)

    // 标签本身不该被算进「标签之后的变更」。
    assert.equal(report.entries.some((entry) => entry.subjectRaw === 'chore: 初始化仓库'), false)

    assert.deepEqual(meta.titles, { translated: 2, native: 1, missing: 1 })
    assert.deepEqual(out.markdown.user, renderBoth(report, {}).user, 'generate 与 renderBoth 必须一致')
  } finally {
    repo.cleanup()
  }
})

repoTest('端到端：报告里每条都带 SHA、验证标记与可点开的证据原文', () => {
  const repo = makeRepo()
  try {
    const shas = seedRepo(repo)
    const report = buildReport({ repo: repo.dir, sessionsText: SESSIONS(shas.notify) })
    const dev = renderBoth(report).dev
    assert.match(dev, /- 验证：已验证 —— 提交信息 trailer「Verified: node --test → 42 passed」/)
    assert.match(dev, /- 验证：已验证 —— git notes「已验证：node --test 42 passed」/)
    assert.match(dev, /- 验证：已验证 —— 会话记录「node --test（退出码 0）」/)
    assert.match(dev, /- 验证：未验证 —— 提交信息、git notes、会话记录里都没有验证证据/)
    assert.match(dev, /## 未验证条目清单/)
    assert.match(dev, /`[0-9a-f]{7}` update docs for the new export/)
  } finally {
    repo.cleanup()
  }
})

repoTest('端到端：范围为空时输出诚实的空日志', () => {
  const repo = makeRepo()
  try {
    const first = repo.commit('chore: 初始化')
    repo.tag('v1.0.0', first)
    const out = generate({ repo: repo.dir, range: 'v1.0.0..HEAD', now: '2026-10-16T12:00:00Z' })
    assert.equal(out.report.meta.commitCount, 0)
    assert.equal(out.report.meta.unverifiedCount, 0)
    assert.match(out.markdown.user, /本次范围内没有提交/)
    assert.match(out.markdown.user, /共 0 条变更：0 条已验证、0 条未验证/)
  } finally {
    repo.cleanup()
  }
})

repoTest('端到端：HEAD 已打标签时，自动范围回退到上一个标签（不会重写已发布的提交）', () => {
  const repo = makeRepo()
  try {
    const first = repo.commit('chore: 初始化')
    repo.tag('v0.9.0', first)
    const second = repo.commit('feat: 第一个正式功能', { file: 'a.js', content: 'a' })
    repo.tag('v1.0.0', second)
    const out = generate({ repo: repo.dir, now: '2026-10-16T12:00:00Z' })
    assert.equal(out.report.meta.range.text, 'v0.9.0..HEAD')
    assert.equal(out.report.meta.commitCount, 1)
    assert.equal(out.report.entries[0].subjectRaw, 'feat: 第一个正式功能')
    // 那条已发布的初始化提交不该出现在本次日志里。
    assert.equal(out.markdown.user.includes('初始化'), false)
  } finally {
    repo.cleanup()
  }
})

repoTest('端到端：空仓库不炸，给出 0 条与原因', () => {
  const repo = makeRepo()
  try {
    const out = generate({ repo: repo.dir, now: '2026-10-16T12:00:00Z' })
    assert.equal(out.report.meta.commitCount, 0)
    assert.ok(out.report.meta.warnings.some((warning) => /还没有任何提交/.test(warning)))
  } finally {
    repo.cleanup()
  }
})

repoTest('端到端：--limit 截断时明确说可能还有更多', () => {
  const repo = makeRepo()
  try {
    for (let index = 0; index < 5; index += 1) repo.commit('feat: 第 ' + String(index) + ' 个功能', { file: 'f' + String(index) + '.js', content: String(index) })
    const out = generate({ repo: repo.dir, limit: 3, now: '2026-10-16T12:00:00Z' })
    assert.equal(out.report.meta.commitCount, 3)
    assert.equal(out.report.meta.range.truncated, true)
    assert.ok(out.report.meta.warnings.some((warning) => /上限 3 条/.test(warning)))
    assert.match(out.markdown.dev, /已达上限，历史可能还有更多提交/)
  } finally {
    repo.cleanup()
  }
})

repoTest('端到端：since 过滤生效', () => {
  const repo = makeRepo()
  try {
    repo.commit('feat: 很久以前的改动')
    // 用 2030（而不是 2999）：git 对超出它 approxidate 能解析范围的年份会**静默忽略**
    // --since，那样测的就不是本插件了。
    const out = generate({ repo: repo.dir, since: '2030-01-01', now: '2026-10-16T12:00:00Z' })
    assert.equal(out.report.meta.commitCount, 0)
    assert.equal(out.report.meta.since, '2030-01-01')
  } finally {
    repo.cleanup()
  }
})

repoTest('端到端：includeMerges 决定合并提交进不进日志', () => {
  const repo = makeRepo()
  try {
    repo.commit('chore: 初始化')
    repo.branch('feature-x')
    repo.commit('feat: 分支上的功能', { file: 'x.js', content: 'x' })
    repo.checkout('main')
    repo.commit('chore: 主干继续', { file: 'm.js', content: 'm' })
    repo.merge('feature-x', 'Merge branch feature-x')

    const without = generate({ repo: repo.dir, now: '2026-10-16T12:00:00Z' })
    assert.equal(without.report.entries.some((entry) => entry.kind === 'merge'), false)
    const withMerges = generate({ repo: repo.dir, includeMerges: true, now: '2026-10-16T12:00:00Z' })
    assert.equal(withMerges.report.entries.some((entry) => entry.kind === 'merge'), true)
  } finally {
    repo.cleanup()
  }
})

repoTest('端到端：会话记录文件与中文标题映射都能从文件读进来', () => {
  const repo = makeRepo()
  const plain = makePlainDir()
  try {
    const sha = repo.commit('feat: add a thing')
    const sessionsPath = join(plain, 'sessions.jsonl')
    writeFileSync(sessionsPath, '{ \n', 'utf8')
    // JSONL：一条好记录 + 一条坏行
    writeFileSync(sessionsPath, [
      JSON.stringify({ commit: sha.slice(0, 7), commands: [{ command: 'node --test', exitCode: 0 }] }),
      '这不是 json',
    ].join('\n'), 'utf8')
    const titlesPath = join(plain, 'titles.json')
    writeFileSync(titlesPath, JSON.stringify({ [sha]: '加一个新东西' }), 'utf8')

    const out = generate({ repo: repo.dir, sessionsPath: sessionsPath, titlesPath: titlesPath, now: '2026-10-16T12:00:00Z' })
    const entry = out.report.entries[0]
    assert.equal(entry.title, '加一个新东西')
    assert.equal(entry.titleSource, '映射')
    assert.equal(entry.evidence.verified, true, '会话记录里的验证命令生效')
    assert.ok(out.report.meta.warnings.some((warning) => /第 2 行不是合法 JSON/.test(warning)))

    // 传了 titles 对象时对象优先。
    const override = generate({ repo: repo.dir, titles: { [sha]: '另一个标题' }, now: '2026-10-16T12:00:00Z' })
    assert.equal(override.report.entries[0].title, '另一个标题')
  } finally {
    repo.cleanup()
    cleanupDir(plain)
  }
})

repoTest('端到端：中文标题映射写错时报 ETITLES，不静默忽略', () => {
  const repo = makeRepo()
  const plain = makePlainDir()
  try {
    repo.commit('feat: x')
    const bad = join(plain, 'titles.json')
    writeFileSync(bad, '[1,2,3]', 'utf8')
    assert.throws(() => buildReport({ repo: repo.dir, titlesPath: bad }), (error) => error.code === 'ETITLES')
  } finally {
    repo.cleanup()
    cleanupDir(plain)
  }
})

repoTest('端到端：会话记录读不到时报 ESESSIONS', () => {
  const repo = makeRepo()
  try {
    repo.commit('feat: x')
    assert.throws(
      () => buildReport({ repo: repo.dir, sessionsPath: join(repo.dir, '不存在.jsonl') }),
      (error) => error.code === 'ESESSIONS',
    )
  } finally {
    repo.cleanup()
  }
})

test('非仓库目录报 ENOTREPO，普通目录也报 ENOTREPO', () => {
  const plain = makePlainDir()
  try {
    assert.throws(() => buildReport({ repo: plain }), (error) => {
      assert.ok(error instanceof ChangelogError)
      assert.equal(error.code, 'ENOTREPO')
      return true
    })
    assert.throws(() => buildReport({ repo: join(plain, '不存在') }), (error) => error.code === 'ENOTREPO')
  } finally {
    cleanupDir(plain)
  }
})

repoTest('roots 白名单：不在里面的仓库被拒，在里面的放行', () => {
  const repo = makeRepo()
  const plain = makePlainDir()
  try {
    repo.commit('feat: x')
    assert.throws(() => buildReport({ repo: repo.dir, roots: [plain] }), (error) => error.code === 'EOUTSIDE')
    const ok = buildReport({ repo: repo.dir, roots: [repo.dir] })
    assert.equal(ok.meta.commitCount, 1)
    // 大小写差异不该让白名单失效（Windows 路径大小写不敏感）。
    const upper = buildReport({ repo: repo.dir, roots: [repo.dir.toUpperCase()] })
    assert.equal(upper.meta.commitCount, 1)
  } finally {
    repo.cleanup()
    cleanupDir(plain)
  }
})

repoTest('范围校验：以 - 开头或不存在都拒绝，合法范围放行', () => {
  const repo = makeRepo()
  try {
    repo.commit('chore: 初始化')
    repo.commit('feat: 第二个')
    assert.throws(() => buildReport({ repo: repo.dir, range: '--all' }), (error) => error.code === 'EBADREV')
    assert.throws(() => buildReport({ repo: repo.dir, range: '--output=o.txt' }), (error) => error.code === 'EBADREV')
    assert.throws(() => buildReport({ repo: repo.dir, range: 'no-such..HEAD' }), (error) => error.code === 'EBADRANGE')
    const ok = buildReport({ repo: repo.dir, range: 'HEAD~1..HEAD' })
    assert.equal(ok.meta.commitCount, 1)
    assert.equal(ok.meta.range.text, 'HEAD~1..HEAD')
  } finally {
    repo.cleanup()
  }
})

repoTest('报告元信息：版本、来源与统计自洽', () => {
  const repo = makeRepo()
  try {
    seedRepo(repo)
    const report = buildReport({ repo: repo.dir, sessionsText: SESSIONS(repo.head()), now: '2026-10-16T12:00:00Z' })
    const meta = report.meta
    assert.equal(meta.tool, NAME + '@' + VERSION)
    assert.equal(meta.source, 'git log')
    assert.equal(meta.commitCount, report.entries.length)
    assert.equal(meta.unverifiedCount, report.entries.filter((entry) => !entry.evidence.verified).length)
    assert.equal(meta.insertions, report.entries.reduce((sum, entry) => sum + entry.insertions, 0))
    assert.equal(meta.deletions, report.entries.reduce((sum, entry) => sum + entry.deletions, 0))
    assert.equal(meta.fileCount, new Set(report.entries.flatMap((entry) => entry.files.map((file) => file.path))).size)
    assert.equal(meta.generatedAt, new Date('2026-10-16T12:00:00Z').toISOString())
    assert.equal(Object.values(meta.kindCounts).reduce((sum, count) => sum + count, 0), meta.commitCount)
  } finally {
    repo.cleanup()
  }
})

repoTest('同一仓库同一时间生成两次，结果逐字节一致', () => {
  const repo = makeRepo()
  try {
    seedRepo(repo)
    const a = generate({ repo: repo.dir, now: '2026-10-16T12:00:00Z' })
    const b = generate({ repo: repo.dir, now: '2026-10-16T12:00:00Z' })
    assert.equal(a.markdown.user, b.markdown.user)
    assert.equal(a.markdown.dev, b.markdown.dev)
  } finally {
    repo.cleanup()
  }
})

repoTest('会话记录匹配不上时进未匹配清单，并且不改验证结论', () => {
  const repo = makeRepo()
  try {
    repo.commit('feat: 无证据的提交')
    const out = generate({
      repo: repo.dir,
      sessionsText: JSON.stringify([{ commit: 'f'.repeat(7), title: '不在范围内的记录', commands: [{ command: 'node --test', exitCode: 0 }] }]),
      now: '2026-10-16T12:00:00Z',
    })
    assert.equal(out.report.entries[0].evidence.verified, false)
    assert.equal(out.report.meta.sessions.unmatched.length, 1)
    assert.match(out.markdown.dev, /未匹配 1 条/)
  } finally {
    repo.cleanup()
  }
})
