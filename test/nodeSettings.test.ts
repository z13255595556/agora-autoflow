import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFlowDefinition } from '../src/lib/flowImport.ts'
import { useFlow } from '../src/store.ts'
import { resolveRetry } from '../src/lib/engine-core/errorCodes.ts'

/**
 * 节点设置（备注 / 暂停 / 重试覆盖）的持久化往返。
 *
 * 持久化白名单有三处：normalizeFlowDefinition 按显式键重建节点、store.loadDefinition、
 * store.toDefinition。漏掉任何一处的表现不是报错，是**静默丢字段** ——
 * 用户暂停了企微节点、刷新页面它又开始发了。所以这里把三处串起来跑一遍。
 */

const def = {
  id: 'f1',
  version: 1,
  name: 'x',
  inputs: { type: 'object', properties: {} },
  trigger: { kind: 'manual' },
  nodes: [
    { id: 'n1', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' },
    {
      id: 'n2', type: 'notify.wecom', typeVersion: '1.0.0', name: '企微', params: { webhook: 'x', msgtype: 'text', content: 'hi' },
      onError: 'continue', note: '调 SQL 期间先别发', disabled: true, retry: null,
    },
    {
      id: 'n3', type: 'sql.query', typeVersion: '2.0.0', name: 'SQL', params: { engine: 'hive', sql: 'select 1' },
      onError: 'fail', retry: { maxAttempts: 5, initialMs: 1000 },
    },
  ],
  edges: [{ from: 'n1', to: 'n2' }, { from: 'n1', to: 'n3' }],
  layout: {},
}

test('★ normalize → load → toDefinition 往返不丢 note / disabled / retry', () => {
  const normalized = normalizeFlowDefinition(def)
  const n2 = normalized.nodes.find((n) => n.id === 'n2')!
  assert.equal(n2.note, '调 SQL 期间先别发')
  assert.equal(n2.disabled, true)
  assert.equal(n2.retry, null, 'null 是"明确不重试"，不能被当成缺省抹掉')
  assert.deepEqual(normalized.nodes.find((n) => n.id === 'n3')!.retry, { maxAttempts: 5, initialMs: 1000 })

  useFlow.getState().loadDefinition(normalized)
  const back = useFlow.getState().toDefinition()
  const b2 = back.nodes.find((n) => n.id === 'n2')!
  assert.equal(b2.note, '调 SQL 期间先别发')
  assert.equal(b2.disabled, true)
  assert.equal(b2.retry, null)
  assert.deepEqual(back.nodes.find((n) => n.id === 'n3')!.retry, { maxAttempts: 5, initialMs: 1000 })
  // 没设过的节点不该凭空多出三个键 —— 老流程导出后 diff 不能变脏
  const b1 = back.nodes.find((n) => n.id === 'n1')!
  assert.equal('note' in b1, false)
  assert.equal('disabled' in b1, false)
  assert.equal('retry' in b1, false)
})

test('normalize 对脏数据只取认得的形状', () => {
  const n = normalizeFlowDefinition({
    ...def,
    nodes: [{ id: 'a', type: 'transform.template', params: {}, note: '   ', disabled: 'yes', retry: { maxAttempts: 'x', initialMs: 3 } }],
    edges: [],
  }).nodes[0]
  assert.equal('note' in n, false, '空白备注不存')
  assert.equal('disabled' in n, false, '非布尔的 disabled 不当真')
  assert.deepEqual(n.retry, { initialMs: 3 }, '只保留是数字的那一半')
})

test('setNodeDisabled / setNodeNote / setNodeRetry 清掉时不留空键', () => {
  useFlow.getState().loadDefinition(normalizeFlowDefinition(def))
  const s = useFlow.getState()
  s.setNodeDisabled('n2', false)
  s.setNodeNote('n2', '   ')
  s.setNodeRetry('n3', undefined)
  const back = useFlow.getState().toDefinition()
  const b2 = back.nodes.find((n) => n.id === 'n2')!
  assert.equal('disabled' in b2, false)
  assert.equal('note' in b2, false)
  assert.equal('retry' in back.nodes.find((n) => n.id === 'n3')!, false)
})

test('resolveRetry：类型没声明就不重试；实例 null 关掉；覆盖只改次数和首次间隔且有夹取', () => {
  const policy = { maxAttempts: 3, initialMs: 5000, backoffCoefficient: 2, maximumIntervalMs: 60_000 }
  assert.equal(resolveRetry(undefined, { maxAttempts: 9 }), null, 'http.request 这种没声明的不重试')
  assert.equal(resolveRetry(policy, null), null)
  assert.deepEqual(resolveRetry(policy, undefined), policy)
  assert.deepEqual(resolveRetry(policy, { maxAttempts: 99, initialMs: 999_999 }), {
    maxAttempts: 10, initialMs: 60_000, backoffCoefficient: 2, maximumIntervalMs: 60_000,
  })
  assert.deepEqual(resolveRetry(policy, { maxAttempts: 0 }), { ...policy, maxAttempts: 1 }, '最少尝试一次')
})

// ---------------------------------------------------------------- 入参种类 ↔ JSON Schema 往返

test('★ 入参的日期 / 下拉 / 小数 + 默认值 + 说明，导出再读回来不变', () => {
  const withInputs = {
    ...def,
    inputs: {
      type: 'object',
      properties: {
        date: { type: 'string', format: 'date', title: '日期', default: '2026-08-21', description: '查哪天' },
        engine: { type: 'string', enum: ['hive', 'doris'], title: '引擎', default: 'hive' },
        ratio: { type: 'number', title: '阈值', default: 0.25 },
        n: { type: 'integer', title: '条数', default: 10 },
        dry: { type: 'boolean', title: '试发', default: true },
      },
      required: ['date'],
    },
  }
  useFlow.getState().loadDefinition(normalizeFlowDefinition(withInputs))
  const inputs = useFlow.getState().flowInputs
  assert.deepEqual(inputs.map((f) => f.type), ['date', 'select', 'number', 'integer', 'boolean'])
  assert.equal(inputs[0].default, '2026-08-21')
  assert.equal(inputs[0].description, '查哪天')
  assert.deepEqual(inputs[1].options, ['hive', 'doris'])
  assert.equal(inputs[2].default, '0.25')
  assert.equal(inputs[4].default, 'true')
  // 默认值灌进了运行表单
  assert.equal(useFlow.getState().manualInputs.date, '2026-08-21')
  assert.equal(useFlow.getState().manualInputs.ratio, '0.25')

  const back = useFlow.getState().toDefinition()
  assert.deepEqual(back.inputs.properties, withInputs.inputs.properties)
  assert.deepEqual(back.inputs.required, ['date'])
})

test('老版本服务端下发的三要素 retry 也能用，不算出 NaN', () => {
  const old = { maxAttempts: 2, backoff: 'exponential', initialMs: 2000 } as unknown as Parameters<typeof resolveRetry>[0]
  assert.deepEqual(resolveRetry(old, undefined), { maxAttempts: 2, initialMs: 2000, backoffCoefficient: 2, maximumIntervalMs: 60_000 })
  const fixed = { maxAttempts: 3, backoff: 'fixed', initialMs: 500 } as unknown as Parameters<typeof resolveRetry>[0]
  assert.equal(resolveRetry(fixed, undefined)?.backoffCoefficient, 1)
  assert.equal(resolveRetry({} as unknown as Parameters<typeof resolveRetry>[0], undefined), null, '认不出形状就当没声明')
})
