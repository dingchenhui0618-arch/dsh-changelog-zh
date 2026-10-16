#!/usr/bin/env node
// dsh-changelog-zh 的命令行入口。
//
// 同一个 core 也跑在 DSH 插件里；CLI 存在的意义是让「生成变更日志」这件事
// 在 CI、发布脚本、甚至别的仓库里都能用，而不只是在 GUI 里点一下。
//
// 优先用 lib/（构建产物，仓库里入库），缺失时退回 src/ —— 这样刚 clone 下来
// 不跑 build 也能用。

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

async function loadCore() {
  try {
    return await import('../lib/core.js')
  } catch (error) {
    return await import('../src/core.js')
  }
}

const USAGE = `dsh-changelog-zh —— 从真实 git 历史生成两份中文变更日志

用法：
  changelog-zh [选项]

选项：
  --repo <目录>       仓库路径（默认当前目录）
  --range <范围>      git 范围，例如 v1.0.0..HEAD（默认取最近一个标签到 HEAD）
  --since <日期>      只取该日期之后的提交
  --limit <条数>      最多取多少条提交（默认 300）
  --merges            包含合并提交（默认排除）
  --sessions <文件>   叠加会话记录（JSON 数组或一行一条 JSON）
  --titles <文件>     中文标题映射，{"sha": "标题"}
  --title <文本>      输出的标题（默认由范围推导，例如「v1.0.0 之后的变更」）
  --format <版本>     user | dev | both（默认 both）
  --out <目录>        写入目录（默认当前目录）
  --stdout            同时打印到标准输出
  --json              不写文件，把完整报告 JSON 打到标准输出
  --no-authors        开发者版里不写作者
  --no-emails         开发者版里不写邮箱（保留作者名）
  -h, --help          显示这份说明
  -v, --version       显示版本

产出（--out 目录下）：
  CHANGELOG-user.md   面向用户的短版
  CHANGELOG-dev.md    面向开发者的长版

每条都带 commit SHA 与「已验证 / 未验证」标记；判定依据写在文案末尾。
本命令只读 git，不联网，不写仓库里的任何文件（只写 --out 指定的目录）。
`

function parseArgs(argv) {
  const options = {
    format: 'both',
    out: process.cwd(),
    stdout: false,
    json: false,
    includeAuthors: true,
    includeEmails: true,
    includeMerges: false,
  }
  const takesValue = new Set([
    'repo', 'range', 'since', 'limit', 'sessions', 'titles', 'title', 'format', 'out',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (raw === '-h' || raw === '--help') return { help: true, options: options }
    if (raw === '-v' || raw === '--version') return { version: true, options: options }
    if (raw === '--stdout') { options.stdout = true; continue }
    if (raw === '--json') { options.json = true; options.stdout = false; continue }
    if (raw === '--merges') { options.includeMerges = true; continue }
    if (raw === '--no-authors') { options.includeAuthors = false; continue }
    if (raw === '--no-emails') { options.includeEmails = false; continue }
    if (!raw.startsWith('--')) return { error: '无法识别的参数：' + raw, options: options }

    const body = raw.slice(2)
    const eq = body.indexOf('=')
    const name = eq >= 0 ? body.slice(0, eq) : body
    if (!takesValue.has(name)) return { error: '无法识别的选项：--' + name, options: options }
    let value = eq >= 0 ? body.slice(eq + 1) : undefined
    if (value === undefined) {
      index += 1
      if (index >= argv.length) return { error: '--' + name + ' 缺少取值', options: options }
      value = argv[index]
    }
    options[name] = value
  }
  if (options.format !== 'user' && options.format !== 'dev' && options.format !== 'both') {
    return { error: '--format 只能是 user / dev / both，收到：' + String(options.format), options: options }
  }
  if (options.limit !== undefined) {
    const limit = Number.parseInt(String(options.limit), 10)
    if (!Number.isFinite(limit) || limit <= 0) return { error: '--limit 必须是正整数，收到：' + String(options.limit), options: options }
    options.limit = limit
  }
  return { options: options }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help === true) {
    process.stdout.write(USAGE)
    return 0
  }
  const { NAME, VERSION, generate } = await loadCore()
  if (parsed.version === true) {
    process.stdout.write(NAME + ' ' + VERSION + '\n')
    return 0
  }
  if (parsed.error !== undefined) {
    process.stderr.write('参数错误：' + parsed.error + '\n\n' + USAGE)
    return 2
  }

  const options = parsed.options
  try {
    const out = generate({
      repo: options.repo,
      range: options.range,
      since: options.since,
      limit: options.limit,
      includeMerges: options.includeMerges,
      sessionsPath: options.sessions,
      titlesPath: options.titles,
      title: options.title,
      includeAuthors: options.includeAuthors,
      includeEmails: options.includeEmails,
    })

    if (options.json === true) {
      process.stdout.write(JSON.stringify(out.report, null, 2) + '\n')
      return 0
    }

    const meta = out.report.meta
    const written = []
    if (options.format !== 'dev') {
      written.push(['CHANGELOG-user.md', '用户版（短）', out.markdown.user])
    }
    if (options.format !== 'user') {
      written.push(['CHANGELOG-dev.md', '开发者版（长）', out.markdown.dev])
    }

    const outDir = resolve(options.out)
    mkdirSync(outDir, { recursive: true })
    for (const [name, label, text] of written) {
      writeFileSync(join(outDir, name), text, 'utf8')
      process.stdout.write('已写入 ' + join(outDir, name) + '  —— ' + label + '\n')
    }

    if (options.stdout === true) {
      for (const [, , text] of written) process.stdout.write('\n' + text)
    }

    const verified = meta.commitCount - meta.unverifiedCount
    process.stdout.write(
      '范围 ' + (meta.range.text || '(全部历史)') +
      ' · ' + String(meta.commitCount) + ' 条提交 · 已验证 ' + String(verified) +
      ' · 未验证 ' + String(meta.unverifiedCount) +
      ' · 已隐去 ' + String(meta.redactions.total) + ' 处' +
      (meta.sessions.loaded ? ' · 会话记录匹配 ' + String(meta.sessions.matched) + ' 条' : '') + '\n',
    )
    if (meta.range.truncated) {
      process.stderr.write('提示：提交数达到上限，范围内可能还有更多提交，可用 --limit 提高。\n')
    }
    return 0
  } catch (error) {
    const code = error && error.code ? '[' + String(error.code) + '] ' : ''
    process.stderr.write('生成失败：' + code + String((error && error.message) || error) + '\n')
    return 1
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    process.stderr.write('未预期的失败：' + String((error && error.stack) || error) + '\n')
    process.exitCode = 1
  },
)
