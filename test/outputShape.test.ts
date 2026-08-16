import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasOrderBy } from '../src/lib/placeholders.ts'
import { toResponseFields, probedColumns, probedContainer } from '../src/lib/output.ts'
import { redactOutput, isSensitiveHeaderName } from '../src/lib/secrets.ts'

/**
 * 阶段 1 那几个小修的纯函数层。DOM 和组件那半边靠真实浏览器验。
 */

test('hasOrderBy：跳过注释和字符串里的 order by', () => {
  assert.equal(hasOrderBy('SELECT * FROM t ORDER BY dt'), true)
  assert.equal(hasOrderBy('SELECT * FROM t order   by dt DESC'), true)
  assert.equal(hasOrderBy('SELECT * FROM t'), false)
  assert.equal(hasOrderBy(''), false)
  // 这两条是「第 N 行」判定会踩的坑：看着有 order by，其实没有
  assert.equal(hasOrderBy('SELECT * FROM t -- 记得加 order by'), false)
  assert.equal(hasOrderBy("SELECT 'order by' AS s FROM t"), false)
  assert.equal(hasOrderBy('SELECT * FROM t /* order by dt */'), false)
  // 有真的也有假的 → 算有
  assert.equal(hasOrderBy("SELECT 'order by' AS s FROM t ORDER BY dt"), true)
  // 不能被 reorder_by 之类的词误伤
  assert.equal(hasOrderBy('SELECT reorder_by FROM t'), false)
})

test('toResponseFields：对象数组要下钻成 items[].col', () => {
  const fields = toResponseFields({
    body: {
      total: 2,
      items: [{ vid: 1, name: 'a' }, { vid: 2, name: 'b' }],
      user: { uid: 7, name: 'z' },
      empty: [],
      scalars: [1, 2, 3],
    },
  })!
  const keys = Object.keys(fields).sort()
  assert.deepEqual(keys, [
    'body.empty', 'body.items', 'body.items[].name', 'body.items[].vid',
    'body.scalars', 'body.total', 'body.user', 'body.user.name', 'body.user.uid',
  ])
  // 空数组和标量数组没有列可记，只留容器本身
  assert.equal(fields['body.empty'].type, 'array')
  assert.equal(fields['body.scalars'].type, 'array')
})

test('toResponseFields：HTTP 顶层数组和标量正文也能学习结构', () => {
  const arrayFields = toResponseFields({ body: [{ token: 'a', uid: 1 }] })!
  assert.deepEqual(Object.keys(arrayFields).sort(), ['body[].token', 'body[].uid'])
  const scalarFields = toResponseFields({ body: 'ok' })!
  assert.equal(scalarFields.body.type, 'string')
})

test('toResponseFields 的下钻结果能被现成的 [] 解析器解开', () => {
  // 这正是复用 rows[].col 约定的意义：probedColumns / probedContainer 一行不用改，
  // pushFirstRowVars 随即产出 body.items[0].name
  const fields = toResponseFields({ body: { items: [{ vid: 1, name: 'a' }] } })!
  assert.equal(probedContainer(fields), 'body.items')
  assert.deepEqual(probedColumns(fields).map((c) => c.name).sort(), ['name', 'vid'])
})

test('redactOutput：只遮响应头，业务数据一个字不动', () => {
  const out = redactOutput('http.request', {
    status: 200,
    headers: { 'set-cookie': 'sid=abc', 'content-type': 'application/json' },
    body: { token: '007xxx', name: '张三' },
  }) as any
  assert.equal(out.headers['set-cookie'], '[REDACTED]')
  assert.equal(out.headers['content-type'], 'application/json')
  // 头号反例：SQL / 响应体里的 token 是用户自己要的业务数据，不许替他遮
  assert.equal(out.body.token, '007xxx')
  assert.equal(out.status, 200)
})

test('redactOutput：非 HTTP 节点原样返回同一个对象', () => {
  const sql = { rows: [{ token: '007xxx' }], rowCount: 1 }
  assert.equal(redactOutput('sql.query', sql), sql)
  // 结构不对的输入不能炸
  assert.equal(redactOutput('http.request', null), null)
  assert.equal(redactOutput('http.request', 'text'), 'text')
  const noHeaders = { body: {} }
  assert.equal(redactOutput('http.request', noHeaders), noHeaders)
})

test('isSensitiveHeaderName 覆盖精确名和模式', () => {
  for (const n of ['Set-Cookie', 'authorization', 'X-Api-Key', 'x-refresh-token', 'MY_SECRET']) {
    assert.equal(isSensitiveHeaderName(n), true, n)
  }
  for (const n of ['content-type', 'accept', 'user-agent']) {
    assert.equal(isSensitiveHeaderName(n), false, n)
  }
})
