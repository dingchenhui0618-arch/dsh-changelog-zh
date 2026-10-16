// 编排层：一次调用把「真实 git 历史（可选叠加会话记录）」变成一份报告和两版
// 中文 Markdown。host 半区、CLI 和测试都只调这一个入口。
//
// 数据流向刻意单向：git → 解析 → 分类 → 脱敏 → 验证判定 → 渲染。验证判定读的
// 是**原始**文本（否则脱敏会先把证据改掉），脱敏在渲染前完成。

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { classifyCommit, kindLabel, kindOrder } from './classify.js'
import { normalizeTrailerKey, parseTrailers, resolveEvidence } from './evidence.js'
import { DEFAULT_LIMIT, collectCommits, defaultRange, isGitRepo, listTags, repoInfo, validateRange } from './git.js'
import { mergeHits, redactText } from './redact.js'
import { defaultTitle, renderDev, renderUser } from './render.js'
import { indexSessionRecords, parseSessionRecords } from './sessions.js'

export const NAME = 'dsh-changelog-zh'
export const VERSION = '0.1.0'

// 中文标题的 trailer 键名。与验证 trailer 一样，只认「行首 键：值」的形状。
const TITLE_TRAILER_KEYS = new Set(['title-zh', 'title-cn', 'zh', 'zh-cn', '中文标题', '中文名', '标题'])

export class ChangelogError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'ChangelogError'
    this.code = code
    this.detail = detail
  }
}

function isInside(child, parent) {
  const a = child.toLowerCase()
  const b = parent.toLowerCase()
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

function toIso(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  const parsed = new Date(String(value))
  if (Number.isNaN(parsed.getTime())) throw new ChangelogError('EBADOPTION', '无法解析的 now：' + String(value))
  return parsed.toISOString()
}

function readText(path, code, label) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new ChangelogError(code, '读取' + label + '失败：' + path + ' —— ' + String((error && error.message) || error))
  }
}

function titleFromTrailers(text) {
  for (const trailer of parseTrailers(text)) {
    if (TITLE_TRAILER_KEYS.has(normalizeTrailerKey(trailer.key))) return trailer.value
  }
  return undefined
}

// 提交主题本身就是中文时，它不是「缺中文标题」——只是不需要翻译。
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/

export function hasCjk(text) {
  return CJK.test(String(text === undefined || text === null ? '' : text))
}

/** 会话记录进报告前先脱敏：它同样可能带着本机路径或凭据。 */
function redactRecord(record) {
  const copy = Object.assign({}, record)
  if (typeof copy.title === 'string') copy.title = redactText(copy.title).text
  if (typeof copy.summary === 'string') copy.summary = redactText(copy.summary).text
  return copy
}

function loadTitleMap(settings) {
  const map = new Map()
  const absorb = (value, source) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ChangelogError('ETITLES', '中文标题映射必须是 { "sha": "标题" } 形状的对象（来自 ' + source + '）')
    }
    for (const [key, text] of Object.entries(value)) {
      if (typeof text !== 'string' || text.trim().length === 0) continue
      map.set(String(key).trim().toLowerCase(), text.trim())
    }
  }
  if (typeof settings.titlesPath === 'string' && settings.titlesPath.length > 0) {
    const path = resolve(settings.titlesPath)
    let parsed
    try {
      parsed = JSON.parse(readText(path, 'ETITLES', '中文标题映射'))
    } catch (error) {
      if (error instanceof ChangelogError) throw error
      throw new ChangelogError('ETITLES', '中文标题映射不是合法 JSON：' + path)
    }
    absorb(parsed, path)
  }
  if (settings.titles !== undefined) absorb(settings.titles, 'options.titles')
  return map
}

/**
 * 生成报告。所有外部输入都在这里校验，失败一律抛 ChangelogError（带 code）。
 *
 * @param {object} [options]
 * @param {string} [options.repo]             仓库路径，默认 process.cwd()
 * @param {string} [options.range]            git 范围，如 "v1.0.0..HEAD"
 * @param {string} [options.since]            只取该日期之后的提交
 * @param {number} [options.limit]            最多取多少条提交，默认 300
 * @param {boolean} [options.includeMerges]   是否包含合并提交，默认 false
 * @param {string} [options.sessionsPath]     会话记录文件（JSON / JSONL）
 * @param {string} [options.sessionsText]     会话记录文本（与 sessionsPath 二选一）
 * @param {string} [options.titlesPath]       中文标题映射 JSON
 * @param {object} [options.titles]           中文标题映射对象
 * @param {string[]} [options.roots]          允许的仓库根目录白名单（空 = 不限制）
 * @param {string|number|Date} [options.now]  生成时间（测试用）
 */
export function buildReport(options) {
  const settings = options !== null && typeof options === 'object' ? options : {}

  const repoInput = settings.repo === undefined || settings.repo === null || String(settings.repo).trim().length === 0
    ? process.cwd()
    : String(settings.repo).trim()
  const repo = resolve(repoInput)

  if (Array.isArray(settings.roots) && settings.roots.length > 0) {
    const allowed = settings.roots
      .filter((root) => typeof root === 'string' && root.trim().length > 0)
      .map((root) => resolve(root))
    if (allowed.length > 0 && !allowed.some((root) => isInside(repo, root))) {
      throw new ChangelogError(
        'EOUTSIDE',
        '仓库路径不在允许的根目录内：' + repo + '（允许：' + allowed.join('、') + '）',
      )
    }
  }
  if (!isGitRepo(repo)) {
    throw new ChangelogError('ENOTREPO', '不是一个可读的 git 仓库：' + repo)
  }

  const warnings = []
  const info = repoInfo(repo)
  const tagMap = listTags(repo)

  const limit = Number.isFinite(settings.limit) && settings.limit > 0 ? Math.floor(settings.limit) : DEFAULT_LIMIT
  const since = settings.since === undefined || settings.since === null || String(settings.since).trim().length === 0
    ? undefined
    : String(settings.since).trim()

  let range
  const requestedRange = settings.range === undefined || settings.range === null ? '' : String(settings.range).trim()
  if (requestedRange.length > 0) {
    const text = validateRange(repo, requestedRange)
    const parts = text.split('..')
    range = {
      text: text,
      from: parts[0].length > 0 ? parts[0] : undefined,
      to: parts.length > 1 && parts[1].length > 0 ? parts[1] : 'HEAD',
      basis: '调用方指定的范围',
    }
  } else {
    const auto = defaultRange(repo)
    range = { text: auto.text, from: auto.from, to: auto.to, basis: auto.basis }
  }

  // 空仓库（还没有任何提交）时 `git log HEAD` 会直接失败，所以先看 HEAD 是否
  // 解析得出来：解析不出来就当作 0 条提交，输出一份诚实的空日志。
  let collected = { commits: [], limit: limit, truncated: false }
  if (info.head.length > 0) {
    collected = collectCommits(repo, {
      range: range.text,
      since: since,
      limit: limit,
      includeMerges: settings.includeMerges === true,
      notesRefs: info.notesRefs.length > 0 ? info.notesRefs : undefined,
    })
  } else {
    warnings.push('仓库还没有任何提交（HEAD 解析失败），本次输出为空日志')
  }
  range.limit = collected.limit
  range.truncated = collected.truncated
  if (collected.truncated) warnings.push('提交数达到上限 ' + String(limit) + ' 条，范围内可能还有更多提交')

  // ---- 会话记录 ----------------------------------------------------------
  let sessionsLoaded = false
  let sessionWarnings = []
  let records = []
  if (typeof settings.sessionsText === 'string' && settings.sessionsText.trim().length > 0) {
    sessionsLoaded = true
    const parsed = parseSessionRecords(settings.sessionsText, 'sessionsText')
    records = parsed.records
    sessionWarnings = parsed.warnings
  } else if (typeof settings.sessionsPath === 'string' && settings.sessionsPath.length > 0) {
    sessionsLoaded = true
    const path = resolve(settings.sessionsPath)
    const parsed = parseSessionRecords(readText(path, 'ESESSIONS', '会话记录'), path)
    records = parsed.records
    sessionWarnings = parsed.warnings
  }
  for (const warning of sessionWarnings) warnings.push(warning)

  const sessionIndex = sessionsLoaded
    ? indexSafe(records, collected.commits, warnings)
    : { bySha: new Map() }

  // ---- 标题 --------------------------------------------------------------
  const titleMap = loadTitleMap(settings)

  // ---- 条目 --------------------------------------------------------------
  const entries = []
  const redactionLists = []
  const allFiles = new Set()
  let insertions = 0
  let deletions = 0
  let translated = 0
  let native = 0
  let titlesMissing = 0
  const kindCounts = {}

  for (let index = 0; index < collected.commits.length; index += 1) {
    const commit = collected.commits[index]
    const classification = classifyCommit(commit)
    const matched = sessionIndex.bySha.get(commit.sha.toLowerCase()) || []
    const evidenceRaw = resolveEvidence(commit, matched)

    const titleCandidates = []
    const fromMap = titleMap.get(commit.sha.toLowerCase()) || titleMap.get(commit.short.toLowerCase())
    if (fromMap !== undefined) titleCandidates.push({ text: fromMap, source: '映射' })
    const fromSession = firstRecordTitle(matched)
    if (fromSession !== undefined) titleCandidates.push({ text: fromSession, source: '会话记录' })
    const fromTrailer = titleFromTrailers(commit.body)
    if (fromTrailer !== undefined) titleCandidates.push({ text: fromTrailer, source: 'trailer' })

    const picked = titleCandidates.length > 0 ? titleCandidates[0] : { text: classification.summary, source: 'subject' }
    if (picked.source === 'subject') {
      if (hasCjk(picked.text)) native += 1
      else titlesMissing += 1
    } else {
      translated += 1
    }

    const subjectRedaction = redactText(commit.subject)
    const bodyRedaction = redactText(commit.body)
    const notesRedaction = redactText(commit.notes)
    const titleRedaction = redactText(picked.text)
    const evidenceRedaction = redactText(evidenceRaw.evidence.map((item) => item.text).join('\u0000'))
    redactionLists.push(subjectRedaction.hits, bodyRedaction.hits, notesRedaction.hits, titleRedaction.hits, evidenceRedaction.hits)

    const redactedEvidenceText = evidenceRedaction.text.split('\u0000')
    const evidence = {
      verified: evidenceRaw.verified,
      reason: redactText(evidenceRaw.reason).text,
      contradicted: evidenceRaw.contradicted.map((item, index) => Object.assign({}, item, { text: redactText(item.text).text })),
      recordCount: evidenceRaw.recordCount,
      claimedWithoutEvidence: evidenceRaw.claimedWithoutEvidence,
      evidence: evidenceRaw.evidence.map((item, index) =>
        Object.assign({}, item, { text: redactedEvidenceText[index] === undefined ? redactText(item.text).text : redactedEvidenceText[index] }),
      ),
    }

    for (const file of commit.files) allFiles.add(file.path)
    insertions += commit.insertions
    deletions += commit.deletions
    kindCounts[classification.kind] = (kindCounts[classification.kind] || 0) + 1

    entries.push({
      sha: commit.sha,
      short: commit.short,
      // git log 的原始顺序（新 → 旧）。时间戳只到秒，同秒提交靠它定序，
      // 否则同一次提交里生成的日志会在两个 sha 之间随机翻页。
      order: index,
      author: commit.author,
      email: commit.email,
      authoredAt: commit.authoredAt,
      committedAt: commit.committedAt,
      subject: subjectRedaction.text,
      subjectRaw: commit.subject,
      body: bodyRedaction.text,
      notes: notesRedaction.text,
      kind: classification.kind,
      label: classification.label,
      scope: classification.scope,
      breaking: classification.breaking,
      confidence: classification.confidence,
      basis: classification.basis,
      summary: classification.summary,
      title: titleRedaction.text,
      titleSource: picked.source,
      files: commit.files,
      insertions: commit.insertions,
      deletions: commit.deletions,
      tags: (tagMap.get(commit.sha) || []).slice(),
      evidence: evidence,
    })
  }

  const unverifiedCount = entries.filter((entry) => !entry.evidence.verified).length
  const redactions = { total: 0, hits: [] }
  const merged = mergeHits(redactionLists)
  redactions.hits = merged
  redactions.total = merged.reduce((sum, hit) => sum + hit.count, 0)

  const matchedCommits = entries.filter((entry) => entry.evidence.recordCount > 0).length
  if (sessionsLoaded && records.length > 0 && matchedCommits === 0) {
    warnings.push('叠加了 ' + String(records.length) + ' 条会话记录，但没有一条能对应到本次范围内的提交')
  }

  const meta = {
    tool: NAME + '@' + VERSION,
    source: 'git log',
    generatedAt: toIso(settings.now),
    repo: {
      root: redactText(info.root).text,
      head: info.head,
      headShort: info.headShort,
      branch: info.branch,
      origin: info.origin === undefined ? undefined : redactText(info.origin).text,
      dirty: info.dirty,
    },
    range: range,
    includeMerges: settings.includeMerges === true,
    since: since,
    commitCount: entries.length,
    unverifiedCount: unverifiedCount,
    fileCount: allFiles.size,
    insertions: insertions,
    deletions: deletions,
    kindCounts: kindCounts,
    redactions: redactions,
    titles: { translated: translated, native: native, missing: titlesMissing },
    sessions: {
      loaded: sessionsLoaded,
      records: records.length,
      matched: matchedCommits,
      unmatched: (sessionIndex.unmatched || []).map((item) => ({ record: redactRecord(item.record), reason: item.reason })),
      ambiguous: (sessionIndex.ambiguous || []).map((item) => ({ record: redactRecord(item.record), candidates: item.candidates })),
    },
    warnings: warnings,
  }

  return { meta: meta, entries: entries }
}

function firstRecordTitle(records) {
  for (const record of records) {
    if (typeof record.title === 'string' && record.title.length > 0) return record.title
  }
  return undefined
}

function indexSafe(records, commits, warnings) {
  const index = indexSessionRecords(records, commits)
  for (const item of index.ambiguous) {
    warnings.push('会话记录里有歧义的短 sha：' + String(item.record.commit) + '（候选 ' + item.candidates.join('、') + '）')
  }
  return index
}

/** 报告 + 两版 Markdown，host / CLI / 测试统一走这个。 */
export function generate(options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const report = buildReport(settings)
  return {
    report: report,
    markdown: renderBoth(report, settings),
  }
}

/** 两版 Markdown。 */
export function renderBoth(report, options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  return {
    user: renderUser(report, settings),
    dev: renderDev(report, settings),
  }
}

export { defaultTitle, renderDev, renderUser, kindLabel, kindOrder }
