// Client half of dsh-changelog-zh: 对话视图里的「变更日志」Tab。
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness.
//
// The panel is a thin front end over the host route: host 半区负责跑 git 和判定，
// 这里只负责收参数、显示两版 Markdown、以及把结果复制到剪贴板。所有判定文字都
// 来自 host，client 不自己编一句结论。

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-changelog-zh'
const COPY_MS = 1600

// 结果缓存在模块作用域：切走再切回 Tab 时不必重新跑一遍 git。卸载时清掉。
let cache = { result: null, at: 0 }

function post(path, body) {
  return fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (res) {
    return res.json().then(function (data) {
      return { status: res.status, data: data }
    })
  })
}

function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text)
  }
  return new Promise(function (resolve, reject) {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', 'readonly')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      ok ? resolve() : reject(new Error('execCommand copy returned false'))
    } catch (error) {
      reject(error)
    }
  })
}

function Stat(props) {
  return h('div', { className: 'cz-stat' + (props.tone ? ' ' + props.tone : '') },
    h('b', null, String(props.value)),
    h('span', null, props.label),
  )
}

function ChangelogView() {
  const [repo, setRepo] = React.useState('')
  const [range, setRange] = React.useState('')
  const [sessions, setSessions] = React.useState('')
  const [state, setState] = React.useState(cache.result)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [tab, setTab] = React.useState('user')
  const [copied, setCopied] = React.useState('')

  // 面板打开时读一次 host 配置，把默认仓库填进输入框。
  React.useEffect(function () {
    let alive = true
    fetch(API + '/state', { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (!alive || !data || !data.config) return
        if (data.config.defaultRepo) setRepo(function (current) { return current.length > 0 ? current : data.config.defaultRepo })
        if (data.config.defaultRange) setRange(function (current) { return current.length > 0 ? current : data.config.defaultRange })
      })
      .catch(function () {})
    return function () { alive = false }
  }, [])

  React.useEffect(function () {
    if (copied.length === 0) return undefined
    const timer = setTimeout(function () { setCopied('') }, COPY_MS)
    return function () { clearTimeout(timer) }
  }, [copied])

  function generate() {
    setBusy(true)
    setError('')
    post('/generate', {
      repo: repo.trim().length > 0 ? repo.trim() : undefined,
      range: range.trim().length > 0 ? range.trim() : undefined,
      sessions: sessions.trim().length > 0 ? sessions.trim() : undefined,
    })
      .then(function (out) {
        if (out.data && out.data.ok === true) {
          cache = { result: out.data, at: Date.now() }
          setState(out.data)
        } else {
          const message = out.data && out.data.error ? (out.data.error.message || JSON.stringify(out.data.error)) : '未知错误'
          setError(message)
        }
      })
      .catch(function (failure) {
        setError(String((failure && failure.message) || failure))
      })
      .then(function () { setBusy(false) })
  }

  function copy() {
    const text = state && state.markdown ? state.markdown[tab] : ''
    copyText(text).then(function () { setCopied(tab) }).catch(function (failure) {
      setError('复制失败：' + String((failure && failure.message) || failure))
    })
  }

  const meta = state && state.meta ? state.meta : null
  const markdown = state && state.markdown ? state.markdown[tab] || '' : ''
  const verified = meta ? meta.commitCount - meta.unverifiedCount : 0

  return h('div', { className: 'cz-root' },
    h('div', { className: 'cz-head' },
      h('div', { className: 'cz-title' }, '变更日志'),
      h('div', { className: 'cz-sub' }, '从真实 git 历史生成两份中文文案，每条都带 commit SHA 与验证标记'),
    ),
    h('div', { className: 'cz-form' },
      h('div', { className: 'cz-field' },
        h('label', null, '仓库路径'),
        h('input', {
          className: 'cz-input',
          value: repo,
          placeholder: '留空用 host 配置的默认仓库',
          onChange: function (event) { setRepo(event.target.value) },
        }),
      ),
      h('div', { className: 'cz-field' },
        h('label', null, '提交范围（可选）'),
        h('input', {
          className: 'cz-input',
          value: range,
          placeholder: '例如 v1.0.0..HEAD',
          onChange: function (event) { setRange(event.target.value) },
        }),
      ),
      h('div', { className: 'cz-field' },
        h('label', null, '会话记录文件（可选）'),
        h('input', {
          className: 'cz-input',
          value: sessions,
          placeholder: '一行一条 JSON，叠加验证证据与中文标题',
          onChange: function (event) { setSessions(event.target.value) },
        }),
      ),
      h('div', { className: 'cz-actions' },
        h('button', { className: 'cz-btn cz-primary', type: 'button', disabled: busy, onClick: generate },
          busy ? '生成中…' : '生成变更日志'),
        state ? h('button', { className: 'cz-btn', type: 'button', onClick: copy }, copied === tab ? '已复制' : '复制当前版本') : null,
      ),
    ),
    error.length > 0 ? h('div', { className: 'cz-err' }, error) : null,
    copied.length > 0 ? h('div', { className: 'cz-ok' }, '已复制' + (copied === 'user' ? '用户版' : '开发者版') + '到剪贴板，可以直接贴到 Release 或群里。') : null,
    meta === null
      ? h('div', { className: 'cz-empty' }, '还没有生成。点上面的「生成变更日志」，host 会跑 `git log` 并把两版 Markdown 返回来（不会写任何文件）。')
      : h('div', null,
        h('div', { className: 'cz-stats' },
          h(Stat, { label: '提交', value: meta.commitCount }),
          h(Stat, { label: '已验证', value: verified, tone: verified > 0 ? 'cz-good' : '' }),
          h(Stat, { label: '未验证', value: meta.unverifiedCount, tone: meta.unverifiedCount > 0 ? 'cz-warn' : '' }),
          h(Stat, { label: '涉及文件', value: meta.fileCount }),
          h(Stat, { label: '已隐去', value: meta.redactions.total }),
          h(Stat, { label: '会话匹配', value: meta.sessions.loaded ? meta.sessions.matched : '—' }),
        ),
        h('div', { className: 'cz-card' },
          h('h4', null, '范围与来源'),
          h('div', { className: 'cz-mono' }, (meta.repo.origin || meta.repo.root) + ' · ' + (meta.range.text || '(全部历史)')),
          h('div', { className: 'cz-note' },
            '范围依据：' + meta.range.basis + ' · HEAD `' + meta.repo.headShort + '` · 生成于 ' + meta.generatedAt +
            (meta.range.truncated ? ' · 已触及条数上限，历史可能还有更多提交' : '')),
        ),
        meta.warnings.length > 0
          ? h('div', { className: 'cz-card' },
            h('h4', null, '生成时的提示'),
            h('ul', { className: 'cz-list' }, meta.warnings.map(function (warning, index) {
              return h('li', { key: 'w' + String(index) }, warning)
            })),
          )
          : null,
        meta.redactions.total > 0
          ? h('div', { className: 'cz-card' },
            h('h4', null, '生成时隐去的内容'),
            h('ul', { className: 'cz-list' }, meta.redactions.hits.map(function (hit) {
              return h('li', { key: hit.kind }, hit.label + ' × ' + String(hit.count) + '（已替换为 `<已隐去:' + hit.kind + '>`）')
            })),
          )
          : null,
        meta.sessions.loaded && (meta.sessions.unmatched.length > 0 || meta.sessions.ambiguous.length > 0)
          ? h('div', { className: 'cz-card' },
            h('h4', null, '没有匹配上的会话记录'),
            h('ul', { className: 'cz-list' },
              meta.sessions.unmatched.map(function (item, index) {
                return h('li', { key: 'u' + String(index) },
                  String(item.record && item.record.commit ? item.record.commit.slice(0, 7) + ' ' : '') +
                  String((item.record && (item.record.title || item.record.summary)) || '(无标题)') + ' —— ' + item.reason)
              }).concat(meta.sessions.ambiguous.map(function (item, index) {
                return h('li', { key: 'a' + String(index) },
                  String(item.record && item.record.commit ? item.record.commit : '') + ' 有歧义（候选 ' + item.candidates.join('、') + '）')
              })),
            ),
          )
          : null,
        h('div', { className: 'cz-tabs' },
          h('button', { className: 'cz-tab' + (tab === 'user' ? ' cz-on' : ''), type: 'button', onClick: function () { setTab('user') } }, '用户版（短）'),
          h('button', { className: 'cz-tab' + (tab === 'dev' ? ' cz-on' : ''), type: 'button', onClick: function () { setTab('dev') } }, '开发者版（长）'),
          h('div', { className: 'cz-spacer' }),
          h('span', { className: 'cz-note' }, '用户版不出现文件路径；开发者版逐条给分类依据与验证证据原文'),
        ),
        h('div', { className: 'cz-out' }, h('pre', { className: 'cz-pre' }, markdown)),
      ),
  )
}

function apply(ctx) {
  // dsh 0.1.6 起插件可以在会话中途卸载，所以每处注册都有对应拆除。
  ctx.effect(function () {
    return function () {
      cache = { result: null, at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-changelog-zh'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // 面板是可丢弃的一半：slot 契约变了就少一个 Tab，不能让整个客户端启动失败。
  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'changelog-zh', order: 60, label: '变更日志' },
        ChangelogView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-changelog-zh] 注册「变更日志」视图失败；host 半区与 CLI 仍然可用', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-changelog-zh',
  inject: ['slots'],
  apply: apply,
}
