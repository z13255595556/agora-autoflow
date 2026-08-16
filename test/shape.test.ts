import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeOutput, describeOutputStatic, flattenShape } from '../src/lib/outputShape.ts'
import type { FNode } from '../src/store.ts'
import type { FlowRun } from '../src/types.ts'

/** 造一个最小可用的画布节点 */
const mkNode = (id: string, typeId: string, extra: Record<string, unknown> = {}): FNode => ({
  id,
  type: 'flowNode',
  position: { x: 0, y: 0 },
  data: { typeId, typeVersion: '1.0.0', label: labelOf(typeId), params: {}, onError: 'fail', ...extra },
} as FNode)

const labelOf = (t: string) =>
  ({ 'sql.query': 'SQL 查询', 'http.request': 'HTTP 调用', 'notify.wecom': '企微通知',
     'variable.assign': '变量赋值', 'flow.end': '流程结束', 'date.compute': '昨天' }[t] ?? t)

/** 造一次成功运行 */
const mkRun = (nodeId: string, output: unknown): FlowRun => ({
  id: 'run_1', status: 'success', startedAt: 1, trigger: {},
  steps: { [nodeId]: [{ nodeId, status: 'success', startedAt: 1700000000000, durationMs: 1, input: {}, output }] },
} as unknown as FlowRun)

const SQL_OUTPUT = {
  rows: [{ uid: 123, name: '张三', token: '007xxx' }, { uid: 456, name: '李四', token: '007yyy' }],
  columns: [{ name: 'uid', type: 'bigint' }, { name: 'name', type: 'string' }, { name: 'token', type: 'string' }],
  rowCount: 2,
  jobId: 'j1',
  renderedSql: 'SELECT …',
  truncated: false,
}

test('SQL：真实运行 → 表格形态，列类型来自后端声明', () => {
  const node = mkNode('n3', 'sql.query')
  const shape = describeOutput(node, { run: mkRun('n3', SQL_OUTPUT) })
  assert.equal(shape.source, 'run')
  assert.equal(shape.unknown, false)
  assert.equal(shape.probeable, true)   // x-dynamic === 'probe'
  assert.equal(shape.hidden, false)

  const rows = shape.root.regions.find((r) => r.path === 'rows')!
  assert.equal(rows.kind, 'table')
  assert.deepEqual(rows.table!.columns.map((c) => `${c.name}:${c.type}`), ['uid:integer', 'name:string', 'token:string'])
  assert.equal(rows.table!.sampleRows.length, 2)
  assert.equal(rows.table!.sampleRows[0].token, '007xxx')   // 业务数据不打码
  assert.equal(rows.table!.rowCount, 2)
  assert.equal(rows.table!.truncated, false)
})

test('SQL：截断状态跟随结果表，供“最后一行”提示使用', () => {
  const output = { ...SQL_OUTPUT, truncated: true }
  const shape = describeOutput(mkNode('n3', 'sql.query'), { run: mkRun('n3', output) })
  assert.equal(shape.root.regions.find((r) => r.path === 'rows')!.table!.truncated, true)
})

test('SQL：没有 ORDER BY → orderUnstable', () => {
  const un = describeOutput(mkNode('n3', 'sql.query', { params: { sql: 'SELECT * FROM t' } }), { run: mkRun('n3', SQL_OUTPUT) })
  assert.equal(un.root.regions.find((r) => r.path === 'rows')!.table!.orderUnstable, true)
  const ok = describeOutput(mkNode('n3', 'sql.query', { params: { sql: 'SELECT * FROM t ORDER BY dt' } }), { run: mkRun('n3', SQL_OUTPUT) })
  assert.equal(ok.root.regions.find((r) => r.path === 'rows')!.table!.orderUnstable, false)
})

test('pin 压过 run —— 面板看到的必须和 ctxFromRun 解析出来的是同一份', () => {
  const node = mkNode('n3', 'sql.query')
  const pinned = { rows: [{ uid: 999 }], rowCount: 1 }
  const shape = describeOutput(node, { run: mkRun('n3', SQL_OUTPUT), pinData: { n3: pinned } })
  assert.equal(shape.source, 'pin')
  assert.equal(shape.root.regions.find((r) => r.path === 'rows')!.table!.sampleRows[0].uid, 999)
})

test('失败的步骤不算数据 —— 拿它画表会让用户挑出运行时解析成空的引用', () => {
  const failed = {
    id: 'r', status: 'error', startedAt: 1, trigger: {},
    steps: { n3: [{ nodeId: 'n3', status: 'error', startedAt: 1, durationMs: 1, input: {}, output: SQL_OUTPUT }] },
  } as unknown as FlowRun
  const shape = describeOutput(mkNode('n3', 'sql.query'), { run: failed })
  assert.equal(shape.source, 'schema')
  assert.equal(shape.unknown, true)     // 走空状态，不猜字段
})

test('没跑过也没探测过 → unknown，但可探测标记仍在', () => {
  const shape = describeOutputStatic(mkNode('n3', 'sql.query'))
  assert.equal(shape.unknown, true)
  assert.equal(shape.probeable, true)
})

test('只学到列名（没有值）也要给出表格，只是没有样例行', () => {
  const node = mkNode('n3', 'sql.query', {
    probedOutput: { 'rows[].uid': { type: 'string', title: 'uid' }, 'rows[].token': { type: 'string', title: 'token' } },
  })
  const shape = describeOutputStatic(node)
  assert.equal(shape.unknown, false)    // 有 probedOutput 就不是"完全不知道"
  const rows = shape.root.regions.find((r) => r.path === 'rows')!
  assert.equal(rows.kind, 'table')
  assert.deepEqual(rows.table!.columns.map((c) => c.name), ['uid', 'token'])
  assert.equal(rows.table!.sampleRows.length, 0)
})

test('HTTP：响应头脱敏，正文照常；嵌套对象成为子区域', () => {
  const out = {
    status: 200,
    headers: { 'set-cookie': 'sid=abc', 'content-type': 'application/json' },
    body: { token: '007xxx', user: { uid: 7, name: '张三' } },
  }
  const shape = describeOutput(mkNode('h1', 'http.request'), { run: mkRun('h1', out) })
  const headers = shape.root.regions.find((r) => r.path === 'headers')!
  assert.equal(headers.collapsed, true)                       // 高级区默认折叠
  assert.equal(headers.fields.find((f) => f.path === 'headers.set-cookie'), undefined) // 非标识符 key 不生成引用
  const body = shape.root.regions.find((r) => r.path === 'body')!
  assert.equal(body.fields.find((f) => f.label === 'token')!.sample, '007xxx')
  const user = body.regions.find((r) => r.path === 'body.user')!
  assert.deepEqual(user.fields.map((f) => f.path).sort(), ['body.user.name', 'body.user.uid'])
})

test('variable.assign：spread 之后用户看到的是自己起的名字，路径不变', () => {
  const node = mkNode('v1', 'variable.assign')
  const shape = describeOutput(node, { run: mkRun('v1', { values: { customerId: 'c1', token: 't1' } }) })
  const paths = shape.root.fields.map((f) => f.path).sort()
  // 容器本身不出现，内容升到一级；但路径仍然带 values.，lookupPath 才解得开
  assert.deepEqual(paths, ['values.customerId', 'values.token'])
  assert.deepEqual(shape.root.fields.map((f) => f.label).sort(), ['customerId', 'token'])
})

test('notify.wecom：全是运行元数据 → status 形态，默认折叠，且不作为数据源', () => {
  const shape = describeOutput(mkNode('n4', 'notify.wecom'), { run: mkRun('n4', { sent: true, bytes: 120, target: 'xx' }) })
  assert.equal(shape.root.kind, 'status')
  assert.equal(shape.root.collapsed, true)
  assert.equal(shape.hidden, true)     // ports: [] → 连不出去
})

test('flow.end 不作为上游数据源', () => {
  assert.equal(describeOutputStatic(mkNode('e1', 'flow.end')).hidden, true)
})

test('date.compute：expr 落到 advanced，其余是可直接点的单值', () => {
  const shape = describeOutput(mkNode('d1', 'date.compute'), {
    run: mkRun('d1', { value: '2026-08-15', compact: '20260815', unix: 1786752000, expr: 'now-1d/d' }),
  })
  const labels = shape.root.fields.map((f) => f.label)
  assert.ok(labels.includes('紧凑日期 20260812'.slice(0, 4)) || labels.some((l) => l.includes('紧凑')))
  assert.equal(shape.root.kind, 'object')
})

test('flattenShape：搜索索引带上「第一行那一格」，且跳过敏感字段', () => {
  const shape = describeOutput(mkNode('n3', 'sql.query'), { run: mkRun('n3', SQL_OUTPUT) })
  const flat = flattenShape(shape)
  const cell = flat.find((e) => e.path === 'rows[0].token')!
  assert.ok(cell, '应该有 rows[0].token')
  assert.equal(cell.label, 'token · 第一行')
  assert.equal(cell.sample, '007xxx')
  assert.equal(cell.known, true)
  // 拼上前缀就是完整引用，且是 lookupPath 解得开的形状
  assert.equal(`$.nodes.n3.output.${cell.path}`, '$.nodes.n3.output.rows[0].token')
})

test('未知节点类型不炸', () => {
  const shape = describeOutputStatic(mkNode('x', 'no.such.type'))
  assert.equal(shape.unknown, true)
  assert.equal(shape.hidden, true)
})
