import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeFromPath } from '../src/lib/appRoute.ts'

test('首页和流程页路径解析', () => {
  assert.deepEqual(routeFromPath('/'), { kind: 'home' })
  assert.deepEqual(routeFromPath('/index.html'), { kind: 'home' })
  assert.deepEqual(routeFromPath('/workflows/flow_1'), { kind: 'editor', flowId: 'flow_1' })
  assert.deepEqual(routeFromPath('/nope'), { kind: 'invalid' })
  assert.deepEqual(routeFromPath('/workflows/'), { kind: 'invalid' })
})

test('首页深链：/?flow=…&run=… 直接打开那条运行记录（失败告警里的链接）', () => {
  assert.deepEqual(routeFromPath('/', '?flow=f1&run=r9'), { kind: 'home', openRun: { flowId: 'f1', runId: 'r9' } })
  assert.deepEqual(routeFromPath('/', 'flow=f1'), { kind: 'home', openRun: { flowId: 'f1' } })
  assert.deepEqual(routeFromPath('/', '?run=r9'), { kind: 'home' }, '没有 flow 就不知道开谁的记录')
  assert.deepEqual(routeFromPath('/', ''), { kind: 'home' })
  assert.deepEqual(routeFromPath('/workflows/f1', '?run=r9'), { kind: 'editor', flowId: 'f1' }, '编辑器路径不认 query')
})
