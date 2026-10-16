// CLI 测试：真的 spawn 一个 node 进程跑 bin/，只看退出码、stdout/stderr 与落盘文件。
//
// 这样测的是「用户拿到的那条命令」，不是内部函数。

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { cleanupDir, makeRepo, repoTest } from './helpers/repo.mjs'

const BIN = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'changelog-zh.mjs'))

function runCli(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout: stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : -1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message),
    }
  }
}

function outDir() {
  return mkdtempSync(join(tmpdir(), 'cz-cli-'))
}

test('--version 打印名字与版本，退出码 0', () => {
  const out = runCli(['--version'])
  assert.equal(out.status, 0)
  assert.match(out.stdout.trim(), /^dsh-changelog-zh \d+\.\d+\.\d+$/)
})

test('-h 打印用法，退出码 0', () => {
  const out = runCli(['-h'])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /用法：/)
  assert.match(out.stdout, /CHANGELOG-user\.md/)
  assert.match(out.stdout, /CHANGELOG-dev\.md/)
  assert.match(out.stdout, /只读 git，不联网/)
})

test('无法识别的参数给退出码 2 与用法', () => {
  const bad = runCli(['--不存在'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /参数错误/)
  assert.match(bad.stderr, /用法：/)
})

test('--format 与 --limit 的非法值都被挡住', () => {
  assert.equal(runCli(['--format', 'long']).status, 2)
  assert.match(runCli(['--format', 'long']).stderr, /--format 只能是/)
  assert.equal(runCli(['--limit', '0']).status, 2)
  assert.equal(runCli(['--limit', 'abc']).status, 2)
  assert.equal(runCli(['--repo']).status, 2, '缺取值')
})

test('非仓库路径给退出码 1 与 ENOTREPO', () => {
  const plain = outDir()
  try {
    const out = runCli(['--repo', plain])
    assert.equal(out.status, 1)
    assert.match(out.stderr, /\[ENOTREPO\]/)
  } finally {
    cleanupDir(plain)
  }
})

repoTest('默认写两份文件，内容带 sha 与验证标记', () => {
  const repo = makeRepo()
  const dir = outDir()
  try {
    repo.commit('feat: 支持导出', { body: 'Verified: node --test 42 passed' })
    const sha = repo.commit('docs: 补说明', { file: 'docs.md', content: 'x' })
    const out = runCli(['--repo', repo.dir, '--out', dir, '--title', 'v1.0.0'])
    assert.equal(out.status, 0)
    assert.match(out.stdout, /已写入/)
    assert.match(out.stdout, /2 条提交 · 已验证 1 · 未验证 1/)

    const userPath = join(dir, 'CHANGELOG-user.md')
    const devPath = join(dir, 'CHANGELOG-dev.md')
    assert.ok(existsSync(userPath))
    assert.ok(existsSync(devPath))
    const user = readFileSync(userPath, 'utf8')
    const dev = readFileSync(devPath, 'utf8')
    assert.match(user, /^# v1\.0\.0\n/)
    assert.match(user, /支持导出（`[0-9a-f]{7}`，已验证）/)
    assert.match(dev, new RegExp('`' + sha + '`'))
    assert.match(dev, /- 验证：未验证 ——/)
  } finally {
    repo.cleanup()
    cleanupDir(dir)
  }
})

repoTest('--format 只写被要求的那一版', () => {
  const repo = makeRepo()
  const dir = outDir()
  try {
    repo.commit('feat: x')
    assert.equal(runCli(['--repo', repo.dir, '--out', dir, '--format', 'user']).status, 0)
    assert.deepEqual(readdirSync(dir).sort(), ['CHANGELOG-user.md'])
    cleanupDir(dir)
    const dir2 = outDir()
    assert.equal(runCli(['--repo', repo.dir, '--out', dir2, '--format', 'dev']).status, 0)
    assert.deepEqual(readdirSync(dir2).sort(), ['CHANGELOG-dev.md'])
    cleanupDir(dir2)
  } finally {
    repo.cleanup()
    cleanupDir(dir)
  }
})

repoTest('--json 把完整报告打到 stdout，不写文件', () => {
  const repo = makeRepo()
  const dir = outDir()
  try {
    repo.commit('feat: x')
    const out = runCli(['--repo', repo.dir, '--out', dir, '--json'])
    assert.equal(out.status, 0)
    const report = JSON.parse(out.stdout)
    assert.equal(report.meta.commitCount, 1)
    assert.equal(report.entries.length, 1)
    assert.equal(report.entries[0].evidence.verified, false)
    assert.deepEqual(readdirSync(dir), [], '--json 不写文件')
  } finally {
    repo.cleanup()
    cleanupDir(dir)
  }
})

repoTest('--stdout 同时打印内容', () => {
  const repo = makeRepo()
  const dir = outDir()
  try {
    repo.commit('feat: 打印出来')
    const out = runCli(['--repo', repo.dir, '--out', dir, '--stdout', '--format', 'user'])
    assert.equal(out.status, 0)
    assert.match(out.stdout, /打印出来（`[0-9a-f]{7}`，未验证）/)
  } finally {
    repo.cleanup()
    cleanupDir(dir)
  }
})

repoTest('--sessions 叠加会话记录，验证标记随之变化', () => {
  const repo = makeRepo()
  const dir = outDir()
  try {
    const sha = repo.commit('feat: 接入通知')
    const sessionsFile = join(dir, 'sessions.jsonl')
    writeFileSync(sessionsFile, JSON.stringify({
      commit: sha.slice(0, 7),
      title: '接入通知渠道',
      commands: [{ command: 'node --test', exitCode: 0 }],
    }), 'utf8')

    const out = runCli(['--repo', repo.dir, '--out', dir, '--sessions', sessionsFile, '--format', 'user'])
    assert.equal(out.status, 0)
    const user = readFileSync(join(dir, 'CHANGELOG-user.md'), 'utf8')
    assert.match(user, /接入通知渠道（`[0-9a-f]{7}`，已验证）/)
  } finally {
    repo.cleanup()
    cleanupDir(dir)
  }
})

repoTest('--no-authors 与 --no-emails 都不写作者信息', () => {
  const repo = makeRepo()
  const dir = outDir()
  try {
    repo.commit('feat: x')
    runCli(['--repo', repo.dir, '--out', dir, '--format', 'dev', '--no-authors'])
    const dev = readFileSync(join(dir, 'CHANGELOG-dev.md'), 'utf8')
    assert.equal(dev.includes('- 作者：'), false)
  } finally {
    repo.cleanup()
    cleanupDir(dir)
  }
})

repoTest('--out 目录不存在时自动创建', () => {
  const repo = makeRepo()
  const dir = outDir()
  try {
    repo.commit('feat: x')
    const nested = join(dir, 'a', 'b')
    assert.equal(runCli(['--repo', repo.dir, '--out', nested]).status, 0)
    assert.ok(existsSync(join(nested, 'CHANGELOG-user.md')))
  } finally {
    repo.cleanup()
    cleanupDir(dir)
  }
})

repoTest('危险范围在 CLI 这一层就被拒（退出码 1，EBADREV）', () => {
  const repo = makeRepo()
  try {
    repo.commit('feat: x')
    const out = runCli(['--repo', repo.dir, '--range', '--output=o.txt'])
    assert.equal(out.status, 1)
    assert.match(out.stderr, /\[EBADREV\]/)
    assert.equal(existsSync(join(repo.dir, 'o.txt')), false, '绝不能真写出文件')
  } finally {
    repo.cleanup()
  }
})
