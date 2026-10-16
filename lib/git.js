// git 读取层。
//
// 全部通过 `execFileSync('git', argv)` 直调，**从不过 shell**：仓库路径、范围、
// 会话文件路径都是 argv 里的独立元素。范围字符串另外做白名单校验，因为
// `git log` 会把 `--output=<file>` 这样的东西当选项 —— 那是写文件，不是查询。
//
// 只跑两条 git 命令就够：一条取提交元信息（含 git notes），一条取每次提交的
// 文件增减。分两条是因为 `--numstat` 会追加在格式化输出之后，混在一起时
// 多行 body 与 numstat 无法无歧义切分。

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export const RECORD_SEP = '\u001e'
export const FIELD_SEP = '\u001f'

const LOG_FORMAT = [
  '%H', // 完整 sha
  '%h', // 短 sha
  '%an', // 作者名
  '%ae', // 作者邮箱
  '%aI', // 作者时间（ISO 8601 严格）
  '%cI', // 提交时间（ISO 8601 严格）
  '%s', // 主题
  '%b', // 正文
  '%N', // git notes
].join('%x1f') + '%x1e'

export const DEFAULT_LIMIT = 300
const GIT_TIMEOUT_MS = 30000
const MAX_BUFFER = 64 * 1024 * 1024

export class GitError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.detail = detail
  }
}

function gitArgs(repo, args) {
  return ['-C', repo, '-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8', ...args]
}

/**
 * 跑一条 git 命令，不抛异常。
 * @returns {{ok: boolean, stdout: string, stderr: string, status: number|null}}
 */
export function tryGit(repo, args, options = {}) {
  try {
    const stdout = execFileSync('git', gitArgs(repo, args), {
      encoding: 'utf8',
      timeout: options.timeout === undefined ? GIT_TIMEOUT_MS : options.timeout,
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: stdout, stderr: '', status: 0 }
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    return {
      ok: false,
      stdout: stdout,
      stderr: stderr || String((error && error.message) || error),
      status: typeof error.status === 'number' ? error.status : null,
    }
  }
}

/** 跑一条 git 命令，失败即抛。 */
export function runGit(repo, args, options = {}) {
  const result = tryGit(repo, args, options)
  if (!result.ok) {
    throw new GitError('EGIT', 'git ' + args.join(' ') + ' 失败：' + result.stderr.trim(), result.stderr)
  }
  return result.stdout
}

let gitProbe
/** git 是否可用（探测结果缓存，测试里可用 resetGitProbe 清掉）。 */
export function gitAvailable() {
  if (gitProbe !== undefined) return gitProbe
  try {
    const out = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })
    gitProbe = /^git version /.test(String(out))
  } catch (error) {
    gitProbe = false
  }
  return gitProbe
}

export function resetGitProbe() {
  gitProbe = undefined
}

export function isGitRepo(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false
  if (!existsSync(dir)) return false
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch (error) {
    return false
  }
  return tryGit(dir, ['rev-parse', '--git-dir']).ok
}

// 只允许这些字符构成一个 rev / 范围；开头不许是 `-`，因为那会被 git 当选项。
const REV_SAFE = /^[A-Za-z0-9._/@^{}~^:-]+$/

/**
 * 校验一个 rev 或 `a..b` 范围。拒绝空白、选项样式的字符串和 shell 元字符。
 * @throws {GitError} code=EBADREV
 */
export function sanitizeRev(text, label) {
  const value = String(text === undefined || text === null ? '' : text).trim()
  if (value.length === 0) throw new GitError('EBADREV', (label || '范围') + '不能为空')
  if (value.startsWith('-')) {
    throw new GitError('EBADREV', (label || '范围') + '不能以 - 开头（git 会把它当选项）：' + value)
  }
  if (/\s/.test(value) || value.includes('\u0000')) {
    throw new GitError('EBADREV', (label || '范围') + '不能包含空白或空字符：' + value)
  }
  for (const part of value.split('..')) {
    if (part.length === 0) continue
    if (!REV_SAFE.test(part)) {
      throw new GitError('EBADREV', (label || '范围') + '含有不允许的字符：' + part)
    }
  }
  return value
}

/**
 * 校验一个日期参数（`--since` 的值）。
 * 日期里可以有空格（`2026-01-01 10:00`），所以不能套 rev 的白名单；这里只拦
 * 控制字符——值是以 `--since=<value>` 形式附加的，不可能被当成另一个选项。
 * @throws {GitError} code=EBADREV
 */
export function sanitizeDate(text, label) {
  const value = String(text === undefined || text === null ? '' : text).trim()
  if (value.length === 0) throw new GitError('EBADREV', (label || '日期') + '不能为空')
  if (/[\u0000\r\n]/.test(value)) {
    throw new GitError('EBADREV', (label || '日期') + '不能包含换行或空字符')
  }
  return value
}

/** 校验范围内的每个 rev 都真实存在。 */
export function validateRange(repo, rangeText) {
  const text = sanitizeRev(rangeText, '范围')
  for (const part of text.split('..')) {
    if (part.length === 0) continue
    const probe = tryGit(repo, ['rev-parse', '--verify', '--quiet', part + '^{commit}'])
    if (!probe.ok) throw new GitError('EBADRANGE', '范围里的 ' + part + ' 在仓库里不存在')
  }
  return text
}

/**
 * 解析 `git log --pretty=format:<9 个 %x1f 分隔字段>%x1e` 的输出。
 * 纯函数，测试直接喂字符串。
 */
export function parseGitLog(text) {
  const commits = []
  for (const chunk of String(text === undefined || text === null ? '' : text).split(RECORD_SEP)) {
    const trimmed = chunk.replace(/^\n+/, '')
    if (trimmed.length === 0) continue
    const fields = trimmed.split(FIELD_SEP)
    if (fields.length < 8) continue
    const tail = fields.length >= 9 ? fields[fields.length - 1] : ''
    const head = fields.slice(0, fields.length >= 9 ? fields.length - 1 : fields.length)
    const body = head.slice(7).join(FIELD_SEP)
    const sha = head[0].trim()
    if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) continue
    commits.push({
      sha: sha,
      short: (head[1] || sha.slice(0, 7)).trim(),
      author: (head[2] || '').trim(),
      email: (head[3] || '').trim(),
      authoredAt: (head[4] || '').trim(),
      committedAt: (head[5] || '').trim(),
      subject: (head[6] || '').trim(),
      body: body.replace(/\s+$/, ''),
      notes: tail.replace(/^\n+/, '').replace(/\s+$/, ''),
    })
  }
  return commits
}

/** `old => new` / `src/{old => new}/x.js` 归一成新路径。 */
export function normalizeRename(path) {
  const text = String(path || '')
  if (!text.includes('=>')) return text
  if (/\{[^{}]*=>[^{}]*\}/.test(text)) {
    return text.replace(/\{[^{}]*?=>\s*([^{}]*?)\}/g, '$1').replace(/\/{2,}/g, '/')
  }
  const index = text.lastIndexOf('=>')
  return text.slice(index + 2).trim()
}

/** 解析 numstat 行（`新增\t删除\t路径`）。 */
export function parseNumstat(text) {
  const files = []
  for (const raw of String(text === undefined || text === null ? '' : text).split('\n')) {
    if (raw.trim().length === 0) continue
    const parts = raw.split('\t')
    if (parts.length < 3) continue
    const addRaw = parts[0].trim()
    const delRaw = parts[1].trim()
    const path = normalizeRename(parts.slice(2).join('\t').trim())
    if (path.length === 0) continue
    const binary = addRaw === '-' || delRaw === '-'
    files.push({
      path: path,
      insertions: binary ? 0 : Number.parseInt(addRaw, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(delRaw, 10) || 0,
      binary: binary,
    })
  }
  return files
}

/** 解析 `--numstat --pretty=format:%x1e%H` 的输出，得到 sha -> 文件列表。 */
export function parseNumstatLog(text) {
  const bySha = new Map()
  for (const chunk of String(text === undefined || text === null ? '' : text).split(RECORD_SEP)) {
    const trimmed = chunk.replace(/^\n+/, '')
    if (trimmed.length === 0) continue
    const lines = trimmed.split('\n')
    const sha = lines.shift().trim()
    if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) continue
    bySha.set(sha, parseNumstat(lines.join('\n')))
  }
  return bySha
}

export function listNotesRefs(repo) {
  const out = tryGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/notes'])
  if (!out.ok) return []
  return out.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/** 标签名 -> 指向的提交（附注标签取解引用后的提交）。 */
export function listTags(repo) {
  const out = tryGit(repo, [
    'for-each-ref',
    '--format=%(refname:short)\t%(objectname)\t%(*objectname)',
    'refs/tags',
  ])
  const byCommit = new Map()
  if (!out.ok) return byCommit
  for (const line of out.stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const parts = line.split('\t')
    const tag = (parts[0] || '').trim()
    const target = (parts[2] || '').trim() || (parts[1] || '').trim()
    if (tag.length === 0 || !/^[0-9a-fA-F]{7,40}$/.test(target)) continue
    const tags = byCommit.get(target) || []
    tags.push(tag)
    byCommit.set(target, tags)
  }
  for (const [commit, tags] of byCommit) byCommit.set(commit, tags.sort())
  return byCommit
}

export function lastTag(repo) {
  const out = tryGit(repo, ['describe', '--tags', '--abbrev=0'])
  if (!out.ok) return undefined
  const tag = out.stdout.trim()
  return tag.length > 0 ? tag : undefined
}

export function repoInfo(repo) {
  const rootOut = tryGit(repo, ['rev-parse', '--show-toplevel'])
  const root = rootOut.ok && rootOut.stdout.trim().length > 0 ? rootOut.stdout.trim() : resolve(repo)
  const headOut = tryGit(root, ['rev-parse', 'HEAD'])
  const head = headOut.ok ? headOut.stdout.trim() : ''
  const branchOut = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const originOut = tryGit(root, ['remote', 'get-url', 'origin'])
  const statusOut = tryGit(root, ['status', '--porcelain'])
  return {
    root: root,
    head: head,
    headShort: head.slice(0, 7),
    branch: branchOut.ok ? branchOut.stdout.trim() : '',
    origin: originOut.ok && originOut.stdout.trim().length > 0 ? originOut.stdout.trim() : undefined,
    notesRefs: listNotesRefs(root),
    dirty: statusOut.ok && statusOut.stdout.trim().length > 0,
  }
}

/**
 * 没给范围时的默认范围。
 *
 * 目标是「还没发布的那些提交」：
 *   * 没有标签 → 取最近提交（受 limit 限制）；
 *   * 最新标签就在 HEAD 上（典型的「刚打完标签要写 Release notes」）→ 回退到
 *     上一个标签，否则自动范围会把这次已经发布的提交再写一遍；
 *   * 再往前没有标签了 → 只能取最近提交，并在 basis 里说清楚。
 */
export function defaultRange(repo) {
  const tag = lastTag(repo)
  if (tag === undefined) return { text: undefined, from: undefined, to: 'HEAD', basis: '没有标签，取最近提交' }

  const tagSha = tryGit(repo, ['rev-parse', '--verify', '--quiet', tag + '^{commit}'])
  const headSha = tryGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const headIsTag = tagSha.ok && headSha.ok && tagSha.stdout.trim() === headSha.stdout.trim()

  if (!headIsTag) {
    return { text: tag + '..HEAD', from: tag, to: 'HEAD', basis: '最近标签 ' + tag + ' 之后' }
  }

  const previous = tryGit(repo, ['describe', '--tags', '--abbrev=0', 'HEAD^'])
  const previousTag = previous.ok ? previous.stdout.trim() : ''
  if (previousTag.length === 0) {
    return {
      text: undefined,
      from: undefined,
      to: 'HEAD',
      basis: 'HEAD 就是 ' + tag + '，且没有更早的标签，取最近提交',
    }
  }
  return {
    text: previousTag + '..HEAD',
    from: previousTag,
    to: 'HEAD',
    basis: '最新标签 ' + tag + ' 已在 HEAD 上，改用上一个标签 ' + previousTag,
  }
}

/**
 * 取提交列表，带上每次提交的文件增减。
 * @param {string} repo
 * @param {{range?: string, since?: string, limit?: number, includeMerges?: boolean, notesRefs?: string[]}} options
 */
export function collectCommits(repo, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT
  const filters = []
  if (options.includeMerges !== true) filters.push('--no-merges')
  if (options.since) filters.push('--since=' + sanitizeDate(options.since, 'since'))
  const notesRefs = Array.isArray(options.notesRefs) && options.notesRefs.length > 0
    ? options.notesRefs
    : ['refs/notes/commits']
  for (const ref of notesRefs) filters.push('--notes=' + ref)

  const rev = []
  if (options.range !== undefined && options.range !== null && String(options.range).trim().length > 0) {
    rev.push(validateRange(repo, String(options.range)))
  }
  const base = ['log', '--date=iso-strict', '--max-count=' + String(limit), ...filters]

  const meta = runGit(repo, [...base, '--pretty=format:' + LOG_FORMAT, ...rev])
  const stat = runGit(repo, [...base, '--numstat', '--pretty=format:%x1e%H', ...rev])

  const commits = parseGitLog(meta)
  const stats = parseNumstatLog(stat)
  for (const commit of commits) {
    const files = stats.get(commit.sha) || []
    commit.files = files
    commit.insertions = files.reduce((sum, file) => sum + file.insertions, 0)
    commit.deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  }
  return { commits: commits, limit: limit, truncated: commits.length >= limit }
}
