// 构建一致性测试。
//
// lib/ 是入库的构建产物，所以最容易出的事故是「改了 src 忘了 build」——那会发出
// 一个与源码不符的包。这里直接比对字节，把这个事故变成一条红测试。

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function read(path) {
  return readFileSync(path, 'utf8')
}

test('lib/ 里每个 host 模块都与 src/ 逐字节一致（忘了 build 会红）', () => {
  const hostModules = readdirSync(join(root, 'src')).filter((name) => name.endsWith('.js'))
  assert.ok(hostModules.length >= 5, '至少应有 core/classify/evidence/git/host/redact/render/sessions')
  for (const name of hostModules) {
    const target = name === 'host.js' ? 'index.js' : name
    const source = read(join(root, 'src', name))
    const built = read(join(root, 'lib', target))
    assert.equal(built, source, 'lib/' + target + ' 与 src/' + name + ' 不一致，请跑 node scripts/build.mjs')
  }
})

test('lib/client.js 是合法的 __ModuleLoader__ 工厂，且 CSS 已内联', () => {
  const bundle = read(join(root, 'lib', 'client.js'))
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundle, new RegExp('id: ' + JSON.stringify(pkg.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(bundle, /factory: \(require\) => \{/)
  assert.match(bundle, /\.cz-root\{/, 'CSS 应当已内联进 bundle')
  assert.equal(bundle.includes("require('./client-css.cjs')"), false, '相对 require 必须被替换掉')
  assert.doesNotThrow(() => new Function(bundle))
})

test('lib/index.js 导出符合 DSH 插件契约的名字与 apply', async () => {
  const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  assert.equal(host.name, pkg.name)
  assert.equal(typeof host.apply, 'function')
  assert.ok(Array.isArray(host.inject))
  assert.deepEqual(host.inject, [], '两个服务都应软读，不硬 require')
})

test('lib/client.js 导出名字与 apply，并声明 slots 依赖', async () => {
  const source = read(join(root, 'lib', 'client.js'))
  assert.match(source, /module\.exports = \{\n  name: 'dsh-changelog-zh'/)
  assert.match(source, /inject: \['slots'\]/)
  assert.match(source, /conversation\.view/)
})

test('版本号在源码、package.json、README 三处一致', async () => {
  const core = await import(pathToFileURL(join(root, 'lib', 'core.js')).href)
  assert.equal(core.NAME, pkg.name)
  assert.equal(core.VERSION, pkg.version)
  assert.match(read(join(root, 'README.md')), new RegExp('v?' + pkg.version.replace(/\./g, '\\.')))
  assert.match(read(join(root, 'CHANGELOG.md')), new RegExp(pkg.version.replace(/\./g, '\\.')))
})

test('cordis.patch.yml 指向本插件，package.json 也指向它', () => {
  const patch = read(join(root, 'cordis.patch.yml'))
  assert.match(patch, /- insert:/)
  assert.match(patch, new RegExp('id: ' + pkg.name))
  assert.match(patch, new RegExp('name: ' + pkg.name))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(statSync(join(root, 'cordis.patch.yml')).isFile())
})

test('package.json 的 bin 指向存在的可执行脚本并带 shebang', () => {
  assert.equal(pkg.bin['changelog-zh'], 'bin/changelog-zh.mjs')
  const bin = read(join(root, 'bin', 'changelog-zh.mjs'))
  assert.match(bin, /^#!\/usr\/bin\/env node\n/)
  assert.ok(statSync(join(root, 'bin', 'changelog-zh.mjs')).isFile())
})

test('files 字段覆盖运行所需的一切（lib、src、bin、补丁文件）', () => {
  for (const entry of ['lib', 'src', 'bin', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), 'files 里缺少 ' + entry)
  }
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('.gitignore 排除了依赖、临时文件与凭据文件', () => {
  const ignore = read(join(root, '.gitignore'))
  for (const pattern of ['node_modules/', '.env', '.credentials.yaml', 'tmp/']) {
    assert.ok(ignore.includes(pattern), '.gitignore 里缺少 ' + pattern)
  }
})
