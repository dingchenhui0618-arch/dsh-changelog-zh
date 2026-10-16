// 测试基建：真造一个 git 仓库，不 mock git。
//
// 这一层的取舍是刻意的：解析器可以喂字符串，但「范围怎么取、notes 读不读得到、
// numstat 挂不挂得上提交」这些只能靠真 git 回答。所以关键路径一律造真仓库。

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { gitAvailable } from '../../src/git.js'

export const hasGit = gitAvailable()
export const skipReason = hasGit ? false : '本机没有可用的 git，跳过需要真实仓库的用例'

/** 需要 git 的用例用这个，缺 git 时自动 skip 而不是红。 */
export function repoTest(name, fn) {
  return test(name, { skip: skipReason }, fn)
}

export function makeRepo(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cz-test-'))
  let counter = 0

  const run = (args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  run(['init', '-q', '-b', options.branch || 'main'])
  run(['config', 'user.name', options.author || '测试者'])
  run(['config', 'user.email', options.email || 'tester@example.com'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['config', 'core.autocrlf', 'false'])
  run(['config', 'core.safecrlf', 'false'])

  const api = {
    dir: dir,
    run: run,
    write(name, content) {
      const target = join(dir, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return target
    },
    commit(message, opts = {}) {
      counter += 1
      if (opts.empty !== true) {
        api.write(opts.file || 'f' + String(counter) + '.txt', opts.content || ('内容 ' + message + '\n'))
        run(['add', '-A'])
      }
      const args = ['commit', '-q', '-m', message]
      if (opts.body !== undefined) args.push('-m', opts.body)
      if (opts.empty === true) args.push('--allow-empty')
      run(args)
      return run(['rev-parse', 'HEAD']).trim()
    },
    tag(name, sha, annotated) {
      const args = annotated === true ? ['tag', '-a', name, '-m', name] : ['tag', name]
      if (sha !== undefined) args.push(sha)
      run(args)
      return run(['rev-parse', name + '^{commit}']).trim()
    },
    note(sha, text) {
      run(['notes', 'add', '-f', '-m', text, sha])
    },
    branch(name) {
      run(['checkout', '-q', '-b', name])
    },
    checkout(name) {
      run(['checkout', '-q', name])
    },
    merge(name, message) {
      run(['merge', '-q', '--no-ff', '-m', message || ('merge ' + name), name])
      return run(['rev-parse', 'HEAD']).trim()
    },
    head() {
      return run(['rev-parse', 'HEAD']).trim()
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return api
}

/** 一个不是仓库的普通目录。 */
export function makePlainDir() {
  return mkdtempSync(join(tmpdir(), 'cz-plain-'))
}

export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** 伪造一个 res，route handler 的返回体就落在这里。 */
export function makeRes() {
  const captured = { status: 0, body: '', headers: {} }
  return {
    captured: captured,
    // statusCode 必须真的走一遍 res.statusCode，否则测不到 sendJson 设的状态码。
    set statusCode(value) { captured.status = value },
    get statusCode() { return captured.status },
    setHeader(name, value) { captured.headers[name] = value },
    end(text) { captured.body = String(text === undefined ? '' : text) },
    json() { return JSON.parse(captured.body) },
  }
}

/**
 * 伪造一个 req：readBody 会在同一 tick 里挂上监听器，所以数据要等下一 tick 发。
 */
export function makeReq(method, url, body) {
  const listeners = new Map()
  const req = {
    method: method,
    url: url,
    on(event, fn) {
      listeners.set(event, fn)
      return req
    },
  }
  process.nextTick(() => {
    if (body !== undefined && listeners.has('data')) {
      listeners.get('data')(typeof body === 'string' ? body : JSON.stringify(body))
    }
    if (listeners.has('end')) listeners.get('end')()
  })
  return req
}
