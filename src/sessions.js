// 会话记录（可选叠加的一层）。
//
// 诚实起见，这里**不解析 DSH 的内部会话库格式** —— 那是会变的私有结构，依赖它
// 等于把「验证证据」建在一个随时会碎的契约上。本插件只吃一种自己定义、写在
// README 里的显式格式：一条记录一行 JSON（或一个 JSON 数组）。
//
//   {"commit":"a1b2c3d","at":"2026-10-16T09:30:00Z","title":"支持导出",
//    "commands":[{"command":"node --test","exitCode":0}],
//    "tests":{"passed":42,"failed":0},
//    "verification":{"command":"node --test","exitCode":0,"evidence":"42 passed"}}
//
// 字段全部可选，但**没有证据字段就不会产生「已验证」**：匹配不上的记录会进
// 报告里的未匹配清单，不会静默消失。

export const SESSION_FIELDS = [
  'commit',
  'at',
  'title',
  'titleZh',
  'summary',
  'commands',
  'tests',
  'verification',
  'verified',
  'source',
]

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeCommand(entry) {
  if (typeof entry === 'string') return { command: entry }
  if (!isPlainObject(entry)) return undefined
  const command = typeof entry.command === 'string' ? entry.command : undefined
  if (command === undefined) return undefined
  const normalized = { command: command }
  if (typeof entry.exitCode === 'number' && Number.isFinite(entry.exitCode)) normalized.exitCode = entry.exitCode
  if (entry.verify === true) normalized.verify = true
  if (typeof entry.at === 'string') normalized.at = entry.at
  return normalized
}

function normalizeRecord(raw, source) {
  const record = { source: source, commands: [] }
  if (typeof raw.commit === 'string' && raw.commit.trim().length > 0) record.commit = raw.commit.trim()
  if (typeof raw.at === 'string') record.at = raw.at
  const title = typeof raw.titleZh === 'string' ? raw.titleZh : typeof raw.title === 'string' ? raw.title : undefined
  if (title !== undefined && title.trim().length > 0) record.title = title.trim()
  if (typeof raw.summary === 'string' && raw.summary.trim().length > 0) record.summary = raw.summary.trim()
  if (Array.isArray(raw.commands)) {
    for (const entry of raw.commands) {
      const command = normalizeCommand(entry)
      if (command !== undefined) record.commands.push(command)
    }
  }
  if (isPlainObject(raw.tests)) {
    const tests = {}
    if (typeof raw.tests.passed === 'number') tests.passed = raw.tests.passed
    if (typeof raw.tests.failed === 'number') tests.failed = raw.tests.failed
    if (Object.keys(tests).length > 0) record.tests = tests
  }
  if (isPlainObject(raw.verification)) {
    const verification = {}
    if (typeof raw.verification.command === 'string') verification.command = raw.verification.command
    if (typeof raw.verification.exitCode === 'number') verification.exitCode = raw.verification.exitCode
    if (typeof raw.verification.evidence === 'string' && raw.verification.evidence.trim().length > 0) {
      verification.evidence = raw.verification.evidence.trim()
    }
    if (Object.keys(verification).length > 0) record.verification = verification
  }
  if (raw.verified === true) record.verified = true
  if (raw.verified === false) record.verified = false
  return record
}

/**
 * 解析会话记录文本：JSON 数组、单个 JSON 对象，或一行一条的 JSONL（`#` 起头是注释）。
 * 解析不了的行走 warnings，不抛异常 —— 一条坏记录不该毁掉整份日志。
 * @returns {{records: Array<object>, warnings: Array<string>}}
 */
export function parseSessionRecords(text, source) {
  const label = source || '会话记录'
  const body = String(text === undefined || text === null ? '' : text)
  const records = []
  const warnings = []
  const trimmed = body.trim()
  if (trimmed.length === 0) return { records: records, warnings: [label + '是空文件，没有叠加任何记录'] }

  if (trimmed.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      return { records: records, warnings: [label + '不是合法 JSON：' + String((error && error.message) || error)] }
    }
    if (!Array.isArray(parsed)) return { records: records, warnings: [label + '顶层不是数组'] }
    parsed.forEach((item, index) => {
      if (!isPlainObject(item)) {
        warnings.push(label + ' 第 ' + String(index + 1) + ' 项不是对象，已跳过')
        return
      }
      records.push(normalizeRecord(item, label + '#' + String(index + 1)))
    })
    return { records: records, warnings: warnings }
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (isPlainObject(parsed)) {
        records.push(normalizeRecord(parsed, label))
        return { records: records, warnings: warnings }
      }
    } catch (error) {
      // 落到 JSONL 分支再试一次：一个多行 JSON 对象本来就该用 JSONL 表达。
    }
  }

  const lines = body.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.length === 0 || line.startsWith('#')) continue
    try {
      const parsed = JSON.parse(line)
      if (!isPlainObject(parsed)) {
        warnings.push(label + ' 第 ' + String(index + 1) + ' 行不是对象，已跳过')
        continue
      }
      records.push(normalizeRecord(parsed, label + ':' + String(index + 1)))
    } catch (error) {
      warnings.push(label + ' 第 ' + String(index + 1) + ' 行不是合法 JSON，已跳过')
    }
  }
  return { records: records, warnings: warnings }
}

/** 记录的一句话描述，用于未匹配/歧义清单。 */
export function describeRecord(record) {
  const head = record.title || record.summary || '(无标题)'
  return (record.commit ? record.commit.slice(0, 7) + ' ' : '') + head
}

/**
 * 把会话记录挂到提交上。只按 sha 匹配：完整 sha 精确命中优先，其次是唯一前缀，
 * 再次是提交的短 sha 相等。前缀有歧义时**不猜**，进 ambiguous 清单。
 * @returns {{bySha: Map<string, Array<object>>, unmatched: Array<{record: object, reason: string}>, ambiguous: Array<{record: object, candidates: string[]}>}}
 */
export function indexSessionRecords(records, commits) {
  const bySha = new Map()
  const unmatched = []
  const ambiguous = []
  const list = Array.isArray(records) ? records : []
  const known = Array.isArray(commits) ? commits : []
  const fullShas = known.map((commit) => commit.sha.toLowerCase())
  const fullSet = new Set(fullShas)
  const shortMap = new Map()
  for (const commit of known) {
    const keys = shortMap.get(commit.short.toLowerCase()) || []
    keys.push(commit.sha)
    shortMap.set(commit.short.toLowerCase(), keys)
  }

  for (const record of list) {
    if (typeof record.commit !== 'string' || record.commit.length === 0) {
      unmatched.push({ record: record, reason: '记录里没有 commit 字段，无法对应到任何提交' })
      continue
    }
    const key = record.commit.toLowerCase()
    if (fullSet.has(key)) {
      const bucket = bySha.get(key) || []
      bucket.push(record)
      bySha.set(key, bucket)
      continue
    }
    const prefixHits = key.length >= 4 ? fullShas.filter((sha) => sha.startsWith(key)) : []
    if (prefixHits.length === 1) {
      const bucket = bySha.get(prefixHits[0]) || []
      bucket.push(record)
      bySha.set(prefixHits[0], bucket)
      continue
    }
    if (prefixHits.length > 1) {
      ambiguous.push({ record: record, candidates: prefixHits.map((sha) => sha.slice(0, 7)) })
      continue
    }
    const shortHits = shortMap.get(key) || []
    if (shortHits.length === 1) {
      const bucket = bySha.get(shortHits[0].toLowerCase()) || []
      bucket.push(record)
      bySha.set(shortHits[0].toLowerCase(), bucket)
      continue
    }
    if (shortHits.length > 1) {
      ambiguous.push({ record: record, candidates: shortHits.map((sha) => sha.slice(0, 7)) })
      continue
    }
    unmatched.push({ record: record, reason: '这个提交不在本次范围内（或 sha 写错了）' })
  }

  return { bySha: bySha, unmatched: unmatched, ambiguous: ambiguous }
}
