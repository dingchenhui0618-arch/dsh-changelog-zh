// 提交分类：把一个 git 提交归到中文变更日志的一个分组里。
//
// 这一层只做**两件可解释的事**，不做任何猜测式改写：
//
//   1. 先认约定式提交前缀（`feat(scope):`、`fix!:` …）—— 这是作者明写的意图。
//   2. 认不出来时，按一张公开的关键词表匹配 —— 这是启发式，所以结果里带上
//      `confidence: 'keyword'`，长版日志会把它原样写出来。
//   3. 都认不出时归入「未分类」，绝不硬塞进某个看起来体面的分组。
//
// 它**不翻译**提交主题。中英对照里最容易被编造的就是那一句译文，所以本插件
// 只在历史里本来就有中文标题时才用中文（见 titles / Trailer 解析），否则原样
// 保留提交主题，并在元信息里报出「N 条没有中文标题」。

export const KIND_ORDER = [
  'breaking',
  'security',
  'feature',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'chore',
  'revert',
  'merge',
  'other',
]

const KIND_LABELS = {
  breaking: '破坏性变更',
  security: '安全',
  feature: '新功能',
  fix: '修复',
  perf: '性能',
  refactor: '重构',
  docs: '文档',
  test: '测试',
  build: '构建与依赖',
  chore: '其他改动',
  revert: '回滚',
  merge: '合并',
  other: '未分类',
}

const PREFIX_ALIASES = {
  feat: 'feature',
  feature: 'feature',
  fix: 'fix',
  bugfix: 'fix',
  hotfix: 'fix',
  perf: 'perf',
  performance: 'perf',
  refactor: 'refactor',
  refact: 'refactor',
  docs: 'docs',
  doc: 'docs',
  test: 'test',
  tests: 'test',
  spec: 'test',
  build: 'build',
  deps: 'build',
  dep: 'build',
  ci: 'build',
  chore: 'chore',
  style: 'chore',
  release: 'chore',
  revert: 'revert',
  security: 'security',
  sec: 'security',
  merge: 'merge',
}

// 关键词表：按顺序匹配，先命中先算数。全部小写后比较。
// ASCII 词按「单词边界」匹配（`bug` 不该命中 `debug`），中文词按子串匹配。
const KEYWORD_RULES = [
  { kind: 'revert', words: ['revert', 'reverts', '回滚', '回退'] },
  { kind: 'security', words: ['security', 'vulnerability', 'vulnerabilities', 'cve', '安全', '漏洞', '越权', '注入'] },
  { kind: 'fix', words: ['fix', 'fixes', 'fixed', 'bugfix', 'bug', 'hotfix', 'patch', '修复', '修正', '修掉', '改正', '解决', '报错', '崩溃', '异常'] },
  { kind: 'perf', words: ['perf', 'performance', 'optimize', 'optimise', 'optimization', 'faster', 'speed', 'latency', '性能', '优化', '提速', '缓存'] },
  { kind: 'feature', words: ['feat', 'feature', 'add', 'adds', 'added', 'support', 'supports', 'implement', 'implements', 'introduce', 'introduces', 'new', '新增', '支持', '增加', '添加', '实现', '接入'] },
  { kind: 'refactor', words: ['refactor', 'cleanup', 'clean up', 'tidy', 'rename', 'renames', 'restructure', '重构', '整理', '抽取', '拆分', '重命名'] },
  { kind: 'docs', words: ['doc', 'docs', 'documentation', 'readme', 'comment', 'comments', 'typo', '文档', '注释', '说明'] },
  { kind: 'test', words: ['test', 'tests', 'testing', 'spec', 'specs', 'coverage', '测试', '用例', '覆盖'] },
  { kind: 'build', words: ['build', 'deps', 'dependency', 'dependencies', 'bump', 'lockfile', 'workflow', 'release', '构建', '依赖', '升级'] },
  { kind: 'merge', words: ['merge', 'merges', '合并'] },
  { kind: 'chore', words: ['chore', 'misc', 'clean', 'polish', '杂项', '日常', '清理'] },
]

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** ASCII 关键词按词边界匹配，中文关键词按子串匹配。 */
export function keywordHit(haystack, word) {
  if (/^[a-z0-9][a-z0-9 ._-]*$/.test(word)) {
    return new RegExp('(^|[^a-z0-9])' + escapeRegExp(word) + '([^a-z0-9]|$)').test(haystack)
  }
  return haystack.includes(word)
}

const CONVENTIONAL = /^([A-Za-z][A-Za-z0-9_-]*)(?:\(([^()]*)\))?(!)?:\s*(.*)$/
const BREAKING_BODY = /(^|\n)\s*BREAKING[ -]CHANGE\s*:?/i

export function kindLabel(kind) {
  return KIND_LABELS[kind] || KIND_LABELS.other
}

export function kindOrder(kind) {
  const index = KIND_ORDER.indexOf(kind)
  return index < 0 ? KIND_ORDER.length : index
}

/** 去掉约定式前缀后剩下的那句主题；没有前缀时就是原主题。 */
export function stripPrefix(subject) {
  const match = CONVENTIONAL.exec(String(subject || '').trim())
  return match ? match[4].trim() : String(subject || '').trim()
}

/**
 * 判断这个提交是不是合并提交，以及提交信息里是否声明了破坏性变更。
 * 破坏性只看两处：主题里的 `!`，和正文里的 `BREAKING CHANGE`。不从正文措辞猜。
 */
export function detectBreaking(subject, body) {
  const text = String(subject || '')
  const match = CONVENTIONAL.exec(text.trim())
  if (match && match[3] === '!') return true
  return BREAKING_BODY.test(String(body || ''))
}

/**
 * @param {{subject?: string, body?: string}} commit
 * @returns {{kind: string, label: string, scope: string|undefined, breaking: boolean,
 *            confidence: 'explicit'|'keyword'|'fallback', basis: string, summary: string}}
 */
export function classifyCommit(commit) {
  const subject = String((commit && commit.subject) || '').trim()
  const body = String((commit && commit.body) || '')
  const breaking = detectBreaking(subject, body)

  const conventional = CONVENTIONAL.exec(subject)
  if (conventional) {
    const rawType = conventional[1].toLowerCase()
    const mapped = PREFIX_ALIASES[rawType]
    if (mapped !== undefined) {
      const kind = breaking ? 'breaking' : mapped
      return {
        kind: kind,
        label: kindLabel(kind),
        scope: conventional[2] ? conventional[2].trim() : undefined,
        breaking: breaking,
        confidence: 'explicit',
        basis: '提交前缀 ' + rawType + (breaking ? ' + 破坏性声明' : ''),
        summary: conventional[4].trim() || subject,
      }
    }
  }

  // 合并提交必须最先认出来：分支名里往往带 `feature/`、`fix-` 这类词，若先跑关键词表，
  // `Merge branch feature-x` 会被归成「新功能」，那是一句错的公开文案。
  if (/^(merge|merged)\b/i.test(subject) || /^合并/.test(subject)) {
    const kind = breaking ? 'breaking' : 'merge'
    return {
      kind: kind,
      label: kindLabel(kind),
      scope: undefined,
      breaking: breaking,
      confidence: 'keyword',
      basis: '主题以 Merge 开头' + (breaking ? ' + 破坏性声明' : ''),
      summary: stripPrefix(subject),
    }
  }

  const haystack = subject.toLowerCase()
  for (const rule of KEYWORD_RULES) {
    for (const word of rule.words) {
      if (keywordHit(haystack, word)) {
        const kind = breaking ? 'breaking' : rule.kind
        return {
          kind: kind,
          label: kindLabel(kind),
          scope: undefined,
          breaking: breaking,
          confidence: 'keyword',
          basis: '关键词「' + word + '」' + (breaking ? ' + 破坏性声明' : ''),
          summary: stripPrefix(subject),
        }
      }
    }
  }

  const kind = breaking ? 'breaking' : 'other'
  return {
    kind: kind,
    label: kindLabel(kind),
    scope: undefined,
    breaking: breaking,
    confidence: 'fallback',
    basis: '没有可识别的提交前缀或关键词',
    summary: stripPrefix(subject),
  }
}

/** 分类结果的可解释一句话（不带外层括号，由渲染层决定怎么括）。 */
export function describeClassification(classification) {
  if (classification.confidence === 'explicit') return classification.basis
  if (classification.confidence === 'keyword') return classification.basis
  return '未识别，归入未分类'
}
