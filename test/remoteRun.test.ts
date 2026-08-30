import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stallMessage, toFlowRun } from '../src/lib/remoteRun.ts'

const STALL = 8000

// ---------------------------------------------------------------- 卡在没有 worker 上

test('★ 一直 queued 就是没人接手 —— 到点必须喊出来，否则界面只是永远转圈', () => {
  const said = stallMessage('queued', STALL, STALL)
  assert.ok(said)
  // 话要说到"去起 worker"这一步：只说"排队中"等于没说
  assert.match(said, /npm run worker/)
})

test('★ 一直 canceling 就是没人收尾 —— 这正是「点停止无效」的真身', () => {
  const said = stallMessage('canceling', STALL, STALL)
  assert.ok(said)
  assert.match(said, /npm run worker/)
  // 和排队那句必须分得开：一个是没开始，一个是停不下来
  assert.notEqual(said, stallMessage('queued', STALL, STALL))
})

test('running 再久也不喊 —— 慢查询本来就该等，喊它是噪音', () => {
  assert.equal(stallMessage('running', 10 * 60 * 1000, STALL), null)
})

test('没到点不喊', () => {
  assert.equal(stallMessage('queued', STALL - 1, STALL), null)
})

test('终态不喊', () => {
  for (const status of ['success', 'error', 'canceled']) {
    assert.equal(stallMessage(status, STALL * 10, STALL), null, status)
  }
})

// ---------------------------------------------------------------- canceling 的呈现

test('★ canceling 在前端算「进行中」—— 它确实还没停下来，不能显示成已结束', () => {
  const run = toFlowRun({
    id: 'run_1', flowId: 'f', flowVersion: 1, status: 'canceling', mode: 'manual',
    triggerKind: 'manual', triggerInput: {}, createdAt: '2026-08-29T00:00:00+08:00',
    startedAt: null, finishedAt: null, error: null, attempt: 0, steps: [],
  } as never)
  assert.equal(run.status, 'running')
})
