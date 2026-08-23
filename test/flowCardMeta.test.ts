import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowCardMeta } from '../src/lib/flowCardMeta.ts'
import { TEMPLATES } from '../src/lib/templates.ts'

test('日报模板卡片能看出 SQL 和企微', () => {
  const recipe = TEMPLATES.find((item) => item.key === 'scheduled-sql')!.build()
  const meta = flowCardMeta(recipe)
  assert.ok(meta.nodeLabels.includes('SQL'))
  assert.ok(meta.nodeLabels.includes('企微'))
  assert.equal(meta.scheduleText, '每天 09:00')
})

test('★ 本机没缓存过的流程是个没有 trigger 的壳，不能把首页炸掉', () => {
  // library.ts 对服务端有、本机没缓存的流程造的就是这个形状
  const shell = { id: 'x', name: 'x', nodes: [], edges: [], layout: {} } as unknown as Parameters<typeof flowCardMeta>[0]
  const meta = flowCardMeta(shell)
  assert.deepEqual(meta.nodeLabels, [])
  assert.equal(meta.scheduleText, null)
})
