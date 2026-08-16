import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  curlExample,
  sampleBody,
  sampleBodyJson,
  settingsDrift,
  webhookUrl,
  SECRET_PLACEHOLDER,
} from '../src/lib/webhookExample.ts'
import type { FlowInputField } from '../src/types.ts'

/**
 * 调用示例的测试。
 *
 * 这里生成的每个字符都会被复制粘贴到别人的系统里去 —— 头名字拼错、签名的
 * 消息拼错，对方调试半天才会怀疑到是我们给的示例不对。所以宁可测得琐碎。
 */

const f = (key: string, type: FlowInputField['type'], required = false): FlowInputField =>
  ({ key, title: '', type, required })

// ---------------------------------------------------------------- 地址

test('拼地址时不会出现双斜杠', () => {
  assert.equal(webhookUrl('https://x.com', 'abc'), 'https://x.com/hooks/abc')
  assert.equal(webhookUrl('https://x.com/', 'abc'), 'https://x.com/hooks/abc')
  assert.equal(webhookUrl('https://x.com///', 'abc'), 'https://x.com/hooks/abc')
})

// ---------------------------------------------------------------- 示例 body

test('按入参类型给出对应类型的示例值，而不是全用字符串', () => {
  const body = sampleBody([f('vid', 'integer'), f('day', 'string'), f('force', 'boolean')])
  assert.equal(typeof body.vid, 'number')
  assert.equal(typeof body.day, 'string')
  assert.equal(typeof body.force, 'boolean')
})

test('没有入参时是一个合法的空对象，不是空字符串', () => {
  assert.equal(sampleBodyJson([]), '{}')
})

test('key 为空的入参不进示例 —— 用户刚点「添加入参」还没填名字', () => {
  assert.equal(sampleBodyJson([f('', 'string'), f('vid', 'integer')]), '{"vid":123}')
})

test('示例里只出现声明过的入参（服务端也是这么筛的）', () => {
  const body = sampleBody([f('vid', 'integer')])
  assert.deepEqual(Object.keys(body), ['vid'])
})

// ---------------------------------------------------------------- curl

test('secret 模式带 X-Webhook-Secret 头', () => {
  const out = curlExample({ url: 'https://x.com/hooks/t', authMode: 'secret', secret: 's3cr', inputs: [f('vid', 'integer')] })
  assert.match(out, /X-Webhook-Secret: s3cr/)
  assert.match(out, /'\{"vid":123\}'/)
})

test('拿不到明文密钥时用占位符，而不是空字符串', () => {
  const out = curlExample({ url: 'https://x.com/hooks/t', authMode: 'secret', secret: null, inputs: [] })
  assert.match(out, new RegExp(`X-Webhook-Secret: ${SECRET_PLACEHOLDER}`))
  // 空的密钥头会让人以为"就这样发"，然后拿到 401 却看不出哪里不对
  assert.doesNotMatch(out, /X-Webhook-Secret: *$/m)
})

test('none 模式不带任何认证头', () => {
  const out = curlExample({ url: 'https://x.com/hooks/t', authMode: 'none', secret: null, inputs: [] })
  assert.doesNotMatch(out, /X-Webhook-Secret/)
  assert.doesNotMatch(out, /X-Signature/)
})

test('hmac 模式：签名密钥是密钥的 sha256，不是密钥本身', () => {
  const out = curlExample({ url: 'https://x.com/hooks/t', authMode: 'hmac', secret: 's3cr', inputs: [] })
  // 服务端用 secret_hash 当 key，而上游手里只有明文 —— 这一步不写出来没人猜得到
  assert.match(out, /shasum -a 256/)
  assert.match(out, /-hmac "\$KEY"/)
})

test('hmac 模式：签名的消息是 `时间戳.body`，且 body 原样发出去', () => {
  const out = curlExample({ url: 'https://x.com/hooks/t', authMode: 'hmac', secret: 's', inputs: [f('vid', 'integer')] })
  // 和 webhooks.py 的 f"{ts}." + raw_body 对齐
  assert.match(out, /printf '%s\.%s' "\$TS" "\$BODY"/)
  // -d "$BODY" 而不是重新拼一遍：重新序列化会因 key 顺序/空格差异让签名对不上
  assert.match(out, /-d "\$BODY"/)
  assert.match(out, /X-Timestamp: \$TS/)
  assert.match(out, /X-Signature: sha256=\$SIG/)
})

// ---------------------------------------------------------------- 配置漂移

const live = {
  authMode: 'secret', rateLimitPerMin: 60, responseMode: 'lastNode', responseTimeoutSeconds: 300,
}

test('节点参数和线上一致时没有漂移', () => {
  assert.deepEqual(settingsDrift({ ...live }, live), [])
})

test('认证方式和限流各自独立报告', () => {
  const drift = settingsDrift({ authMode: 'hmac', rateLimitPerMin: 10 }, live)
  assert.equal(drift.length, 2)
  assert.match(drift[0], /secret → hmac/)
  assert.match(drift[1], /60 → 10/)
})

test('节点上没填的字段不算漂移 —— 不然默认值会天天要求「应用到线上」', () => {
  assert.deepEqual(settingsDrift({}, live), [])
  assert.deepEqual(settingsDrift({ authMode: undefined }, live), [])
})

test('响应方式和等待时间发生变化时提示应用到线上', () => {
  const drift = settingsDrift({ responseMode: 'immediate', responseTimeoutSeconds: 120 }, live)
  assert.equal(drift.length, 2)
  assert.match(drift[0], /等待结果 → 立即响应/)
  assert.match(drift[1], /300 秒 → 120 秒/)
})

test('类型不对的节点参数不算漂移', () => {
  // params 是 Record<string, unknown>，画布上什么都可能被存进去
  assert.deepEqual(settingsDrift({ rateLimitPerMin: '60' }, live), [])
  assert.deepEqual(settingsDrift({ rateLimitPerMin: 1.5 }, live), [])
})
