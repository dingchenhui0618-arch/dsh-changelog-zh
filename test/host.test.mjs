// Host 半区测试：用 stub ctx 驱动真实的 apply()。
//
// 要钉住的四件事：
//   1. 两处注册（HTTP 路由、changelog_zh 工具）各自独立，坏一个不影响另一个；
//   2. 生成失败走明确的 HTTP 状态与错误码，不吞成 200；
//   3. 路径白名单与范围校验真的拦得住；
//   4. 卸载时路由与工具都被删干净。

import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import test from 'node:test'
import { apply as applyHost, name as hostName } from '../src/host.js'
import { NAME, VERSION } from '../src/core.js'
import { cleanupDir, makePlainDir, makeRepo, makeReq, makeRes, repoTest } from './helpers/repo.mjs'

function setup(config, options = {}) {
  const routes = []
  const tools = []
  const disposers = []

  const webServer = {
    register(route) {
      if (options.registerThrows === true) throw new Error('webServer.register 不可用')
      routes.push(route)
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const toolRegistry = {
    register(definition) {
      if (options.toolsRegisterThrows === true) throw new Error('tools.register 不可用')
      tools.push(definition)
      return function () {
        const index = tools.indexOf(definition)
        if (index >= 0) tools.splice(index, 1)
      }
    },
  }

  const services = {}
  if (options.noWebServer !== true) services.webServer = webServer
  if (options.noTools !== true) services.tools = toolRegistry

  const ctx = {
    get(name) { return services[name] },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
  }

  applyHost(ctx, config)

  return {
    routes: routes,
    tools: tools,
    webServer: webServer,
    toolRegistry: toolRegistry,
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
    async call(method, url, body) {
      assert.equal(routes.length, 1, '应当且只应当注册一条路由')
      const res = makeRes()
      await routes[0].handler(makeReq(method, url, body), res)
      return { status: res.captured.status, body: res.json(), res: res }
    },
  }
}

test('插件导出的名字与 core 保持一致，且不硬 inject 任何服务', () => {
  assert.equal(hostName, NAME)
  assert.equal(NAME, 'dsh-changelog-zh')
  assert.equal(VERSION, '0.1.0')
})

test('注册的路由是 /dsh-changelog-zh 前缀路由', () => {
  const h = setup({})
  assert.equal(h.routes.length, 1)
  assert.equal(h.routes[0].kind, 'prefix')
  assert.equal(h.routes[0].path, '/dsh-changelog-zh')
  h.dispose()
})

test('GET /state 给出插件信息、配置与零统计', async () => {
  const h = setup({ roots: ['D:/a'], defaultRepo: 'D:/b', maxCommits: 42 })
  try {
    const out = await h.call('GET', '/dsh-changelog-zh/state')
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.plugin.name, NAME)
    assert.equal(out.body.plugin.version, VERSION)
    assert.deepEqual(out.body.config.roots, ['D:/a'])
    assert.equal(out.body.config.defaultRepo, 'D:/b')
    assert.equal(out.body.config.maxCommits, 42)
    assert.equal(typeof out.body.config.cwd, 'string')
    assert.equal(out.body.last, null)
    assert.equal(out.body.stats.generated, 0)
    assert.deepEqual(out.body.recent, [])
  } finally {
    h.dispose()
  }
})

repoTest('POST /generate 返回两版 Markdown、紧凑条目与统计', async () => {
  const repo = makeRepo()
  const h = setup({})
  try {
    const sha = repo.commit('feat: 支持导出', { body: 'Verified: node --test 42 passed' })
    const out = await h.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.meta.commitCount, 1)
    assert.match(out.body.markdown.user, new RegExp('`' + sha.slice(0, 7) + '`，已验证'))
    assert.match(out.body.markdown.dev, /- 验证：已验证/)
    assert.equal(out.body.entries.length, 1)
    assert.deepEqual(Object.keys(out.body.entries[0]).sort(), [
      'breaking', 'kind', 'label', 'reason', 'sha', 'short', 'subject', 'title', 'titleSource', 'verified',
    ])
    assert.equal(out.body.entries[0].verified, true)

    assert.equal(out.body.format, 'both')
    const onlyUser = await h.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir, format: 'user' })
    assert.equal(onlyUser.body.format, 'user')
  } finally {
    h.dispose()
    repo.cleanup()
  }
})

repoTest('生成失败按错误码给状态：非仓库/越界 403，参数错 400', async () => {
  const repo = makeRepo()
  const plain = makePlainDir()
  const h = setup({ roots: [plain] })
  try {
    repo.commit('feat: x')
    const outside = await h.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir })
    assert.equal(outside.status, 403)
    assert.equal(outside.body.ok, false)
    assert.equal(outside.body.error.code, 'EOUTSIDE')

    const notRepo = await h.call('POST', '/dsh-changelog-zh/generate', { repo: join(plain, '空目录也不存在') })
    assert.equal(notRepo.status, 403)
    assert.equal(notRepo.body.error.code, 'ENOTREPO')

    const h2 = setup({})
    const badRev = await h2.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir, range: '--output=x.txt' })
    assert.equal(badRev.status, 400)
    assert.equal(badRev.body.error.code, 'EBADREV')

    const badRange = await h2.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir, range: 'no-such..HEAD' })
    assert.equal(badRange.status, 400)
    assert.equal(badRange.body.error.code, 'EBADRANGE')

    const badSessions = await h2.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir, sessions: join(plain, '没有这个文件') })
    assert.equal(badSessions.status, 400)
    assert.equal(badSessions.body.error.code, 'ESESSIONS')
    h2.dispose()
  } finally {
    h.dispose()
    repo.cleanup()
    cleanupDir(plain)
  }
})

test('未知方法 404、非 GET/POST 405、坏 JSON body 不炸', async () => {
  const h = setup({})
  try {
    const unknown = await h.call('POST', '/dsh-changelog-zh/不存在的方法', {})
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'EMETHOD')

    const wrongMethod = await h.call('DELETE', '/dsh-changelog-zh/state')
    assert.equal(wrongMethod.status, 405)

    const broken = await h.call('POST', '/dsh-changelog-zh/不存在的方法', '{不是 json')
    assert.equal(broken.status, 404, '坏 body 会被当成空对象，仍走方法分发')
  } finally {
    h.dispose()
  }
})

repoTest('clear 清空最近记录，统计计数成功与失败', async () => {
  const repo = makeRepo()
  const h = setup({})
  try {
    repo.commit('feat: x')
    await h.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir })
    const afterOk = await h.call('GET', '/dsh-changelog-zh/state')
    assert.equal(afterOk.body.stats.generated, 1)
    assert.equal(afterOk.body.stats.failed, 0)
    assert.equal(afterOk.body.last.commitCount, 1)
    assert.equal(afterOk.body.recent.length, 1)

    await h.call('POST', '/dsh-changelog-zh/generate', { repo: join(repo.dir, '不存在') })
    const afterFail = await h.call('GET', '/dsh-changelog-zh/state')
    assert.equal(afterFail.body.stats.failed, 1)
    assert.equal(afterFail.body.last.commitCount, 1, '失败不该覆盖上一次成功的记录')
    assert.equal(afterFail.body.recent.length, 2)

    const cleared = await h.call('POST', '/dsh-changelog-zh/clear', {})
    assert.equal(cleared.status, 200)
    const afterClear = await h.call('GET', '/dsh-changelog-zh/state')
    assert.equal(afterClear.body.last, null)
    assert.deepEqual(afterClear.body.recent, [])
    assert.equal(afterClear.body.stats.generated, 1, '计数是累计的，clear 不清计数')
  } finally {
    h.dispose()
    repo.cleanup()
  }
})

repoTest('配置里的 defaultRepo 在请求没给仓库时生效', async () => {
  const repo = makeRepo()
  const h = setup({ defaultRepo: repo.dir })
  try {
    const sha = repo.commit('feat: 用默认仓库')
    const out = await h.call('POST', '/dsh-changelog-zh/generate', {})
    assert.equal(out.status, 200)
    assert.equal(out.body.meta.commitCount, 1)
    assert.equal(out.body.meta.repo.head, sha)
    // 请求里显式给了别的仓库时，配置里的默认值让位。
    const other = makeRepo()
    try {
      other.commit('feat: 另一个仓库')
      const explicit = await h.call('POST', '/dsh-changelog-zh/generate', { repo: other.dir })
      assert.equal(explicit.body.meta.repo.head, other.head())
    } finally {
      other.cleanup()
    }
  } finally {
    h.dispose()
    repo.cleanup()
  }
})

repoTest('注册了 changelog_zh 工具：execute 返回两版文案，render 变成文本块', async () => {
  const repo = makeRepo()
  const h = setup({})
  try {
    const sha = repo.commit('fix: 修掉崩溃', { body: '测试：node --test' })
    assert.equal(h.tools.length, 1)
    const tool = h.tools[0]
    assert.equal(tool.name, 'changelog_zh')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(tool.parameters.required, [])
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.isConcurrencySafe(), true)

    const value = await tool.execute({ repo: repo.dir })
    assert.equal(value.commitCount, 1)
    assert.equal(value.verifiedCount, 1)
    assert.equal(value.unverifiedCount, 0)
    assert.match(value.user, new RegExp('`' + sha.slice(0, 7) + '`，已验证'))
    assert.match(value.dev, /# 变更日志（开发者版）/)

    const blocks = tool.output.render({ format: 'both' }, value)
    assert.equal(Array.isArray(blocks), true)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /范围：/)
    assert.match(blocks[0].text, /已验证 1/)
    assert.match(blocks[0].text, /# 变更日志（开发者版）/)
    assert.ok(
      blocks[0].text.indexOf('# 最近 1 次提交的变更') < blocks[0].text.indexOf('# 变更日志（开发者版）'),
      '用户版应排在开发者版前面',
    )

    const onlyUser = tool.output.render({ format: 'user' }, Object.assign({}, value, { format: 'user' }))
    assert.equal(onlyUser[0].text.includes('变更日志（开发者版）'), false)
    assert.equal(onlyUser[0].text.includes('## 生成说明'), false)

    const stats = await h.call('GET', '/dsh-changelog-zh/state')
    assert.equal(stats.body.stats.toolCalls, 1)
  } finally {
    h.dispose()
    repo.cleanup()
  }
})

test('工具执行失败时抛出可读错误（DSH 会把它变成工具错误结果）', async () => {
  const plain = makePlainDir()
  const h = setup({})
  try {
    await assert.rejects(
      () => h.tools[0].execute({ repo: plain }),
      (error) => {
        assert.equal(error.code, 'ENOTREPO')
        assert.match(error.message, /不是一个可读的 git 仓库/)
        return true
      },
    )
    const stats = await h.call('GET', '/dsh-changelog-zh/state')
    assert.equal(stats.body.stats.failed, 1)
  } finally {
    h.dispose()
    cleanupDir(plain)
  }
})

test('没有 webServer 时不注册路由、不抛异常，工具照样在', () => {
  const h = setup({}, { noWebServer: true })
  assert.equal(h.routes.length, 0)
  assert.equal(h.tools.length, 1)
  h.dispose()
})

test('没有 tools 服务时工具不注册、路由照样在', () => {
  const h = setup({}, { noTools: true })
  assert.equal(h.tools.length, 0)
  assert.equal(h.routes.length, 1)
  h.dispose()
})

test('webServer.register 抛异常时插件存活，工具仍注册', () => {
  const h = setup({}, { registerThrows: true })
  assert.equal(h.routes.length, 0)
  assert.equal(h.tools.length, 1)
  assert.doesNotThrow(() => h.dispose())
})

test('tools.register 抛异常时插件存活，路由仍注册', () => {
  const h = setup({}, { toolsRegisterThrows: true })
  assert.equal(h.tools.length, 0)
  assert.equal(h.routes.length, 1)
  assert.doesNotThrow(() => h.dispose())
})

test('卸载：路由与工具都被拆干净', () => {
  const h = setup({})
  assert.equal(h.routes.length, 1)
  assert.equal(h.tools.length, 1)
  h.dispose()
  assert.equal(h.routes.length, 0)
  assert.equal(h.tools.length, 0)
})

repoTest('配置里的 maxCommits 是 limit 的默认值，请求可以覆盖，非法值回落到配置', async () => {
  const repo = makeRepo()
  const h = setup({ maxCommits: 1 })
  try {
    repo.commit('feat: 第一个')
    repo.commit('feat: 第二个')
    repo.commit('feat: 第三个')

    const capped = await h.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir })
    assert.equal(capped.body.meta.commitCount, 1, '配置的 maxCommits=1 应当生效')
    assert.equal(capped.body.meta.range.truncated, true)

    const overridden = await h.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir, limit: 3 })
    assert.equal(overridden.body.meta.commitCount, 3)

    const bogus = await h.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir, limit: -5 })
    assert.equal(bogus.body.meta.commitCount, 1, '非法 limit 回落到配置值，而不是把负数带进 core')

    const huge = await h.call('POST', '/dsh-changelog-zh/generate', { repo: repo.dir, limit: 999999 })
    assert.equal(huge.body.meta.commitCount, 3)
    assert.equal(huge.body.meta.range.limit, 5000, 'limit 上限被夹住')
  } finally {
    h.dispose()
    repo.cleanup()
  }
})
