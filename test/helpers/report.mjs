// 合成报告：渲染层的边界用例（空范围、无文件、破坏性、未验证）用不着真 git，
// 手搓一份形状完整的报告更快也更聚焦。形状必须与 core.buildReport 保持一致。

function entry(overrides = {}) {
  const base = {
    sha: 'a'.repeat(40),
    short: 'aaaaaaa',
    order: 0,
    author: '测试者',
    email: 'tester@example.com',
    authoredAt: '2026-10-16T10:00:00+08:00',
    committedAt: '2026-10-16T10:00:00+08:00',
    subject: 'feat: 默认条目',
    subjectRaw: 'feat: 默认条目',
    body: '',
    notes: '',
    kind: 'feature',
    label: '新功能',
    scope: undefined,
    breaking: false,
    confidence: 'explicit',
    basis: '提交前缀 feat',
    summary: '默认条目',
    title: '默认条目',
    titleSource: 'subject',
    files: [{ path: 'src/a.js', insertions: 3, deletions: 1, binary: false }],
    insertions: 3,
    deletions: 1,
    tags: [],
    evidence: {
      verified: true,
      reason: '有 1 条可引用证据',
      contradicted: [],
      recordCount: 0,
      claimedWithoutEvidence: false,
      evidence: [{ source: '提交信息', kind: 'trailer', key: 'Verified', text: 'Verified: node --test → 42 passed' }],
    },
  }
  return Object.assign(base, overrides)
}

export function makeReport(entries, metaOverrides = {}) {
  const list = entries.length > 0 ? entries : []
  const unverified = list.filter((item) => !item.evidence.verified).length
  const fileCount = new Set(list.flatMap((item) => item.files.map((file) => file.path))).size
  const meta = Object.assign({
    tool: 'dsh-changelog-zh@0.1.0',
    source: 'git log',
    generatedAt: '2026-10-16T12:00:00.000Z',
    repo: {
      root: 'D:/repo',
      head: 'b'.repeat(40),
      headShort: 'bbbbbbb',
      branch: 'main',
      origin: 'https://github.com/example/repo.git',
      dirty: false,
    },
    range: { text: 'v1.0.0..HEAD', from: 'v1.0.0', to: 'HEAD', basis: '调用方指定的范围', limit: 300, truncated: false },
    includeMerges: false,
    since: undefined,
    commitCount: list.length,
    unverifiedCount: unverified,
    fileCount: fileCount,
    insertions: list.reduce((sum, item) => sum + item.insertions, 0),
    deletions: list.reduce((sum, item) => sum + item.deletions, 0),
    kindCounts: {},
    redactions: { total: 0, hits: [] },
    titles: { translated: 0, native: 0, missing: 0 },
    sessions: { loaded: false, records: 0, matched: 0, unmatched: [], ambiguous: [] },
    warnings: [],
  }, metaOverrides)
  return { meta: meta, entries: list }
}

export { entry }
