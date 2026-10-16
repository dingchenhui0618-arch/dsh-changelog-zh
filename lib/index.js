// Host half of dsh-changelog-zh.
//
// 两处注册，都**软读**服务（`ctx.get(...)`），不硬 inject：
//
//   1. `/dsh-changelog-zh` HTTP 路由 —— 面板用的生成入口；
//   2. `changelog_zh` 工具 —— agent 可以直接产出两版中文文案。
//
// 为什么软读：核心引擎是纯 node 的（CLI 也能跑）。无头 DSH 没有 webServer 时，
// 工具仍然该能注册；反过来，工具契约变了也不该把面板一起拖死。两处都各自
// try/catch，任何一半失败都不影响另一半，更不影响 core。
//
// 这个插件**不写文件、不联网、不跑用户命令**：只调 git 查询，结果原路返回。

import { resolve } from 'node:path'
import { ChangelogError, NAME, VERSION, generate } from './core.js'

export const name = NAME
export const inject = []

const MAX_BODY = 1024 * 1024
const AUDIT_KEEP = 40
const TOOL_NAME = 'changelog_zh'

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > MAX_BODY) req.destroy()
    })
    req.on('end', function () {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', function () {
      resolve({})
    })
  })
}

function methodFromUrl(url) {
  const path = String(url || '').split('?')[0]
  const rest = path.replace(/^\/dsh-changelog-zh\/?/, '')
  return rest || 'state'
}

function asString(value, max) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  return text.length > max ? text.slice(0, max) : text
}

function asPositiveInt(value, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value === undefined ? '' : value), 10)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), 5000)
}

function errorPayload(error) {
  if (error instanceof ChangelogError) {
    return { status: error.code === 'EOUTSIDE' || error.code === 'ENOTREPO' ? 403 : 400, body: { ok: false, error: { code: error.code, message: error.message } } }
  }
  if (error && error.name === 'GitError') {
    return { status: 400, body: { ok: false, error: { code: error.code || 'EGIT', message: error.message } } }
  }
  return {
    status: 500,
    body: { ok: false, error: { code: 'EINTERNAL', message: String((error && error.message) || error) } },
  }
}

function compactEntries(entries) {
  return entries.map((entry) => ({
    sha: entry.sha,
    short: entry.short,
    kind: entry.kind,
    label: entry.label,
    breaking: entry.breaking,
    title: entry.title,
    titleSource: entry.titleSource,
    subject: entry.subject,
    verified: entry.evidence.verified,
    reason: entry.evidence.reason,
  }))
}

export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const roots = Array.isArray(settings.roots) ? settings.roots.filter((entry) => typeof entry === 'string' && entry.trim().length > 0) : []
  const defaultRepo = asString(settings.defaultRepo, 4096)
  const defaultRange = asString(settings.defaultRange, 512)
  const sessionsPath = asString(settings.sessionsPath, 4096)
  const titlesPath = asString(settings.titlesPath, 4096)
  const maxCommits = asPositiveInt(settings.maxCommits, 300)

  const stats = { generated: 0, failed: 0, redactions: 0, toolCalls: 0 }
  const recent = []
  let last = null

  function note(entry) {
    recent.push(entry)
    if (recent.length > AUDIT_KEEP) recent.splice(0, recent.length - AUDIT_KEEP)
  }

  // 面板与工具共用的一次生成：参数校验、跑 core、更新计数，一处实现。
  function run(request) {
    const input = request !== null && typeof request === 'object' ? request : {}
    const repo = asString(input.repo, 4096) || defaultRepo
    const range = asString(input.range, 512)
    const sessions = asString(input.sessions, 4096) || sessionsPath
    const limit = asPositiveInt(input.limit, maxCommits)
    const format = input.format === 'user' || input.format === 'dev' || input.format === 'both' ? input.format : 'both'
    const started = Date.now()

    try {
      const out = generate({
        repo: repo,
        range: range,
        since: asString(input.since, 64),
        limit: limit,
        includeMerges: input.includeMerges === true,
        sessionsPath: sessions,
        titlesPath: titlesPath,
        roots: roots,
        now: input.now,
      })
      const meta = out.report.meta
      stats.generated += 1
      stats.redactions += meta.redactions.total
      last = {
        at: meta.generatedAt,
        repo: meta.repo.root,
        range: meta.range.text || '(全部历史)',
        commitCount: meta.commitCount,
        unverifiedCount: meta.unverifiedCount,
        redactions: meta.redactions.total,
        ms: Date.now() - started,
      }
      note({ at: started, repo: meta.repo.root, commits: meta.commitCount, verified: meta.commitCount - meta.unverifiedCount, ms: Date.now() - started })
      return {
        ok: true,
        meta: meta,
        entries: compactEntries(out.report.entries),
        markdown: out.markdown,
        format: format,
      }
    } catch (error) {
      stats.failed += 1
      note({ at: started, repo: repo || '(默认)', error: String((error && error.message) || error), ms: Date.now() - started })
      throw error
    }
  }

  // ---- HTTP 面板入口 -----------------------------------------------------
  ctx.effect(function () {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return function () {}

    let disposeRoute
    try {
      disposeRoute = webServer.register({
        kind: 'prefix',
        path: '/dsh-changelog-zh',
        handler: async function (req, res) {
          try {
            const method = methodFromUrl(req.url)
            // state 只认 GET/HEAD：否则一个 DELETE /dsh-changelog-zh/state 会被
            // 当成「读状态」返回 200，那是个说不通的接口。
            if (method === 'state' && (req.method === 'GET' || req.method === 'HEAD')) {
              sendJson(res, 200, {
                ok: true,
                plugin: { name: NAME, version: VERSION },
                config: {
                  roots: roots,
                  defaultRepo: defaultRepo,
                  defaultRange: defaultRange,
                  sessionsPath: sessionsPath,
                  titlesPath: titlesPath,
                  maxCommits: maxCommits,
                  cwd: process.cwd(),
                },
                last: last,
                stats: stats,
                recent: recent.slice(-AUDIT_KEEP).reverse(),
              })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: { code: 'EMETHOD', message: '只支持 GET /state 与 POST /generate、/clear' } })
              return
            }
            const body = await readBody(req)
            if (method === 'generate') {
              try {
                sendJson(res, 200, run(body))
              } catch (error) {
                const payload = errorPayload(error)
                sendJson(res, payload.status, payload.body)
              }
              return
            }
            if (method === 'clear') {
              recent.length = 0
              last = null
              sendJson(res, 200, { ok: true })
              return
            }
            sendJson(res, 404, { ok: false, error: { code: 'EMETHOD', message: '未知方法：' + method } })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: { code: 'EINTERNAL', message: String((error && error.message) || error) } })
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })

  // ---- agent 工具 --------------------------------------------------------
  ctx.effect(function () {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return function () {}

    let disposeTool
    try {
      disposeTool = tools.register({
        name: TOOL_NAME,
        description: [
          '从真实 git 历史（可选叠加会话记录）生成两份中文变更日志：面向用户的短版、面向开发者的长版。',
          '每条都带 commit SHA，并标注「已验证」或「未验证」——「已验证」只在提交信息/git notes 里有验证 trailer、',
          '或会话记录里有退出码 0 的验证命令时成立，本工具不会从改动形状推断通过。',
          '只读，不写文件、不联网。范围默认取最近一个标签到 HEAD。',
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: '仓库路径（绝对路径优先）。省略时用插件配置的默认仓库。' },
            range: { type: 'string', description: 'git 范围，例如 v1.0.0..HEAD。省略时取最近一个标签到 HEAD。' },
            since: { type: 'string', description: '只取该日期之后的提交，例如 2026-10-01。' },
            limit: { type: 'number', description: '最多取多少条提交，默认取插件配置值（300）。' },
            sessions: { type: 'string', description: '会话记录文件路径（一行一条 JSON），用于叠加验证证据与中文标题。' },
            includeMerges: { type: 'boolean', description: '是否包含合并提交，默认不包含。' },
            format: { type: 'string', enum: ['user', 'dev', 'both'], description: '返回哪一版，默认 both。' },
          },
          required: [],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              repo: { type: 'string' },
              range: { type: 'string' },
              commitCount: { type: 'number' },
              verifiedCount: { type: 'number' },
              unverifiedCount: { type: 'number' },
              redactions: { type: 'number' },
              user: { type: 'string' },
              dev: { type: 'string' },
            },
          },
          render: function (args, value) {
            const result = value !== null && typeof value === 'object' ? value : {}
            const format = result.format === 'user' || result.format === 'dev' ? result.format : (args && args.format) || 'both'
            const head = '范围：' + String(result.range || '') + ' · ' + String(result.commitCount || 0) + ' 条提交 · 已验证 ' +
              String(result.verifiedCount || 0) + ' · 未验证 ' + String(result.unverifiedCount || 0) +
              (result.redactions ? ' · 已隐去 ' + String(result.redactions) + ' 处' : '')
            const parts = []
            if (format !== 'dev') parts.push(result.user || '')
            if (format !== 'user') parts.push(result.dev || '')
            return [{ type: 'text', text: head + '\n\n' + parts.filter((part) => part.length > 0).join('\n\n---\n\n') }]
          },
        },
        timeoutMs: 60000,
        isConcurrencySafe: function () { return true },
        execute: async function (args) {
          stats.toolCalls += 1
          const out = run(args)
          const meta = out.meta
          return {
            repo: meta.repo.origin || meta.repo.root,
            range: meta.range.text || '(全部历史)',
            commitCount: meta.commitCount,
            verifiedCount: meta.commitCount - meta.unverifiedCount,
            unverifiedCount: meta.unverifiedCount,
            redactions: meta.redactions.total,
            format: out.format,
            user: out.markdown.user,
            dev: out.markdown.dev,
          }
        },
      })
    } catch (error) {
      disposeTool = undefined
    }
    return function () {
      if (typeof disposeTool === 'function') disposeTool()
    }
  })
}

export { NAME, VERSION, resolve as resolveRepoPath }
