import { test } from 'node:test'
import assert from 'node:assert/strict'
import { portOf, toGraph } from '../src/lib/flowGraph.ts'
import type { FlowDefinition } from '../src/types.ts'

/**
 * 端口缺省值这条规则原先散在三处（store.toDefinition / engine / check-flows）。
 * 改一处漏两处的后果不是报错，是 flow.if 的分支灭活方向**静默翻转** ——
 * 所以它现在只有一个出处，并被这些用例钉住。
 */

test('定义里的 port 优先', () => {
  assert.equal(portOf({ port: 'true' }), 'true')
  assert.equal(portOf({ port: 'each', sourceHandle: 'out' }), 'each')
})

test('没有 port 时回落到画布的 sourceHandle', () => {
  assert.equal(portOf({ sourceHandle: 'false' }), 'false')
})

test('★ 两者都缺时是 out，不是 undefined', () => {
  // 这是整条规则的要害。store.toDefinition 只在 sourceHandle 存在且 !== 'out'
  // 时才写 port，所以一条从 flow.if 拉出但没带 handle 的边，port 就是 undefined。
  // 若按 edge.port === exitPort 直接比，undefined 两边都不等 → 该边被判死
  // → 下游全被 skip；而今天的行为是两侧都不灭活、下游全跑。
  assert.equal(portOf({}), 'out')
  assert.equal(portOf({ sourceHandle: null }), 'out')
  assert.equal(portOf({ port: undefined, sourceHandle: undefined }), 'out')
})

test('sourceHandle 为 out 的边导出再转回来仍是 out', () => {
  // 往返不能把 'out' 丢成别的东西
  assert.equal(portOf({ sourceHandle: 'out' }), 'out')
})

const DEF = {
  id: 'f1',
  version: 1,
  name: 't',
  inputs: { type: 'object' as const, properties: { vid: { type: 'integer' as const, title: '厂商' } }, required: ['vid'] },
  trigger: { kind: 'manual' as const },
  nodes: [
    { id: 'n1', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' as const },
    { id: 'n2', type: 'flow.if', typeVersion: '1.0.0', name: '判断', params: { condition: 'x' }, onError: 'fail' as const },
    { id: 'n3', type: 'transform.template', typeVersion: '1.0.0', name: '文本', params: {}, onError: 'continue' as const },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3', port: 'true' },
  ],
  layout: { n1: { x: 0, y: 0 }, n2: { x: 10, y: 20 }, n3: { x: 30, y: 40 } },
} as FlowDefinition

test('toGraph 把边的口还原成 sourceHandle', () => {
  const { edges } = toGraph(DEF)
  assert.equal(edges[0].sourceHandle, 'out')   // 没写 port 的
  assert.equal(edges[1].sourceHandle, 'true')  // 写了 port 的
})

test('toGraph 保留 onError，缺省是 fail', () => {
  const { nodes } = toGraph(DEF)
  assert.equal(nodes[2].data.onError, 'continue')
  const noOnError = { ...DEF, nodes: [{ ...DEF.nodes[0], onError: undefined as never }] }
  assert.equal(toGraph(noOnError).nodes[0].data.onError, 'fail')
})

test('toGraph 从 layout 取位置，缺省是原点', () => {
  const { nodes } = toGraph(DEF)
  assert.deepEqual(nodes[1].position, { x: 10, y: 20 })
  assert.deepEqual(toGraph({ ...DEF, layout: {} }).nodes[0].position, { x: 0, y: 0 })
})

test('toGraph 把 inputs schema 摊成流程入参列表，required 跟着走', () => {
  const { inputs } = toGraph(DEF)
  assert.deepEqual(inputs, [{ key: 'vid', title: '厂商', type: 'integer', required: true }])
})
