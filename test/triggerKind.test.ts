import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFlowDefinition } from '../src/lib/flowImport.ts'
import { useFlow } from '../src/store.ts'
import { filterFlows } from '../src/lib/flowListFilter.ts'
import type { SavedFlow } from '../src/lib/library.ts'

/**
 * definition.trigger.kind 由画布上真实的触发器节点推导（store.toDefinition）。
 *
 * 这条规则漏一种触发器的后果**不是报错**：webhook 照常触发（webhooks.handle
 * 显式传 trigger_kind='webhook' 给 create_run，从不读这个字段），所以线上一切
 * 正常，只有首页在说谎 —— 卡片写"手动触发"，按 Webhook 筛选还找不到它。
 * 正因为静默，这里把三种触发器都钉住。
 */

const def = (triggerType: string) => ({
  id: 'f1',
  version: 1,
  name: 'x',
  inputs: { type: 'object', properties: {} },
  // 故意写错：正本是画布上的节点，不是这个字段。存一次就该被纠正过来
  trigger: { kind: 'manual' },
  nodes: [
    { id: 'n1', type: triggerType, typeVersion: '1.0.0', name: 't', params: {}, onError: 'fail' },
  ],
  edges: [],
  layout: {},
})

const roundTrip = (triggerType: string) => {
  useFlow.getState().loadDefinition(normalizeFlowDefinition(def(triggerType)))
  return useFlow.getState().toDefinition().trigger
}

test('★ 画布上是 trigger.webhook，存出来就得是 webhook', () => {
  // 这一支原先漏了，落进 else 变成 manual
  assert.equal(roundTrip('trigger.webhook').kind, 'webhook')
})

test('★ 存量坏定义：顶层写 manual、节点是 webhook，normalize 就地纠正', () => {
  // toDefinition 修好之前存下/导出的定义就是这个形状，而且除非重新保存一次
  // 永远不会自愈。首页的本地流程和「导入 JSON」只经过 normalizeFlowDefinition
  // （不做 store 往返），所以纠正必须发生在这一层 —— 服务端那份草稿由
  // flowdef.trigger_kind 按同一条规则兜住
  assert.equal(normalizeFlowDefinition(def('trigger.webhook')).trigger.kind, 'webhook')
  assert.equal(normalizeFlowDefinition(def('trigger.schedule')).trigger.kind, 'schedule')
})

test('没有触发节点时才信顶层字段', () => {
  const d = normalizeFlowDefinition({
    ...def('sql.query'),
    trigger: { kind: 'webhook' },
  })
  assert.equal(d.trigger.kind, 'webhook')
})

test('trigger.schedule 存出来是 schedule', () => {
  assert.equal(roundTrip('trigger.schedule').kind, 'schedule')
})

test('trigger.manual 存出来是 manual', () => {
  assert.equal(roundTrip('trigger.manual').kind, 'manual')
})

test('webhook 的认证参数不进 trigger —— 正本在 webhooks 表', () => {
  // 存两份的话，界面显示的和实际生效的会分叉，而且谁也不报错
  useFlow.getState().loadDefinition(normalizeFlowDefinition({
    ...def('trigger.webhook'),
    nodes: [{
      id: 'n1', type: 'trigger.webhook', typeVersion: '1.0.0', name: 't',
      params: { authMode: 'secret', rateLimitPerMin: 60 }, onError: 'fail',
    }],
  }))
  assert.deepEqual(useFlow.getState().toDefinition().trigger, { kind: 'webhook' })
})

test('★ 首页按 Webhook 筛选能筛到它', () => {
  // toDefinition 写错 kind 时，用户看到的就是这一步：流程在，但筛不出来
  const d = roundTrip('trigger.webhook')
  const flow = {
    id: 'f1', name: 'x', updatedAt: 1, nodeCount: 1, origin: 'server',
    triggerKind: d.kind,
    def: { id: 'f1', version: 1, name: 'x', inputs: { type: 'object' }, trigger: d, nodes: [], edges: [], layout: {} },
  } as unknown as SavedFlow
  assert.deepEqual(filterFlows([flow], '', 'webhook').map((f) => f.id), ['f1'])
})
