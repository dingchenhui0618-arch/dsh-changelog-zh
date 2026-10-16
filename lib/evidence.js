// 验证证据判定 —— 这个插件的核心承诺就在这里。
//
// 「已验证」不是一个观感，而是**一条能被读者点开核对的证据**：
//
//   A. 提交信息里的 trailer 形状行（`Verified:` / `已验证：` / `Tested:` / `测试：` /
//      `Evidence:` / `证据：` …），值原样引用；
//   B. git notes 里的同类行（`git notes add -m "已验证：node --test 42 passed"`）；
//   C. 会话记录里退出码为 0 的验证命令（命令与退出码都抄进日志）；
//   D. 会话记录里 `tests.failed === 0 && tests.passed > 0` 的测试计数。
//
// 四者都没有 = 「未验证」，并且写明缺的是哪一类。另有两条例外，都是往严的一侧收：
//
//   * 会话记录只写了 `"verified": true` 却没给可引用的证据 → 仍然算未验证，
//     理由写明「声称已验证但没有证据」；
//   * 同一提交上既有通过证据又有失败证据 → 按未验证处理，两者都列出来。
//
// 绝不从「改了测试文件」「提交信息很详细」「diff 很小」这类形状去推断已通过。

export const EVIDENCE_RULES_TEXT = [
  '「已验证」只在以下四类可引用证据之一存在时成立：提交信息里的验证 trailer、git notes 里的验证 trailer、',
  '会话记录里退出码为 0 的验证命令、或会话记录里 failed=0 且 passed>0 的测试计数。',
  '其余一律标「未验证」，并写明缺哪一类证据；「声称已验证但没有证据」同样记为未验证。',
].join('')

const TRAILER_KEYS = {
  verified: 'verified',
  'verified-by': 'verified',
  'verify': 'verified',
  'verification': 'evidence',
  'verified-on': 'verified',
  tested: 'tested',
  'tested-by': 'tested',
  test: 'tested',
  tests: 'tested',
  evidence: 'evidence',
  check: 'tested',
  checked: 'tested',
  已验证: 'verified',
  验证: 'verified',
  自测: 'verified',
  测试: 'tested',
  测试结果: 'tested',
  测试通过: 'tested',
  证据: 'evidence',
}

const TRAILER_LINE = /^[ \t>*+\-]*([^\s:：]{1,12})\s*[:：]\s*(\S.*)$/

const VERIFY_COMMAND_HINTS = [
  /--test\b/,
  /\btest(s|ed|ing)?\b/i,
  /\b(pytest|vitest|jest|ctest|mocha|ava|tap)\b/i,
  /\b(go|cargo|dotnet|mvn|gradle|swift|flutter)\s+test\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/i,
  /\b(verify|verification|validate|lint|typecheck|tsc|check)\b/i,
  /验证|测试|自测|校验|检查/,
  /\bbuild\b/i,
]

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/** 供其他模块按同一套规则比对 trailer 键名。 */
export function normalizeTrailerKey(key) {
  return normalizeKey(key)
}

/**
 * 从一段文本里抽出 trailer 形状的行。
 * @returns {Array<{key: string, canonical: string|undefined, value: string, raw: string}>}
 */
export function parseTrailers(text) {
  const out = []
  const body = String(text === undefined || text === null ? '' : text)
  if (body.trim().length === 0) return out
  for (const line of body.split('\n')) {
    const match = TRAILER_LINE.exec(line)
    if (match === null) continue
    // 提交信息里常写成 `**已验证**：` 或 `` `Tested` ``，键名两端的 markdown 记号要去掉，
    // 否则 `证据**` 会因为查不到别名而被当成无关行丢掉。
    const key = match[1].replace(/^[*`_#>~\s]+/, '').replace(/[*`_#~\s]+$/, '')
    const value = match[2].trim().replace(/^[*`_]+/, '').replace(/[*`_]+$/, '')
    if (key.length === 0 || value.length === 0) continue
    out.push({ key: key, canonical: TRAILER_KEYS[normalizeKey(key)], value: value, raw: line.trim() })
  }
  return out
}

/** 只保留验证类 trailer，去重后按出现顺序返回。 */
export function verificationTrailers(text, source) {
  const seen = new Set()
  const out = []
  for (const trailer of parseTrailers(text)) {
    if (trailer.canonical === undefined) continue
    const dedupeKey = trailer.canonical + '\u0000' + trailer.value
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({
      source: source || '提交信息',
      kind: 'trailer',
      key: trailer.key,
      canonical: trailer.canonical,
      text: trailer.raw,
    })
  }
  return out
}

/** 这条命令算不算「验证命令」。判断含启发式，所以证据里始终抄上原文与退出码。 */
export function isVerificationCommand(command) {
  const text = String(command === undefined || command === null ? '' : command)
  if (text.trim().length === 0) return false
  return VERIFY_COMMAND_HINTS.some((pattern) => pattern.test(text))
}

function sessionEvidence(record, contradicted) {
  const out = []
  const commands = Array.isArray(record.commands) ? record.commands : []
  for (const entry of commands) {
    if (entry === null || typeof entry !== 'object' || typeof entry.command !== 'string') continue
    const isVerify = entry.verify === true || isVerificationCommand(entry.command)
    if (typeof entry.exitCode === 'number') {
      if (entry.exitCode === 0 && isVerify) {
        out.push({
          source: '会话记录',
          kind: 'command',
          command: entry.command,
          exitCode: 0,
          text: entry.command + '（退出码 0）',
        })
      } else if (entry.exitCode !== 0 && isVerify) {
        contradicted.push({
          source: '会话记录',
          kind: 'command',
          command: entry.command,
          exitCode: entry.exitCode,
          text: entry.command + '（退出码 ' + String(entry.exitCode) + '，非 0）',
        })
      }
    } else if (entry.verify === true) {
      out.push({
        source: '会话记录',
        kind: 'command',
        command: entry.command,
        text: entry.command + '（记录里标为验证命令，但没有退出码）',
      })
    }
  }

  if (record.tests !== undefined && typeof record.tests === 'object' && record.tests !== null) {
    const passed = typeof record.tests.passed === 'number' ? record.tests.passed : undefined
    const failed = typeof record.tests.failed === 'number' ? record.tests.failed : undefined
    if (failed === 0 && passed !== undefined && passed > 0) {
      out.push({
        source: '会话记录',
        kind: 'tests',
        text: '测试计数：passed=' + String(passed) + ' failed=0',
      })
    } else if (failed !== undefined && failed > 0) {
      contradicted.push({
        source: '会话记录',
        kind: 'tests',
        text: '测试计数：passed=' + String(passed === undefined ? '?' : passed) + ' failed=' + String(failed),
      })
    }
  }

  if (record.verification !== undefined && typeof record.verification === 'object' && record.verification !== null) {
    const verification = record.verification
    if (
      typeof verification.command === 'string' &&
      typeof verification.exitCode === 'number'
    ) {
      if (verification.exitCode === 0) {
        out.push({
          source: '会话记录',
          kind: 'command',
          command: verification.command,
          exitCode: 0,
          text: verification.command + '（退出码 0' + (verification.evidence ? '，' + verification.evidence : '') + '）',
        })
      } else {
        contradicted.push({
          source: '会话记录',
          kind: 'command',
          command: verification.command,
          exitCode: verification.exitCode,
          text: verification.command + '（退出码 ' + String(verification.exitCode) + '，非 0）',
        })
      }
    } else if (typeof verification.evidence === 'string' && verification.evidence.length > 0) {
      out.push({ source: '会话记录', kind: 'note', text: verification.evidence })
    }
  }

  return out
}

/**
 * 判定一条提交是否「已验证」。
 * @param {{subject?: string, body?: string, notes?: string}} commit
 * @param {Array<object>} records 已按 sha 匹配到这条提交的会话记录
 */
export function resolveEvidence(commit, records) {
  const list = Array.isArray(records) ? records : []
  const evidence = []
  const contradicted = []
  const seen = new Set()

  const push = (item) => {
    const key = item.kind + '\u0000' + item.text
    if (seen.has(key)) return
    seen.add(key)
    evidence.push(item)
  }

  for (const item of verificationTrailers((commit && commit.body) || '', '提交信息')) push(item)
  for (const item of verificationTrailers((commit && commit.notes) || '', 'git notes')) push(item)

  let claimedWithoutEvidence = false
  for (const record of list) {
    const fromRecord = sessionEvidence(record, contradicted)
    for (const item of fromRecord) push(item)
    if (record.verified === true && fromRecord.length === 0) claimedWithoutEvidence = true
  }

  // 通过证据与失败证据同时存在时按未验证处理：宁可少标一个「已验证」。
  const verified = evidence.length > 0 && contradicted.length === 0

  let reason
  if (verified) {
    reason = '有 ' + String(evidence.length) + ' 条可引用证据'
  } else if (contradicted.length > 0) {
    reason = '会话记录里有失败的验证证据：' + contradicted[0].text
    if (evidence.length > 0) reason += '；同时也有 ' + String(evidence.length) + ' 条通过证据，保守记为未验证'
  } else if (claimedWithoutEvidence) {
    reason = '会话记录标了 verified，但没给出可引用的证据（缺 evidence，或缺 command 与 exitCode）'
  } else if (list.length > 0) {
    reason = '匹配到 ' + String(list.length) + ' 条会话记录，但里面没有退出码为 0 的验证命令，也没有 failed=0 且 passed>0 的测试计数'
  } else {
    reason = '提交信息、git notes、会话记录里都没有验证证据'
  }

  return {
    verified: verified,
    evidence: evidence,
    contradicted: contradicted,
    reason: reason,
    recordCount: list.length,
    claimedWithoutEvidence: claimedWithoutEvidence,
  }
}
