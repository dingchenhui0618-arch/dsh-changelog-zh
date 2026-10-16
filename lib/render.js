// 渲染层：把报告变成两份可以**直接贴出去**的中文 Markdown。
//
// 短版（面向用户）只说「发生了什么、能不能用」，不出现文件路径和分类依据；
// 长版（面向开发者）逐条给出 sha、分类依据、文件增减、验证证据原文。
//
// 两版共同的三条硬规则：
//   1. 每条都带 commit SHA 和「已验证 / 未验证」标记，一个都不省；
//   2. 判定依据写在文末，读者能自己复核；
//   3. 没有证据的话一句都不多说 —— 不写「性能提升显著」这类历史里没有的话。

import { KIND_ORDER, describeClassification, kindOrder } from './classify.js'
import { EVIDENCE_RULES_TEXT } from './evidence.js'
import { mergeHits } from './redact.js'

export const MARK_VERIFIED = '已验证'
export const MARK_UNVERIFIED = '未验证'

function marker(entry) {
  return entry.evidence.verified ? MARK_VERIFIED : MARK_UNVERIFIED
}

function dateTime(iso) {
  const text = String(iso || '')
  if (text.length === 0) return '(未知时间)'
  return text.slice(0, 16).replace('T', ' ')
}

function dateOnly(iso) {
  const text = String(iso || '')
  return text.length >= 10 ? text.slice(0, 10) : '(未知日期)'
}

export function defaultTitle(meta) {
  if (meta.range && meta.range.from) return meta.range.from + ' 之后的变更'
  return '最近 ' + String(meta.commitCount) + ' 次提交的变更'
}

/** 分组：破坏性变更单独成组，其余按分类顺序。 */
export function groupEntries(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = entry.breaking ? 'breaking' : entry.kind
    const bucket = groups.get(key) || []
    bucket.push(entry)
    groups.set(key, bucket)
  }
  const keys = Array.from(groups.keys()).sort((a, b) => kindOrder(a) - kindOrder(b))
  return keys.map((key) => ({
    key: key,
    label: groups.get(key)[0].label,
    entries: groups.get(key).slice().sort((a, b) => {
      if (a.committedAt !== b.committedAt) return a.committedAt < b.committedAt ? -1 : 1
      // 同一秒的提交用 git log 的原始次序兜底：order 越小越新，升序排列时要排后面。
      return (b.order || 0) - (a.order || 0)
    }),
  }))
}

function footerLines(report, options, detail) {
  const meta = report.meta
  const lines = []
  lines.push('> 范围：' + (meta.range.text || '(全部历史，取最近 ' + String(meta.commitCount) + ' 条)') +
    ' · 共 ' + String(meta.commitCount) + ' 条变更')
  lines.push('> 「未验证」只表示提交历史里没有可引用的验证证据，不代表这条改动有问题。')
  if (detail) {
    lines.push('> 判定依据：' + EVIDENCE_RULES_TEXT)
  } else {
    lines.push('> 判定依据：提交信息或 git notes 里的验证 trailer（`已验证:` / `Verified:` / `测试:` …），' +
      '或会话记录里退出码为 0 的验证命令。完整规则见开发者版。')
  }
  if (meta.redactions.total > 0) {
    lines.push('> 已在生成时隐去 ' + String(meta.redactions.total) + ' 处疑似凭据或本机用户路径（' +
      meta.redactions.hits.map((hit) => hit.label + '×' + String(hit.count)).join('、') + '）。')
  }
  if (meta.titles.missing > 0) {
    lines.push('> 其中 ' + String(meta.titles.missing) + ' 条没有中文标题，原样保留了提交主题（本工具不翻译提交信息）。')
  }
  lines.push('> 生成于 ' + meta.generatedAt + ' · ' + meta.tool + ' · 数据来源：' + meta.source)
  return lines
}

/**
 * 短版：面向用户。每条 = 一句话 + 短 sha + 验证标记。
 * @param {object} report
 * @param {{title?: string}} [options]
 */
export function renderUser(report, options) {
  const settings = options || {}
  const meta = report.meta
  const title = settings.title && String(settings.title).length > 0 ? String(settings.title) : defaultTitle(meta)
  const lines = []

  lines.push('# ' + title)
  lines.push('')
  const verified = meta.commitCount - meta.unverifiedCount
  lines.push(dateOnly(meta.generatedAt) + ' · 共 ' + String(meta.commitCount) + ' 条变更：' +
    String(verified) + ' 条已验证、' + String(meta.unverifiedCount) + ' 条未验证。')
  lines.push('')

  if (meta.commitCount === 0) {
    lines.push('本次范围内没有提交。')
    lines.push('')
    lines.push(...footerLines(report, settings))
    return lines.join('\n').replace(/\n+$/, '') + '\n'
  }

  for (const group of groupEntries(report.entries)) {
    lines.push('## ' + group.label)
    lines.push('')
    for (const entry of group.entries) {
      const prefix = entry.breaking ? '⚠ ' : ''
      lines.push('- ' + prefix + entry.title + '（`' + entry.short + '`，' + marker(entry) + '）')
    }
    lines.push('')
  }

  lines.push(...footerLines(report, settings))
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

function evidenceLine(item) {
  const source = item.source === '提交信息' ? '提交信息 trailer' : item.source === 'git notes' ? 'git notes' : '会话记录'
  return source + '「' + item.text + '」'
}

function fileLines(entry) {
  if (entry.files.length === 0) return ['- 文件：无（可能是空提交或合并提交）']
  const shown = entry.files.slice(0, 12)
  const head = '- 文件（' + String(entry.files.length) + ' 个，+' + String(entry.insertions) + ' −' + String(entry.deletions) + '）：'
  const list = shown.map((file) =>
    '`' + file.path + '` ' + (file.binary ? '(二进制)' : '+' + String(file.insertions) + ' −' + String(file.deletions)),
  )
  const suffix = entry.files.length > shown.length ? ['（只列前 ' + String(shown.length) + ' 个）'] : []
  return [head, ...list.map((item) => '  - ' + item), ...suffix]
}

/**
 * 长版：面向开发者。逐条给 sha、分类依据、文件增减、验证证据原文。
 * @param {object} report
 * @param {{title?: string, includeAuthors?: boolean, bodyExcerptChars?: number}} [options]
 */
export function renderDev(report, options) {
  const settings = options || {}
  const meta = report.meta
  const includeAuthors = settings.includeAuthors !== false
  const excerptChars = Number.isFinite(settings.bodyExcerptChars) ? settings.bodyExcerptChars : 600
  const title = settings.title && String(settings.title).length > 0 ? String(settings.title) : defaultTitle(meta)
  const lines = []

  lines.push('# 变更日志（开发者版）· ' + title)
  lines.push('')
  lines.push('- 仓库：' + (meta.repo.origin || meta.repo.root))
  lines.push('- 范围：' + (meta.range.text || '(全部历史)') + '（' + meta.range.basis + '；上限 ' + String(meta.range.limit) + ' 条' +
    (meta.range.truncated ? '，**已达上限，历史可能还有更多提交**' : '') + '）')
  lines.push('- HEAD：`' + meta.repo.head + '`（`' + meta.repo.headShort + '`）· 分支：' + (meta.repo.branch || '(未知)') +
    (meta.repo.dirty ? ' · **工作区有未提交改动**' : ''))
  lines.push('- 生成时间：' + meta.generatedAt + ' · 工具：' + meta.tool)
  lines.push('- 统计：' + String(meta.commitCount) + ' 条提交 · 已验证 ' + String(meta.commitCount - meta.unverifiedCount) +
    ' · 未验证 ' + String(meta.unverifiedCount) + ' · 涉及文件 ' + String(meta.fileCount) +
    ' · 增删 +' + String(meta.insertions) + ' −' + String(meta.deletions))
  lines.push('')

  if (meta.warnings.length > 0) {
    lines.push('## 生成时的提示')
    lines.push('')
    for (const warning of meta.warnings) lines.push('- ' + warning)
    lines.push('')
  }

  let index = 0
  for (const group of groupEntries(report.entries)) {
    lines.push('## ' + group.label)
    lines.push('')
    for (const entry of group.entries) {
      index += 1
      lines.push('### ' + String(index) + '. ' + entry.title + '（`' + entry.short + '`，' + marker(entry) + '）')
      lines.push('')
      lines.push('- 提交：`' + entry.sha + '`')
      lines.push('- 类型：' + entry.label + '（分类依据：' + describeClassification(entry) + '）')
      if (entry.scope) lines.push('- 范围：' + entry.scope)
      lines.push('- 破坏性：' + (entry.breaking ? '是' : '否'))
      if (includeAuthors) {
        const email = settings.includeEmails === false ? '' : (entry.email ? ' <' + entry.email + '>' : '')
        lines.push('- 作者：' + entry.author + email)
      }
      lines.push('- 提交时间：' + dateTime(entry.committedAt))
      if (entry.tags.length > 0) lines.push('- 所在标签：' + entry.tags.join('、'))
      lines.push(...fileLines(entry))
      if (entry.titleSource !== 'subject') {
        lines.push('- 提交主题（原文）：' + entry.subject)
      }
      if (entry.evidence.verified) {
        for (const item of entry.evidence.evidence) lines.push('- 验证：已验证 —— ' + evidenceLine(item))
      } else {
        lines.push('- 验证：未验证 —— ' + entry.evidence.reason)
        for (const item of entry.evidence.contradicted) lines.push('- 反面证据：' + evidenceLine(item))
      }
      if (entry.body.length > 0) {
        const excerpt = entry.body.length > excerptChars ? entry.body.slice(0, excerptChars) + '\n…（正文已截断）' : entry.body
        lines.push('- 正文摘录：')
        lines.push('')
        lines.push('  ```text')
        for (const line of excerpt.split('\n')) lines.push('  ' + line)
        lines.push('  ```')
      }
      lines.push('')
    }
  }

  lines.push('## 未验证条目清单')
  lines.push('')
  const unverified = report.entries.filter((entry) => !entry.evidence.verified)
  if (unverified.length === 0) {
    lines.push('本次 ' + String(meta.commitCount) + ' 条提交全部带有可引用的验证证据。')
  } else {
    for (const entry of unverified) {
      lines.push('- `' + entry.short + '` ' + entry.title + ' —— ' + entry.evidence.reason)
    }
  }
  lines.push('')

  lines.push('## 生成说明')
  lines.push('')
  lines.push('- 数据来源：`git log`，' + (meta.includeMerges ? '包含' : '不含') + '合并提交；' +
    (meta.since ? '自 ' + meta.since + ' 起；' : '') + '脱敏在渲染前完成。')
  lines.push('- 分类规则：先认约定式提交前缀，其次关键词表，都识别不出归入「未分类」；逐条依据写在上面，不做猜测式归类。')
  lines.push('- 验证判定：' + EVIDENCE_RULES_TEXT)
  lines.push('- 脱敏：' + (meta.redactions.total > 0
    ? '命中 ' + String(meta.redactions.total) + ' 处（' + meta.redactions.hits.map((hit) => hit.label + '×' + String(hit.count)).join('、') + '），已替换为 `<已隐去:类型>`'
    : '未命中任何凭据或本机用户路径模式'))
  lines.push('- 会话记录：' + (meta.sessions.loaded
    ? '叠加 ' + String(meta.sessions.records) + ' 条，匹配 ' + String(meta.sessions.matched) + ' 条' +
      (meta.sessions.unmatched.length > 0 ? '，未匹配 ' + String(meta.sessions.unmatched.length) + ' 条 —— ' +
        meta.sessions.unmatched.map((item) => describeUnmatched(item)).join('；') : '') +
      (meta.sessions.ambiguous.length > 0 ? '，有歧义 ' + String(meta.sessions.ambiguous.length) + ' 条 —— ' +
        meta.sessions.ambiguous.map((item) => describeUnmatched(item, item.candidates)).join('；') : '')
    : '未提供会话记录文件'))
  lines.push('- 中文标题：' + String(meta.titles.translated) + ' 条来自会话记录 / trailer / 标题映射，' +
    String(meta.titles.native || 0) + ' 条提交主题本身就是中文，' +
    String(meta.titles.missing) + ' 条原样保留了提交主题。')
  lines.push('- 本工具不翻译提交信息、不推断验证结论、不联网。')
  lines.push('')
  lines.push(...footerLines(report, settings, true))
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

function describeUnmatched(item, candidates) {
  const record = item.record || {}
  const head = (typeof record.commit === 'string' ? record.commit.slice(0, 7) + ' ' : '') + (record.title || record.summary || '(无标题)')
  if (candidates !== undefined) return head + '（候选：' + candidates.join('、') + '）'
  return head + '：' + item.reason
}

/** 便于调用方一次拿到两版。 */
export function renderPair(report, options) {
  const settings = options || {}
  return {
    user: renderUser(report, settings),
    dev: renderDev(report, settings),
  }
}

export { mergeHits, KIND_ORDER }
