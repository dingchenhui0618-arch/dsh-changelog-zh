// 渲染层测试。核心断言只有三条：每条都带 sha、每条都带验证标记、两版都不说
// 历史里没有的话。另外钉住「用户版不出现文件路径」这条设计约束。

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { defaultTitle, groupEntries, renderDev, renderUser } from '../src/render.js'
import { entry, makeReport } from './helpers/report.mjs'

function sampleReport() {
  return makeReport([
    entry({
      sha: 'a'.repeat(40), short: 'aaaaaaa', order: 3, committedAt: '2026-10-16T12:00:00+08:00',
      subject: 'feat(api)!: 换掉返回结构', subjectRaw: 'feat(api)!: 换掉返回结构', title: '换掉返回结构',
      kind: 'breaking', label: '破坏性变更', breaking: true, scope: 'api',
      files: [{ path: 'src/api/schema.js', insertions: 40, deletions: 12, binary: false }], insertions: 40, deletions: 12,
    }),
    entry({
      sha: 'b'.repeat(40), short: 'bbbbbbb', order: 2, committedAt: '2026-10-16T11:00:00+08:00',
      subject: 'feat: 支持导出 Markdown', title: '支持导出 Markdown', titleSource: 'trailer',
      files: [{ path: 'src/export.js', insertions: 30, deletions: 2, binary: false }], insertions: 30, deletions: 2,
    }),
    entry({
      sha: 'c'.repeat(40), short: 'ccccccc', order: 1, committedAt: '2026-10-16T10:00:00+08:00',
      subject: 'docs: 补一段说明', title: '补一段说明', kind: 'docs', label: '文档',
      confidence: 'keyword', basis: '关键词「文档」',
      files: [{ path: 'README.md', insertions: 4, deletions: 0, binary: false }], insertions: 4, deletions: 0,
      evidence: {
        verified: false,
        reason: '提交信息、git notes、会话记录里都没有验证证据',
        contradicted: [], recordCount: 0, claimedWithoutEvidence: false, evidence: [],
      },
    }),
  ], { redactions: { total: 2, hits: [{ kind: 'github-token', label: 'GitHub token', count: 2 }] }, titles: { translated: 1, native: 2, missing: 0 } })
}

test('分组：破坏性单独成组排最前，组内按时间从旧到新', () => {
  const groups = groupEntries(sampleReport().entries)
  assert.deepEqual(groups.map((group) => group.key), ['breaking', 'feature', 'docs'])
  const feature = groups.find((group) => group.key === 'feature')
  assert.equal(feature.entries.length, 1)
})

test('同一秒的提交用 git 原始顺序定序，不随 sha 抖动', () => {
  const sameSecond = '2026-10-16T10:00:00+08:00'
  const groups = groupEntries([
    entry({ sha: 'f'.repeat(40), short: 'fffffff', order: 0, committedAt: sameSecond, title: '新的' }),
    entry({ sha: '0'.repeat(40), short: '0000000', order: 1, committedAt: sameSecond, title: '旧的' }),
  ])
  assert.deepEqual(groups[0].entries.map((item) => item.title), ['旧的', '新的'])
})

test('短版：每条都带 sha 与验证标记，且不出现文件路径', () => {
  const report = sampleReport()
  const text = renderUser(report, { title: 'v1.0.0' })
  assert.match(text, /^# v1\.0\.0\n/)
  for (const item of report.entries) {
    assert.ok(text.includes('`' + item.short + '`'), item.short + ' 应出现在短版里')
    assert.match(text, new RegExp('`' + item.short + '`，(已验证|未验证)'), item.short + ' 后面要紧跟验证标记')
  }
  assert.match(text, /共 3 条变更：2 条已验证、1 条未验证/)
  assert.match(text, /## 破坏性变更/)
  assert.match(text, /- ⚠ 换掉返回结构（`aaaaaaa`，已验证）/)
  assert.equal(text.includes('src/'), false, '短版不应出现文件路径')
  assert.equal(text.includes('.js'), false, '短版不应出现文件名')
  assert.equal(text.includes('分类依据'), false, '短版不出现分类依据')
  assert.match(text, /已在生成时隐去 2 处/)
})

test('短版：未验证条目也照常列出来，不当成缺陷藏起来', () => {
  const text = renderUser(sampleReport(), { title: 'v1.0.0' })
  assert.match(text, /补一段说明（`ccccccc`，未验证）/)
  assert.match(text, /「未验证」只表示提交历史里没有可引用的验证证据/)
})

test('短版：判定依据给一句摘要，不铺完整规则', () => {
  const text = renderUser(sampleReport(), {})
  assert.match(text, /判定依据：提交信息或 git notes 里的验证 trailer/)
  assert.match(text, /完整规则见开发者版/)
  assert.equal(text.includes('passed>0 的测试计数'), false)
})

test('长版：逐条给完整 sha、分类依据、文件增减与证据原文', () => {
  const report = sampleReport()
  const text = renderDev(report, { title: 'v1.0.0' })
  assert.match(text, /^# 变更日志（开发者版）· v1\.0\.0\n/)
  for (const item of report.entries) {
    assert.ok(text.includes('`' + item.sha + '`'), item.sha + ' 的完整 sha 应出现')
    assert.ok(text.includes('`' + item.short + '`，' + (item.evidence.verified ? '已验证' : '未验证')), item.short + ' 的标记应出现')
  }
  assert.match(text, new RegExp('- 提交：`' + 'b'.repeat(40) + '`'))
  assert.match(text, /分类依据：提交前缀 feat/)
  assert.match(text, /分类依据：关键词「文档」/)
  assert.match(text, /- 范围：api/)
  assert.match(text, /- 破坏性：是/)
  assert.match(text, /`src\/api\/schema\.js` \+40 −12/)
  assert.match(text, /- 验证：已验证 —— 提交信息 trailer「Verified: node --test → 42 passed」/)
  assert.match(text, /- 验证：未验证 —— 提交信息、git notes、会话记录里都没有验证证据/)
  assert.match(text, /## 未验证条目清单/)
  assert.match(text, /- `ccccccc` 补一段说明 —— 提交信息/)
  assert.match(text, /## 生成说明/)
  assert.match(text, /本工具不翻译提交信息、不推断验证结论、不联网/)
})

test('长版：可以隐去作者与邮箱', () => {
  const withAuthors = renderDev(sampleReport(), {})
  assert.match(withAuthors, /- 作者：测试者 <tester@example.com>/)
  const noEmails = renderDev(sampleReport(), { includeEmails: false })
  assert.match(noEmails, /- 作者：测试者\n/)
  assert.equal(noEmails.includes('tester@example.com'), false)
  const noAuthors = renderDev(sampleReport(), { includeAuthors: false })
  assert.equal(noAuthors.includes('- 作者：'), false)
})

test('长版：正文摘录按上限截断', () => {
  const long = 'x'.repeat(900)
  const report = makeReport([entry({ body: long, notes: '' })])
  const text = renderDev(report, { bodyExcerptChars: 100 })
  assert.match(text, /（正文已截断）/)
  assert.equal(text.includes('x'.repeat(200)), false)
})

test('长版：达到条数上限与工作区脏都要明说', () => {
  const report = sampleReport()
  report.meta.range.truncated = true
  report.meta.repo.dirty = true
  const text = renderDev(report, {})
  assert.match(text, /已达上限，历史可能还有更多提交/)
  assert.match(text, /工作区有未提交改动/)
})

test('空范围：短版明说没有提交，长版照常给出统计', () => {
  const report = makeReport([], { commitCount: 0, unverifiedCount: 0, range: { text: undefined, from: undefined, to: 'HEAD', basis: '没有标签，取最近提交', limit: 300, truncated: false } })
  const user = renderUser(report, {})
  assert.match(user, /本次范围内没有提交/)
  assert.match(user, /共 0 条变更：0 条已验证、0 条未验证/)
  const dev = renderDev(report, {})
  assert.match(dev, /- 统计：0 条提交 · 已验证 0 · 未验证 0/)
  assert.match(dev, /本次 0 条提交全部带有可引用的验证证据/)
})

test('空范围：短版标题回落到范围推导', () => {
  const report = makeReport([])
  assert.equal(defaultTitle(report.meta), 'v1.0.0 之后的变更')
  assert.match(renderUser(report, {}), /^# v1\.0\.0 之后的变更\n/)
  const noRange = makeReport([], { range: { text: undefined, from: undefined, to: 'HEAD', basis: 'x', limit: 300, truncated: false }, commitCount: 0 })
  assert.equal(defaultTitle(noRange.meta), '最近 0 次提交的变更')
})

test('会话记录的未匹配与歧义要在长版里列出来', () => {
  const report = sampleReport()
  report.meta.sessions = {
    loaded: true,
    records: 3,
    matched: 1,
    unmatched: [{ record: { commit: 'ffffffff', title: '对不上的一条' }, reason: '这个提交不在本次范围内（或 sha 写错了）' }],
    ambiguous: [{ record: { commit: 'aaaa', title: '有歧义的一条' }, candidates: ['aaaa111', 'aaaa222'] }],
  }
  const text = renderDev(report, {})
  assert.match(text, /未匹配 1 条 —— fffffff 对不上的一条：这个提交不在本次范围内/)
  assert.match(text, /有歧义 1 条 —— aaaa 有歧义的一条（候选：aaaa111、aaaa222）/)
})

test('渲染是确定性的：同一份报告渲两次逐字节相同', () => {
  const report = sampleReport()
  assert.equal(renderUser(report, { title: 'v1' }), renderUser(report, { title: 'v1' }))
  assert.equal(renderDev(report, { title: 'v1' }), renderDev(report, { title: 'v1' }))
})

test('两版都以单个换行结尾，便于直接贴出去', () => {
  const report = sampleReport()
  for (const text of [renderUser(report, {}), renderDev(report, {})]) {
    assert.ok(text.endsWith('\n'))
    assert.equal(text.endsWith('\n\n'), false)
  }
})

test('无文件改动的提交不会渲染出一个空的文件列表', () => {
  const report = makeReport([entry({ files: [], insertions: 0, deletions: 0 })])
  const text = renderDev(report, {})
  assert.match(text, /- 文件：无（可能是空提交或合并提交）/)
})
