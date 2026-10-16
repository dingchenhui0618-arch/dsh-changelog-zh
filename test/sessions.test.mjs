// 会话记录解析与挂载测试。
//
// 重点是「匹配不上不许静默」：没有 commit 的记录、sha 写错的记录、短 sha 有歧义
// 的记录，都必须出现在未匹配/歧义清单里。

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  describeRecord,
  indexSessionRecords,
  parseSessionRecords,
} from '../src/sessions.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

test('JSON 数组形式的会话记录', () => {
  const text = JSON.stringify([
    { commit: 'abc1234', title: '支持导出', commands: [{ command: 'node --test', exitCode: 0 }] },
    { commit: 'def5678', titleZh: '修掉崩溃', tests: { passed: 3, failed: 0 } },
  ])
  const out = parseSessionRecords(text, 's.json')
  assert.equal(out.records.length, 2)
  assert.equal(out.warnings.length, 0)
  assert.equal(out.records[0].title, '支持导出')
  assert.equal(out.records[0].source, 's.json#1')
  assert.equal(out.records[1].title, '修掉崩溃')
  assert.deepEqual(out.records[0].commands, [{ command: 'node --test', exitCode: 0 }])
})

test('JSONL 形式支持注释与空行，坏行只报警不中断', () => {
  const text = [
    '# 这是注释',
    '',
    '{"commit":"abc1234","title":"第一条"}',
    '{坏掉的 json',
    '{"commit":"def5678","title":"第三条"}',
    '',
  ].join('\n')
  const out = parseSessionRecords(text, 's.jsonl')
  assert.equal(out.records.length, 2)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0], /第 4 行不是合法 JSON/)
})

test('单对象形式也能读（一次只叠一条的情况）', () => {
  const out = parseSessionRecords('{"commit":"abc1234","title":"单条"}', 'one.json')
  assert.equal(out.records.length, 1)
  assert.equal(out.records[0].title, '单条')
})

test('顶层不是对象/数组时报清楚', () => {
  assert.match(parseSessionRecords('[1,2,3]', 's.json').warnings[0], /第 1 项不是对象/)
  assert.match(parseSessionRecords('[', 's.json').warnings[0], /不是合法 JSON/)
  assert.match(parseSessionRecords('   ', 's.json').warnings[0], /空文件/)
})

test('字段归一化：命令可写成字符串，非对象命令被丢弃，未知字段不进入结果', () => {
  const out = parseSessionRecords(JSON.stringify([{
    commit: 'abc1234',
    commands: ['node --test', { command: 'npm run lint', exitCode: 0 }, { exitCode: 1 }, 42],
    tests: { passed: '42', failed: 0 },
    verified: true,
    乱塞的字段: 'x',
  }]), 's.json')
  const record = out.records[0]
  assert.deepEqual(record.commands, [{ command: 'node --test' }, { command: 'npm run lint', exitCode: 0 }])
  assert.deepEqual(record.tests, { failed: 0 }, 'passed 不是数字就不收')
  assert.equal(record.verified, true)
  assert.equal(record['乱塞的字段'], undefined)
})

test('按完整 sha、唯一前缀、短 sha 三种方式挂载', () => {
  const commits = [
    { sha: SHA_A, short: 'aaaaaaa' },
    { sha: SHA_B, short: 'bbbbbbb' },
  ]
  const index = indexSessionRecords([
    { commit: SHA_A, title: '完整 sha' },
    { commit: 'bbbbb', title: '唯一前缀' },
    { commit: 'bbbbbbb', title: '短 sha' },
  ], commits)
  assert.equal(index.bySha.get(SHA_A).length, 1)
  assert.equal(index.bySha.get(SHA_B).length, 2)
  assert.equal(index.unmatched.length, 0)
  assert.equal(index.ambiguous.length, 0)
})

test('短 sha 有歧义时不猜，进歧义清单', () => {
  const commits = [
    { sha: 'aaaa1111' + '0'.repeat(32), short: 'aaaa111' },
    { sha: 'aaaa2222' + '0'.repeat(32), short: 'aaaa222' },
  ]
  const index = indexSessionRecords([{ commit: 'aaaa', title: '不知道是哪条' }], commits)
  assert.equal(index.bySha.size, 0)
  assert.equal(index.ambiguous.length, 1)
  assert.deepEqual(index.ambiguous[0].candidates, ['aaaa111', 'aaaa222'])
})

test('匹配不上的记录给出具体原因', () => {
  const commits = [{ sha: SHA_A, short: 'aaaaaaa' }]
  const index = indexSessionRecords([
    { title: '没有 commit 字段' },
    { commit: 'ffffffff', title: 'sha 对不上' },
  ], commits)
  assert.equal(index.unmatched.length, 2)
  assert.match(index.unmatched[0].reason, /没有 commit 字段/)
  assert.match(index.unmatched[1].reason, /不在本次范围内/)
})

test('describeRecord 用标题或摘要，缺了就说缺了', () => {
  assert.equal(describeRecord({ commit: SHA_A, title: '标题' }), 'aaaaaaa 标题')
  assert.equal(describeRecord({ commit: SHA_A, summary: '摘要' }), 'aaaaaaa 摘要')
  assert.equal(describeRecord({}), '(无标题)')
})

test('空输入不抛异常', () => {
  const index = indexSessionRecords(undefined, undefined)
  assert.equal(index.bySha.size, 0)
  assert.deepEqual(index.unmatched, [])
})
