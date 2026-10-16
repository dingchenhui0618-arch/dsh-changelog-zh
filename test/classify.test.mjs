// 分类测试。
//
// 这里最要紧的两件事：约定式前缀必须精确映射；关键词表必须**不能**把
// `debug` 认成 bug、把 `perfect` 认成 perf —— 一次误分类就是一句错的公开文案。

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  KIND_ORDER,
  classifyCommit,
  describeClassification,
  detectBreaking,
  keywordHit,
  kindLabel,
  kindOrder,
  stripPrefix,
} from '../src/classify.js'

test('约定式前缀逐个映射到中文分组', () => {
  const cases = [
    ['feat: 支持导出', 'feature'],
    ['feature: 支持导出', 'feature'],
    ['fix: 修掉崩溃', 'fix'],
    ['bugfix: 修掉崩溃', 'fix'],
    ['hotfix: 修掉崩溃', 'fix'],
    ['perf: 少一次全表扫描', 'perf'],
    ['refactor: 抽出渲染层', 'refactor'],
    ['docs: 补 README', 'docs'],
    ['test: 补边界用例', 'test'],
    ['build: 升级 esbuild', 'build'],
    ['deps: 升级 esbuild', 'build'],
    ['ci: 加一条流水线', 'build'],
    ['chore: 整理目录', 'chore'],
    ['style: 统一格式', 'chore'],
    ['revert: 回滚导出改动', 'revert'],
    ['security: 修掉越权读取', 'security'],
  ]
  for (const [subject, expected] of cases) {
    const result = classifyCommit({ subject: subject })
    assert.equal(result.kind, expected, subject + ' → ' + result.kind)
    assert.equal(result.confidence, 'explicit', subject)
    assert.equal(result.label, kindLabel(expected))
  }
})

test('scope 从括号里取出来，主题去掉前缀', () => {
  const result = classifyCommit({ subject: 'feat(cli): 支持 --json' })
  assert.equal(result.scope, 'cli')
  assert.equal(result.summary, '支持 --json')
  assert.equal(result.kind, 'feature')
})

test('破坏性：主题里的 ! 或正文里的 BREAKING CHANGE 都算', () => {
  assert.equal(detectBreaking('feat!: 换掉配置格式', ''), true)
  assert.equal(detectBreaking('feat(api)!: 换掉返回结构', ''), true)
  assert.equal(detectBreaking('feat: 换掉配置格式', 'BREAKING CHANGE: 旧字段不再读'), true)
  assert.equal(detectBreaking('feat: 换掉配置格式', 'breaking-change: 小写也算'), true)
  assert.equal(detectBreaking('feat: 换掉配置格式', '只是提了一句 breaking 这个词'), false)

  const breaking = classifyCommit({ subject: 'feat!: 换掉配置格式' })
  assert.equal(breaking.kind, 'breaking')
  assert.equal(breaking.breaking, true)
  assert.equal(breaking.label, '破坏性变更')

  const viaBody = classifyCommit({ subject: 'fix: 收敛字段', body: 'BREAKING CHANGE: 删掉了 oldField' })
  assert.equal(viaBody.kind, 'breaking')
  assert.equal(viaBody.confidence, 'explicit')
})

test('没有约定式前缀时按关键词表分类，并标明是启发式', () => {
  const cases = [
    ['新增导出功能', 'feature'],
    ['支持 --json', 'feature'],
    ['修复导出时的编码问题', 'fix'],
    ['解决并发写冲突', 'fix'],
    ['优化启动速度', 'perf'],
    ['重构配置读取', 'refactor'],
    ['补充使用说明', 'docs'],
    ['补齐边界用例', 'test'],
    ['升级依赖', 'build'],
    ['回滚上一版改动', 'revert'],
    ['修掉一个安全漏洞', 'security'],
  ]
  for (const [subject, expected] of cases) {
    const result = classifyCommit({ subject: subject })
    assert.equal(result.kind, expected, subject + ' → ' + result.kind + '（' + result.basis + '）')
    assert.equal(result.confidence, 'keyword', subject)
  }
})

test('关键词按词边界匹配：debug 不是 bug，perfect 不是 perf', () => {
  assert.equal(keywordHit('debug 日志输出', 'bug'), false)
  assert.equal(keywordHit('perfect 的边界', 'perf'), false)
  assert.equal(keywordHit('address 字段', 'add'), false)
  assert.equal(keywordHit('fix the bug', 'bug'), true)
  assert.equal(keywordHit('修掉 bug', 'bug'), true)
  assert.equal(keywordHit('新增导出', '新增'), true, '中文按子串匹配')

  assert.equal(classifyCommit({ subject: 'debug 日志输出' }).kind, 'other')
  assert.equal(classifyCommit({ subject: 'perfect 边界' }).kind, 'other')
})

test('识别不出来就归入未分类，不硬塞分组', () => {
  const result = classifyCommit({ subject: 'v1.2.3' })
  assert.equal(result.kind, 'other')
  assert.equal(result.label, '未分类')
  assert.equal(result.confidence, 'fallback')
  assert.equal(result.summary, 'v1.2.3')
})

test('空主题也能安全分类', () => {
  const result = classifyCommit({})
  assert.equal(result.kind, 'other')
  assert.equal(result.summary, '')
})

test('Merge 提交被单独归类，哪怕分支名里带 feature/fix', () => {
  assert.equal(classifyCommit({ subject: 'Merge pull request #12 from x/y' }).kind, 'merge')
  assert.equal(classifyCommit({ subject: 'Merge branch develop' }).kind, 'merge')
  assert.equal(classifyCommit({ subject: 'Merge branch feature-x' }).kind, 'merge')
  assert.equal(classifyCommit({ subject: 'Merge remote-tracking branch origin/fix-bug' }).kind, 'merge')
  assert.equal(classifyCommit({ subject: '合并 develop 分支' }).kind, 'merge')
  assert.equal(classifyCommit({ subject: 'merge: 合并 release 分支' }).kind, 'merge')
  assert.equal(classifyCommit({ subject: 'merged branch feature/deep' }).kind, 'merge')
})

test('stripPrefix 只去掉合法的前缀', () => {
  assert.equal(stripPrefix('feat(x): 主题'), '主题')
  assert.equal(stripPrefix('feat!: 主题'), '主题')
  assert.equal(stripPrefix('没有前缀的主题'), '没有前缀的主题')
  assert.equal(stripPrefix('feat 没有冒号'), 'feat 没有冒号')
  assert.equal(stripPrefix('  fix:  多个空格  '), '多个空格')
})

test('describeClassification 给出可读依据', () => {
  assert.equal(describeClassification(classifyCommit({ subject: 'feat: x' })), '提交前缀 feat')
  assert.match(describeClassification(classifyCommit({ subject: '新增 x' })), /关键词/)
  assert.equal(describeClassification(classifyCommit({ subject: 'v1.2.3' })), '未识别，归入未分类')
})

test('分类顺序单调，破坏性排最前', () => {
  assert.equal(KIND_ORDER[0], 'breaking')
  for (let index = 1; index < KIND_ORDER.length; index += 1) {
    assert.ok(kindOrder(KIND_ORDER[index - 1]) < kindOrder(KIND_ORDER[index]))
  }
  assert.equal(kindOrder('不存在的类型'), KIND_ORDER.length)
  assert.equal(kindLabel('不存在的类型'), '未分类')
  assert.equal(kindLabel('feature'), '新功能')
})
