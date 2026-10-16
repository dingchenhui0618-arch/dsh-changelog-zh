// 验证证据判定测试 —— 这个插件最核心的承诺，所以正反两面都要钉死。
//
// 正向：四类证据各自能独立产生「已验证」。
// 反向：没有证据、只有声称、有失败证据、通过与失败并存 —— 一律不许标「已验证」。

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  EVIDENCE_RULES_TEXT,
  isVerificationCommand,
  normalizeTrailerKey,
  parseTrailers,
  resolveEvidence,
  verificationTrailers,
} from '../src/evidence.js'

test('parseTrailers 认出行首「键：值」，忽略正文里的普通句子', () => {
  const trailers = parseTrailers([
    '做了一件复杂的事，说明写在下面。',
    'Verified: node --test → 42 passed',
    '- 测试：手动跑通导出',
    '标题：加一个中文标题',
    '没有冒号的一行',
    '结尾冒号：',
    '**证据**：截图见附件',
  ].join('\n'))
  assert.deepEqual(trailers.map((trailer) => trailer.key), ['Verified', '测试', '标题', '证据'])
  assert.equal(trailers[1].value, '手动跑通导出')
  assert.equal(normalizeTrailerKey('Tested_By'), 'tested-by')
  assert.equal(trailers[0].canonical, 'verified')
  assert.equal(trailers[2].canonical, undefined, '标题不是验证类 trailer')
})

test('verificationTrailers 去重，且只留验证类键名', () => {
  const list = verificationTrailers([
    'Verified: node --test',
    'Verified: node --test',
    '标题：不该出现',
    '测试：全部通过',
  ].join('\n'), 'git notes')
  assert.equal(list.length, 2)
  assert.equal(list[0].source, 'git notes')
  assert.equal(list[1].canonical, 'tested')
})

test('提交信息里的 trailer 就能让一条提交「已验证」，并原样引用', () => {
  const result = resolveEvidence({ body: 'Verified: node --test → 42 passed', notes: '' }, [])
  assert.equal(result.verified, true)
  assert.equal(result.evidence.length, 1)
  assert.equal(result.evidence[0].source, '提交信息')
  assert.equal(result.evidence[0].text, 'Verified: node --test → 42 passed')
})

test('git notes 是独立的证据通道', () => {
  const result = resolveEvidence({ body: '', notes: '已验证：node --test 42 passed' }, [])
  assert.equal(result.verified, true)
  assert.equal(result.evidence[0].source, 'git notes')
  assert.match(result.evidence[0].text, /node --test/)
})

test('什么都没有时标未验证，并说清缺的是哪一类', () => {
  const result = resolveEvidence({ body: '', notes: '' }, [])
  assert.equal(result.verified, false)
  assert.equal(result.reason, '提交信息、git notes、会话记录里都没有验证证据')
})

test('会话记录里退出码为 0 的验证命令算证据，命令与退出码都抄下来', () => {
  const result = resolveEvidence({ body: '', notes: '' }, [
    { commands: [{ command: 'node --test', exitCode: 0 }] },
  ])
  assert.equal(result.verified, true)
  assert.equal(result.recordCount, 1)
  assert.equal(result.evidence[0].source, '会话记录')
  assert.equal(result.evidence[0].exitCode, 0)
  assert.match(result.evidence[0].text, /node --test（退出码 0）/)
})

test('退出码为 0 但不像验证命令的，不算证据', () => {
  const result = resolveEvidence({ body: '', notes: '' }, [
    { commands: [{ command: 'git status', exitCode: 0 }] },
  ])
  assert.equal(result.verified, false)
  assert.match(result.reason, /没有退出码为 0 的验证命令/)

  // 记录里显式标了 verify 才认。
  const explicit = resolveEvidence({ body: '', notes: '' }, [
    { commands: [{ command: '自定义脚本', exitCode: 0, verify: true }] },
  ])
  assert.equal(explicit.verified, true)
})

test('退出码非 0 是反面证据：仍未验证，并写出退出码', () => {
  const result = resolveEvidence({ body: '', notes: '' }, [
    { commands: [{ command: 'node --test', exitCode: 1 }] },
  ])
  assert.equal(result.verified, false)
  assert.equal(result.contradicted.length, 1)
  assert.match(result.reason, /失败的验证证据/)
  assert.match(result.reason, /退出码 1/)
})

test('通过证据与失败证据并存时保守记为未验证', () => {
  const result = resolveEvidence({ body: 'Verified: node --test', notes: '' }, [
    { commands: [{ command: 'node --test', exitCode: 2 }] },
  ])
  assert.equal(result.verified, false)
  assert.equal(result.evidence.length, 1)
  assert.equal(result.contradicted.length, 1)
  assert.match(result.reason, /保守记为未验证/)
})

test('只写 verified:true 却没给证据，一样算未验证', () => {
  const result = resolveEvidence({ body: '', notes: '' }, [{ verified: true }])
  assert.equal(result.verified, false)
  assert.equal(result.claimedWithoutEvidence, true)
  assert.match(result.reason, /声称|标了 verified/)
  assert.match(result.reason, /缺 evidence/)
})

test('测试计数只在 failed=0 且 passed>0 时算证据', () => {
  const ok = resolveEvidence({ body: '', notes: '' }, [{ tests: { passed: 42, failed: 0 } }])
  assert.equal(ok.verified, true)
  assert.match(ok.evidence[0].text, /passed=42 failed=0/)

  const zero = resolveEvidence({ body: '', notes: '' }, [{ tests: { passed: 0, failed: 0 } }])
  assert.equal(zero.verified, false)

  const bad = resolveEvidence({ body: '', notes: '' }, [{ tests: { passed: 3, failed: 2 } }])
  assert.equal(bad.verified, false)
  assert.equal(bad.contradicted.length, 1)
})

test('verification 对象里的 command+exitCode 或 evidence 都能算证据', () => {
  const withCommand = resolveEvidence({ body: '', notes: '' }, [
    { verification: { command: 'npm test', exitCode: 0, evidence: '42 passed' } },
  ])
  assert.equal(withCommand.verified, true)
  assert.match(withCommand.evidence[0].text, /npm test（退出码 0，42 passed）/)

  const withEvidence = resolveEvidence({ body: '', notes: '' }, [
    { verification: { evidence: 'CI 全绿，链接见发布页' } },
  ])
  assert.equal(withEvidence.verified, true)
  assert.equal(withEvidence.evidence[0].kind, 'note')

  const failing = resolveEvidence({ body: '', notes: '' }, [
    { verification: { command: 'npm test', exitCode: 1 } },
  ])
  assert.equal(failing.verified, false)
  assert.equal(failing.contradicted.length, 1)
})

test('isVerificationCommand 的判定范围', () => {
  for (const command of ['node --test', 'npm test', 'pnpm run test', 'pytest -q', 'go test ./...', 'cargo test', 'npm run lint', 'tsc --noEmit', 'npm run build', '跑一遍验证脚本', '测试：手动核对']) {
    assert.equal(isVerificationCommand(command), true, command + ' 应算验证命令')
  }
  for (const command of ['git status', 'ls -la', 'echo hello', 'debug 一下', '']) {
    assert.equal(isVerificationCommand(command), false, command + ' 不该算验证命令')
  }
})

test('同一份证据出现两次只算一条', () => {
  const result = resolveEvidence({ body: 'Verified: node --test\nVerified: node --test', notes: 'Verified: node --test' }, [])
  assert.equal(result.evidence.length, 1)
})

test('判定规则文本把四类证据都写清楚', () => {
  assert.match(EVIDENCE_RULES_TEXT, /提交信息/)
  assert.match(EVIDENCE_RULES_TEXT, /git notes/)
  assert.match(EVIDENCE_RULES_TEXT, /退出码为 0/)
  assert.match(EVIDENCE_RULES_TEXT, /passed>0|failed=0/)
})
