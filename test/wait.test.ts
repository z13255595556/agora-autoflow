import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Edge } from '@xyflow/react'
import { mockOutput, plannedWaitSeconds } from '../src/lib/engine.ts'
import { validateNode } from '../src/lib/vars.ts'
import { WAIT_MAX_SECONDS } from '../src/lib/engine-core/types.ts'
import type { FNode } from '../src/store.ts'

/**
 * 等待节点的纯函数层：时长计算（固定/随机/夹上限）、mock 的确定性、保存期校验。
 * 真等待（waiting/sleep → 唤醒循环）在 worker.test.ts 里对着真库验。
 */

const NO_EDGES: Edge[] = []

const waitNode = (params: Record<string, unknown>): FNode => ({
  id: 'w1',
  position: { x: 0, y: 0 },
  data: { typeId: 'flow.wait', typeVersion: '1.0.0', label: '等待', params, onError: 'fail' },
})

// ---------------------------------------------------------------- plannedWaitSeconds

test('固定时长：随机数与结果无关', () => {
  assert.equal(plannedWaitSeconds({ mode: 'fixed', seconds: 300 }, 0), 300)
  assert.equal(plannedWaitSeconds({ mode: 'fixed', seconds: 300 }, 0.999), 300)
  // 模板解析常拿到数字字符串，要认
  assert.equal(plannedWaitSeconds({ mode: 'fixed', seconds: '45' }, 0), 45)
})

test('★ 上限在执行层真的夹一次 —— 表单的 maximum 拦不住模板和导入的 JSON', () => {
  assert.equal(plannedWaitSeconds({ mode: 'fixed', seconds: 99999 }, 0), WAIT_MAX_SECONDS)
  // 0 / 负数夹到 1，不是报错也不是「不等待语义之外的值」
  assert.equal(plannedWaitSeconds({ mode: 'fixed', seconds: 0 }, 0), 1)
  assert.equal(plannedWaitSeconds({ mode: 'fixed', seconds: -5 }, 0), 1)
})

test('解析不出秒数要报错，不许静默换成默认时长', () => {
  // 静默给默认值的症状是「运行莫名其妙慢了五分钟」，而且不知道该改哪
  assert.throws(() => plannedWaitSeconds({ mode: 'fixed', seconds: 'abc' }, 0), /等待时长/)
  assert.throws(() => plannedWaitSeconds({ mode: 'fixed' }, 0), /等待时长/)
  assert.throws(() => plannedWaitSeconds({ mode: 'random', minSeconds: 1 }, 0), /最长等待/)
})

test('随机时长：闭区间两端都取得到，越不了界', () => {
  assert.equal(plannedWaitSeconds({ mode: 'random', minSeconds: 2, maxSeconds: 5 }, 0), 2)
  assert.equal(plannedWaitSeconds({ mode: 'random', minSeconds: 2, maxSeconds: 5 }, 0.999), 5)
  // random01 按约定 < 1；传 1 进来也不许溢出到 hi+1
  assert.equal(plannedWaitSeconds({ mode: 'random', minSeconds: 2, maxSeconds: 5 }, 1), 5)
  assert.equal(plannedWaitSeconds({ mode: 'random', minSeconds: 7, maxSeconds: 7 }, 0.5), 7)
})

test('最短 > 最长是配置错误，报出来而不是悄悄交换', () => {
  assert.throws(() => plannedWaitSeconds({ mode: 'random', minSeconds: 10, maxSeconds: 3 }, 0), /不能大于/)
})

// ---------------------------------------------------------------- mockOutput

test('mock 不掷随机也不真等：同一份输入两次输出逐字相同', () => {
  const node = waitNode({ mode: 'random', minSeconds: 60, maxSeconds: 300 })
  const ctx = { trigger: {}, run: { id: 'r1', startedAt: '2026-08-30T00:00:00.000Z' }, nodes: {} }
  const a = mockOutput(node, ctx, node.data.params, NO_EDGES)
  const b = mockOutput(node, ctx, node.data.params, NO_EDGES)
  assert.deepEqual(a, b, 'mockOutput 的硬约束是无随机源 —— 回放测试建立在这上面')
  // 随机模式确定地取最短值；resumedAt 以运行开始时刻为基准（和 date.compute 同规则）
  assert.deepEqual(a, { waitSeconds: 60, resumedAt: '2026-08-30T00:01:00.000Z' })
})

// ---------------------------------------------------------------- validateNode

test('保存期校验跟着 mode 走：只查生效的那组字段', () => {
  assert.deepEqual(validateNode(waitNode({ mode: 'fixed', seconds: 300 }), [], NO_EDGES, []), [])
  assert.deepEqual(
    validateNode(waitNode({ mode: 'random', minSeconds: 60, maxSeconds: 300 }), [], NO_EDGES, []),
    [],
  )
  // fixed 模式下 minSeconds/maxSeconds 不生效，坏值不拦（x-show 同款语义）
  assert.deepEqual(
    validateNode(waitNode({ mode: 'fixed', seconds: 10, minSeconds: 99999999 }), [], NO_EDGES, []),
    [],
  )
})

test('字面量越界 / 缺填 / 最短大于最长，都在保存期拦下', () => {
  assert.ok(
    validateNode(waitNode({ mode: 'fixed', seconds: 99999 }), [], NO_EDGES, [])
      .some((e) => e.includes('1 小时')),
    '越界要说清上限是 1 小时',
  )
  assert.ok(
    validateNode(waitNode({ mode: 'fixed', seconds: '' }), [], NO_EDGES, [])
      .some((e) => e.includes('未填')),
  )
  assert.ok(
    validateNode(waitNode({ mode: 'random', minSeconds: 300, maxSeconds: 60 }), [], NO_EDGES, [])
      .some((e) => e.includes('不能大于')),
  )
})

test('引用值不拦：{{ }} 的实际秒数运行期才知道', () => {
  const node = waitNode({ mode: 'fixed', seconds: '{{ $.trigger.delay }}' })
  assert.deepEqual(validateNode(node, [node], NO_EDGES, [{ key: 'delay', title: '延迟', type: 'integer' }]), [])
})
