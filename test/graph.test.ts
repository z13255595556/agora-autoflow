import { test } from 'node:test'
import assert from 'node:assert/strict'
import { graphProblems } from '../src/lib/graph.ts'
import { toGraph } from '../src/lib/flowGraph.ts'
import type { FlowDefinition } from '../src/types.ts'

/**
 * 出边挂错口这件事**没有任何症状**：画布上看不出来（多出口节点根本不渲染
 * 'out' 这个 Handle，线会落在默认位置和真分支那条重叠），校验也全绿
 * （两条边的 signature 一个 'out' 一个 'true'，不算重复连线）。
 * 唯一的表现是条件分支不起作用 —— 这正是最难查的那一类。
 */

const def = (edges: FlowDefinition['edges']): FlowDefinition => ({
  id: 'f1', version: 1, name: 't',
  inputs: { type: 'object', properties: {} },
  trigger: { kind: 'manual' },
  nodes: [
    { id: 'n1', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' },
    { id: 'n2', type: 'flow.if', typeVersion: '1.0.0', name: '条件', params: {}, onError: 'fail' },
    { id: 'n3', type: 'notify.wecom', typeVersion: '1.0.0', name: '企微', params: {}, onError: 'fail' },
  ],
  edges,
  layout: {},
})

const problemsOf = (edges: FlowDefinition['edges']) => {
  const g = toGraph(def(edges))
  return graphProblems(g.nodes, g.edges).map((p) => p.message)
}

test('★ flow.if 的出边落在 out 上要报出来', () => {
  // 这条边就是「在连线中间插入条件分支」留下的：insertNodeOnEdge 以前把
  // sourceHandle 写死成 'out'，而 flow.if 的口是 true/false。
  const msgs = problemsOf([
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
  ])
  assert.ok(msgs.some((m) => m.includes('不存在的出口') && m.includes('true / false')), msgs.join(' | '))
})

test('挂在声明过的口上不报', () => {
  const msgs = problemsOf([
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3', port: 'true' },
  ])
  assert.deepEqual(msgs.filter((m) => m.includes('出口')), [])
})

test('单口节点省略 port 不报（默认就是 out）', () => {
  const msgs = problemsOf([{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3', port: 'false' }])
  assert.deepEqual(msgs.filter((m) => m.includes('出口')), [])
})

test('★ 反过来也拦：单口节点的边挂在 true 上同样是错的', () => {
  const msgs = problemsOf([{ from: 'n1', to: 'n2', port: 'true' }, { from: 'n2', to: 'n3', port: 'true' }])
  assert.ok(msgs.some((m) => m.includes('不存在的出口「true」') && m.includes('可用的是 out')), msgs.join(' | '))
})

test('终点节点（ports: []）不能有出边', () => {
  const msgs = problemsOf([
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3', port: 'true' },
    { from: 'n3', to: 'n2' },
  ])
  assert.ok(msgs.some((m) => m.includes('终点节点')), msgs.join(' | '))
})
