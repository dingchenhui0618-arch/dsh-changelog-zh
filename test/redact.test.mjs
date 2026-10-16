// 脱敏测试。这一层是「敢公开」的前提，所以每条规则都要有正例和反例：
// 正例证明它真的命中，反例证明它不乱改正常文案。

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { REDACTION_KINDS, mergeHits, redactText } from '../src/redact.js'

test('GitHub 各种前缀的 token 都被隐去', () => {
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
    const token = prefix + 'A'.repeat(36)
    const out = redactText('提交里带了 ' + token + ' 这样的东西')
    assert.ok(!out.text.includes(token), prefix + ' 应被隐去：' + out.text)
    assert.match(out.text, /<已隐去:github-token>/)
    assert.equal(out.total, 1)
  }
})

test('GitHub 细粒度 token 被隐去', () => {
  const token = 'github_pat_' + 'a1B2c3D4e5'.repeat(3)
  const out = redactText(token)
  assert.ok(!out.text.includes(token))
  assert.deepEqual(out.hits.map((hit) => hit.kind), ['github-pat'])
})

test('OpenAI 风格的 API key 被隐去', () => {
  const out = redactText('key=sk-proj-abcdefghijklmnopqrstuvwx 和 sk-ant-api03-abcdefghijklmnopqrst')
  assert.ok(!/sk-proj-abcdefghijklmnopqrstuvwx/.test(out.text))
  assert.ok(!/sk-ant-api03/.test(out.text))
  assert.equal(out.total, 2)
})

test('AWS access key id、Slack token、JWT、Bearer 都被隐去', () => {
  const aws = redactText('AKIAIOSFODNN7EXAMPLE')
  assert.equal(aws.hits[0].kind, 'aws-key-id')

  const slack = redactText('xoxb-1234567890-abcdefghijkl')
  assert.equal(slack.hits[0].kind, 'slack-token')

  const jwt = redactText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')
  assert.equal(jwt.hits[0].kind, 'jwt')

  const bearer = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')
  assert.match(bearer.text, /Bearer <已隐去:bearer>/)
})

test('私钥块整体被隐去（多行也要吃掉）', () => {
  const text = [
    '看这个 key：',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA1234567890',
    'abcdefghijklmnopqrstuvwxyz',
    '-----END RSA PRIVATE KEY-----',
    '就这些。',
  ].join('\n')
  const out = redactText(text)
  assert.ok(!out.text.includes('MIIEowIBAAKCAQEA'))
  assert.match(out.text, /^看这个 key：\n<已隐去:private-key>\n就这些。$/)
})

test('带口令的连接串被隐去，但保留协议名', () => {
  const out = redactText('postgres://admin:s3cr3tpassword@db.internal:5432/app')
  assert.ok(!out.text.includes('s3cr3tpassword'))
  assert.match(out.text, /^postgres:\/\/<已隐去:connection-string>$/)
})

test('被赋值的口令被隐去，键名保留下来', () => {
  const out = redactText('PASSWORD=SuperSecretValue123')
  assert.match(out.text, /^PASSWORD=<已隐去:assigned-secret>$/)
})

test('本机用户目录：反斜杠与正斜杠两种写法都被隐去', () => {
  const back = redactText('路径 C:\\Users\\someone\\secret\\a.txt')
  assert.ok(!back.text.includes('someone'))
  assert.match(back.text, /C:\\Users\\<用户>\\secret\\a\.txt/)

  const forward = redactText('git 打印的是 C:/Users/someone/AppData/Local/Temp/x')
  assert.ok(!forward.text.includes('someone'))
  assert.match(forward.text, /C:\/<用户>\/AppData/)

  const unix = redactText('home 在 /home/someone/projects')
  assert.ok(!unix.text.includes('/home/someone'))
})

test('正常文案一处都不动（反例）', () => {
  const text = [
    'Verified: node --test → 42 passed',
    '测试：全部通过，退出码 0',
    'token 校验逻辑重写了一遍',
    '密码强度校验加了规则',
    '把 secret 字段改成可选',
    '用户目录：/home 这个路径本身没问题',
  ].join('\n')
  const out = redactText(text)
  assert.equal(out.total, 0, '不应有命中：' + JSON.stringify(out.hits))
  assert.equal(out.text, text)
})

test('短值与被赋值的键不会误伤', () => {
  const out = redactText('token: abc\nsecret: 中文值不该动\npwd: /tmp/x')
  assert.equal(out.total, 0, JSON.stringify(out.hits))
})

test('已经隐去过的文本再跑一次不会重复隐去', () => {
  const once = redactText('token ghp_' + 'A'.repeat(36))
  const twice = redactText(once.text)
  assert.equal(twice.total, 0)
  assert.equal(twice.text, once.text)
})

test('非字符串输入不抛异常', () => {
  assert.deepEqual(redactText(undefined), { text: '', hits: [], total: 0 })
  assert.deepEqual(redactText(null), { text: '', hits: [], total: 0 })
  assert.equal(redactText(42).text, '42')
})

test('mergeHits 按类型聚合且顺序稳定', () => {
  const a = redactText('ghp_' + 'A'.repeat(36) + ' 和 ghp_' + 'B'.repeat(36))
  const b = redactText('AKIAIOSFODNN7EXAMPLE')
  const merged = mergeHits([a.hits, b.hits, a.hits])
  assert.deepEqual(merged.map((hit) => hit.kind), ['aws-key-id', 'github-token'])
  assert.equal(merged.find((hit) => hit.kind === 'github-token').count, 4)
})

test('导出的类型清单覆盖所有规则', () => {
  assert.ok(REDACTION_KINDS.includes('github-token'))
  assert.ok(REDACTION_KINDS.includes('home-path'))
  assert.ok(REDACTION_KINDS.includes('assigned-secret'))
  // 只有 home-path 故意出现两次（Windows 反斜杠 / 正斜杠各一条规则），其余类型唯一。
  const counts = new Map()
  for (const kind of REDACTION_KINDS) counts.set(kind, (counts.get(kind) || 0) + 1)
  for (const [kind, count] of counts) {
    assert.equal(count, kind === 'home-path' ? 2 : 1, kind + ' 出现了 ' + String(count) + ' 次')
  }
})
