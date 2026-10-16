// 脱敏：变更日志是要发到公开 Release / 群公告里的文本，所以生成之前必须假设
// 提交信息里可能藏着不该公开的东西。
//
// 这一层刻意做得很窄：只处理**有明确形状**的凭据和本机路径，不做泛化的
// 「看起来像密码」猜测。理由是一份误伤的变更日志会让人不敢用，而一个漏网的
// token 会真的出事 —— 两者都不可接受，所以每条规则都写成可枚举、可测试的模式。
//
// 命中的位置不吞掉，而是替换成 `<已隐去:类型>` 并计数：读者看得见「这里被
// 隐去了一处」，而不是被悄悄改掉的空白。

const PLACEHOLDER = (kind) => '<已隐去:' + kind + '>'

// 顺序有意义：越具体的越靠前，避免 sk- 之类的通用模式先吃掉私有密钥块。
const RULES = [
  {
    kind: 'private-key',
    label: '私钥块',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => PLACEHOLDER('private-key'),
  },
  {
    kind: 'github-token',
    label: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: () => PLACEHOLDER('github-token'),
  },
  {
    kind: 'github-pat',
    label: 'GitHub 细粒度 token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: () => PLACEHOLDER('github-pat'),
  },
  {
    kind: 'slack-token',
    label: 'Slack token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => PLACEHOLDER('slack-token'),
  },
  {
    kind: 'aws-key-id',
    label: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => PLACEHOLDER('aws-key-id'),
  },
  {
    kind: 'api-key',
    label: 'API key',
    pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: () => PLACEHOLDER('api-key'),
  },
  {
    kind: 'jwt',
    label: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => PLACEHOLDER('jwt'),
  },
  {
    kind: 'bearer',
    label: 'Bearer 凭据',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    replace: (match) => 'Bearer ' + PLACEHOLDER('bearer'),
  },
  {
    kind: 'connection-string',
    label: '带口令的连接串',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql|ftp):\/\/[^\s"'<>@/]+:[^\s"'<>@/]+@[^\s"'<>]*/gi,
    replace: (match) => match.split('://')[0] + '://' + PLACEHOLDER('connection-string'),
  },
  {
    kind: 'assigned-secret',
    label: '被赋值的口令/密钥',
    // 只认「键名明确 + 值是不含空格的 ASCII 长串」，中文值和短值一律不动。
    pattern: /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token)\b(\s*[:=]\s*)["'`]?([A-Za-z0-9_\-./+=]{16,})["'`]?/gi,
    replace: (match, key, separator) => key + separator + PLACEHOLDER('assigned-secret'),
  },
  {
    kind: 'home-path',
    label: '本机用户目录',
    pattern: /\b[A-Za-z]:\\Users\\[^\\/\s"'<>]+/g,
    replace: (match) => match.slice(0, match.indexOf('\\Users\\') + 7) + '<用户>',
  },
  {
    // git 在 Windows 上打印的是正斜杠路径（`C:/Users/me/proj`），所以这条必须
    // 与反斜杠那条并存，否则 meta.repo.root 会把本机用户名带进公开文案。
    kind: 'home-path',
    label: '本机用户目录',
    pattern: /\b[A-Za-z]:\/(?:Users|users|home)\/[^/\s"'<>]+/g,
    replace: (match) => match.replace(/\/(?:Users|users|home)\/.*$/, '/<用户>'),
  },
  {
    kind: 'home-path-unix',
    label: '本机用户目录',
    pattern: /(^|[\s"'`(=:\[])\/(?:home|Users)\/[A-Za-z0-9._-]+/g,
    replace: (match, lead) => lead + match.slice(lead.length).replace(/^(\/(?:home|Users)\/).*$/, '$1<用户>'),
  },
]

export const REDACTION_KINDS = RULES.map((rule) => rule.kind)

/**
 * 对一段文本做脱敏。
 * @param {string} text
 * @returns {{ text: string, hits: Array<{kind: string, label: string, count: number}>, total: number }}
 */
export function redactText(text) {
  const source = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text)
  if (source.length === 0) return { text: '', hits: [], total: 0 }

  let output = source
  const hits = []
  for (const rule of RULES) {
    // 每条规则都用一个新的 RegExp：带 g 的正则是有状态的，复用会让第二次调用
    // 从上次的 lastIndex 开始，漏掉开头的命中。
    const scanner = new RegExp(rule.pattern.source, rule.pattern.flags)
    const matches = output.match(scanner)
    if (matches === null || matches.length === 0) continue
    hits.push({ kind: rule.kind, label: rule.label, count: matches.length })
    const rewriter = new RegExp(rule.pattern.source, rule.pattern.flags)
    output = output.replace(rewriter, rule.replace)
  }

  const total = hits.reduce((sum, hit) => sum + hit.count, 0)
  return { text: output, hits: hits, total: total }
}

/** 合并多处脱敏命中，得到按类型聚合的计数。 */
export function mergeHits(hitLists) {
  const byKind = new Map()
  for (const list of hitLists) {
    for (const hit of list || []) {
      const current = byKind.get(hit.kind) || { kind: hit.kind, label: hit.label, count: 0 }
      current.count += hit.count
      byKind.set(hit.kind, current)
    }
  }
  return Array.from(byKind.values()).sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
}
