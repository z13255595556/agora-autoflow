import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayRunStatus, isRunActive, stallMessage, toFlowRun } from '../src/lib/remoteRun.ts'

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

// ---------------------------------------------------------------- 运行记录面板的可停止判定
//
// 服务端**有意**不把在跑的 run 改成 canceling（取消是过程不是瞬间），
// 「取消中」靠 cancelRequestedAt 推导。这两个函数钉死推导规则和按钮的
// 出现条件 —— 组件没有渲染测试，这里是唯一的门禁。

test('★ 停止按钮恰好出现在 queued / running / canceling 三态', () => {
  // canceling 也在场（disabled）：点完就消失的话，
  // 用户分不清「停完了」和「按钮忽然没了」
  const want: Record<string, boolean> = {
    queued: true, running: true, canceling: true,
    success: false, error: false, canceled: false,
  }
  for (const [status, active] of Object.entries(want)) {
    assert.equal(isRunActive(status), active, status)
  }
})

test('★ 活着的 run 带取消时间戳 → 显示「取消中」', () => {
  assert.equal(displayRunStatus({ status: 'running', cancelRequestedAt: '2026-09-01T00:00:00Z' }), 'canceling')
  assert.equal(displayRunStatus({ status: 'queued', cancelRequestedAt: '2026-09-01T00:00:00Z' }), 'canceling')
})

test('没请求取消的照原样显示', () => {
  assert.equal(displayRunStatus({ status: 'running', cancelRequestedAt: null }), 'running')
  assert.equal(displayRunStatus({ status: 'queued' }), 'queued')
  assert.equal(displayRunStatus({ status: 'canceling' }), 'canceling')
})

test('★ 终态即使带取消时间戳也照终态显示 —— 取消赶在结束之后到就是没取消成，不许把 success 画成已取消', () => {
  for (const status of ['success', 'error', 'canceled']) {
    assert.equal(displayRunStatus({ status, cancelRequestedAt: '2026-09-01T00:00:00Z' }), status)
  }
})
