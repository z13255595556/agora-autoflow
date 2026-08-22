import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readNodeResponse } from '../worker/index.ts'

/**
 * 非 JSON 的响应体不能变成错误内容本身。
 *
 * 线上症状：SQL 节点报 `Unexpected token 'I', "Internal S"... is not valid JSON`。
 * 那句话是 `JSON.parse('Internal Server Error')` 抛的 —— 服务端未捕获的异常经
 * Starlette 兜底回的就是这个 text/plain 响应体。两头都在 `if (!r.ok)` **之前**
 * 就 `.json()`，于是真正的原因（HTTP 500、上游原话）一个字都没到用户面前，
 * 而且错误码也丢了，一次本该重试的平台抖动被判成永久失败。
 */

const PLAIN_500 = 'Internal Server Error'

test('服务端兜底的 text/plain 500：给出状态码和原话，而不是解析异常', async () => {
  const { error, code, body } = await readNodeResponse(
    new Response(PLAIN_500, { status: 500, headers: { 'content-type': 'text/plain' } }),
  )
  assert.ok(error, '必须判为失败')
  assert.ok(!error!.includes('Unexpected token'), `不能把解析异常当成错误内容：${error}`)
  assert.match(error!, /HTTP 500/)
  assert.match(error!, /Internal Server Error/)
  assert.equal(code, undefined, '认不出错误码就是认不出，不猜一个出来')
  assert.deepEqual(body, {})
})

test('网关的 HTML 错误页同理，原话截一段带出来', async () => {
  const { error } = await readNodeResponse(
    new Response('<html>\n  <body>502 Bad Gateway</body>\n</html>', { status: 502 }),
  )
  assert.match(error!, /HTTP 502/)
  assert.match(error!, /502 Bad Gateway/)
  assert.ok(!error!.includes('\n'), '多行原话压成一行，错误提示不该撑爆界面')
})

test('结构化错误：message 和 code 都要取出来（引擎按 code 判重试）', async () => {
  const { error, code } = await readNodeResponse(
    new Response(JSON.stringify({
      detail: { code: 'PLATFORM_UNAVAILABLE', retryable: true, message: '连不上数据平台' },
    }), { status: 502 }),
  )
  assert.equal(error, '连不上数据平台')
  assert.equal(code, 'PLATFORM_UNAVAILABLE')
})

test('老格式的字符串 detail 仍然认', async () => {
  const { error, code } = await readNodeResponse(
    new Response(JSON.stringify({ detail: '非法的任务 handle' }), { status: 400 }),
  )
  assert.equal(error, '非法的任务 handle')
  assert.equal(code, undefined)
})

test('正常响应照常返回 body，且不报错', async () => {
  const { body, error } = await readNodeResponse<{ done: boolean; progress: number }>(
    new Response(JSON.stringify({ done: true, progress: 100 }), { status: 200 }),
  )
  assert.equal(error, undefined)
  assert.deepEqual(body, { done: true, progress: 100 })
})

test('200 但空体：当作空对象，不是错误', async () => {
  const { body, error } = await readNodeResponse(new Response('', { status: 200 }))
  assert.equal(error, undefined)
  assert.deepEqual(body, {})
})

// ---------------------------------------------------------------- 浏览器那一侧
//
// 同一个坑在 src/lib/client.ts 里也有一份：成功分支直接 `resp.json()`。
// 网关把一个 200 的登录页塞回来时症状一模一样。

const realFetch = globalThis.fetch

async function withFetch<T>(reply: () => Response, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async () => reply()) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

test('client：500 纯文本 → 带状态码和原话的错误，不是解析异常', async () => {
  const { pollNode } = await import('../src/lib/client.ts')
  const err = await withFetch(
    () => new Response(PLAIN_500, { status: 500 }),
    () => pollNode('sql.query', 'job_00000001').then(() => null, (e: Error) => e),
  )
  assert.ok(err instanceof Error)
  assert.ok(!err.message.includes('Unexpected token'), err.message)
  assert.match(err.message, /HTTP 500/)
  assert.match(err.message, /Internal Server Error/)
})

test('client：结构化错误把 code 挂到异常上（引擎按它判重试）', async () => {
  const { pollNode } = await import('../src/lib/client.ts')
  const err = await withFetch(
    () => new Response(JSON.stringify({
      detail: { code: 'RESULT_EXPIRED', retryable: false, message: '查询结果已不在数据平台上' },
    }), { status: 410 }),
    () => pollNode('sql.query', 'job_00000001').then(() => null, (e: Error & { code?: string }) => e),
  )
  assert.equal(err!.message, '查询结果已不在数据平台上')
  assert.equal((err as Error & { code?: string }).code, 'RESULT_EXPIRED')
})

test('client：200 但不是 JSON（网关塞回登录页）也要说人话', async () => {
  const { pollNode } = await import('../src/lib/client.ts')
  const err = await withFetch(
    () => new Response('<html>login</html>', { status: 200 }),
    () => pollNode('sql.query', 'job_00000001').then(() => null, (e: Error) => e),
  )
  assert.ok(err instanceof Error)
  assert.ok(!err.message.includes('Unexpected token'), err.message)
  assert.match(err.message, /非 JSON/)
  assert.match(err.message, /login/)
})
