import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edge, node, runGolden, type GoldenFlow, type GoldenResult } from './golden/harness.ts'
import { runViaDecide } from './golden/decideRunner.ts'
import { DIVERGENCES } from './golden/divergence.ts'

/**
 * **新旧两个引擎在同一批图上逐步等价。**
 *
 * 这是"decide() 真的能替代 executeFlow"的唯一证据。decide 自己的性质测试
 * （纯、幂等、不相交）证明的是它自身，不证明它和现有行为一致。
 *
 * decideRunner 每 tick 都从 steps 表全量重算、不留跨 tick 内存状态 ——
 * 所以两者结果一致这件事，同时也是"节点边界即存档点"在没有数据库的情况下
 * 能拿到的最强证据：中间任何一步换个进程接着算，结果不变。
 */

/** 只比会影响正确性的部分：状态 + 输出 + 错误。skipped 之间没有先后语义 */
function comparable(r: GoldenResult) {
  return {
    runStatus: r.runStatus,
    // 排序后比较：跑了什么、各自产出什么必须一致，但**执行顺序不在这里比**。
    // 顺序由 golden.test.ts 各自的用例钉住；两个模型在 foreach 上有一处
    // 有意的顺序差异（见 divergence 表），内容完全相同
    ran: r.steps
      .filter((s) => s.status !== 'skipped')
      .map((s) => `${s.nodeId}${s.iteration === undefined ? '' : `#${s.iteration}`}=${s.status}:${s.output}`)
      .sort(),
    skipped: r.steps
      .filter((s) => s.status === 'skipped')
      .map((s) => `${s.nodeId}${s.iteration === undefined ? '' : `#${s.iteration}`}`)
      .sort(),
  }
}

async function bothAgree(name: string, flow: GoldenFlow) {
  const [old_, next] = [await runGolden(flow), await runViaDecide(flow)]
  assert.deepEqual(comparable(next), comparable(old_), `${name}：两个引擎结果必须一致`)
}

// ---------------------------------------------------------------- 等价的用例

test('直线流程两个引擎一致', async () => {
  await bothAgree('straight', {
    name: 'straight',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('d', 'date.compute', { mode: 'yesterday', format: 'compact' }),
      node('m', 'transform.template', { template: '日期 {{ $.nodes.d.output.value }}' }),
    ],
    edges: [edge('t', 'd'), edge('d', 'm')],
  })
})

test('★ if 分支灭活两个引擎一致（含 merge 的下标占位）', async () => {
  await bothAgree('diamond', {
    name: 'diamond',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('i', 'flow.if', { condition: 'false' }),
      node('a', 'transform.template', { template: 'A' }),
      node('b', 'transform.template', { template: 'B' }),
      node('m', 'flow.merge'),
    ],
    edges: [edge('t', 'i'), edge('i', 'a', 'true'), edge('i', 'b', 'false'), edge('a', 'm'), edge('b', 'm')],
  })
})

test('★ 汇合点还有别的活路径时两个引擎一致', async () => {
  await bothAgree('diamond-extra', {
    name: 'diamond-extra',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('i', 'flow.if', { condition: 'false' }),
      node('a', 'transform.template', { template: 'A' }),
      node('m', 'flow.merge'),
    ],
    edges: [edge('t', 'i'), edge('i', 'a', 'true'), edge('a', 'm'), edge('t', 'm')],
  })
})

test('★ 全局 fail-fast 两个引擎一致（无关分支也停）', async () => {
  await bothAgree('failfast', {
    name: 'failfast',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('bad', 'transform.template', { template: '{{ $.nodes.nope.output.x }}' }),
      node('other', 'transform.template', { template: '无关' }),
    ],
    edges: [edge('t', 'bad'), edge('t', 'other')],
  })
})

test('★ onError=continue 的下游可达性两个引擎一致', async () => {
  await bothAgree('continue', {
    name: 'continue',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('bad', 'transform.template', { template: '{{ $.nodes.nope.output.x }}' }, 'continue'),
      node('down', 'transform.template', { template: '{{ $.nodes.bad.output.text }}' }),
    ],
    edges: [edge('t', 'bad'), edge('bad', 'down')],
  })
})

test('游离节点两个引擎一致', async () => {
  await bothAgree('orphan', {
    name: 'orphan',
    pins: '',
    nodes: [node('t', 'trigger.manual'), node('x', 'transform.template', { template: 'X' })],
    edges: [],
  })
})

test('pinData 两个引擎一致', async () => {
  await bothAgree('pin', {
    name: 'pin',
    pins: '',
    nodes: [node('t', 'trigger.manual'), node('w', 'notify.wecom', { msgtype: 'text', content: 'x' })],
    edges: [edge('t', 'w')],
    pinData: { w: { sent: true, bytes: 1, target: 'pinned' } },
  })
})

test('★ 循环正常展开时两个引擎一致', async () => {
  await bothAgree('loop', {
    name: 'loop',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('q', 'variable.assign', { values: { rows: [{ v: 1 }, { v: 2 }, { v: 3 }] } }),
      node('lp', 'flow.foreach', { items: '{{ $.nodes.q.output.values.rows }}' }),
      node('b', 'transform.template', { template: '第 {{ $.loop.index }} 项' }),
      node('after', 'transform.template', { template: '完了' }),
    ],
    edges: [edge('t', 'q'), edge('q', 'lp'), edge('lp', 'b', 'each'), edge('lp', 'after', 'done')],
  })
})

test('★ 循环 items 非法时两个引擎一致（整节点失败）', async () => {
  await bothAgree('loop-bad-items', {
    name: 'loop-bad-items',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('q', 'variable.assign', { values: { n: 1 } }),
      node('lp', 'flow.foreach', { items: '{{ $.nodes.q.output.values.n }}' }),
      node('b', 'transform.template', { template: 'x' }),
    ],
    edges: [edge('t', 'q'), edge('q', 'lp'), edge('lp', 'b', 'each')],
  })
})

// ---------------------------------------------------------------- 已登记的差异

test('★★ 循环展开 0 项：两个引擎的差异必须正好是登记过的那一条', async () => {
  const flow: GoldenFlow = {
    name: 'loop-empty',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('q', 'variable.assign', { values: { rows: [] } }),
      node('lp', 'flow.foreach', { items: '{{ $.nodes.q.output.values.rows }}' }),
      node('send', 'transform.template', { template: '发一条' }),
      node('after', 'transform.template', { template: '完了' }),
    ],
    edges: [edge('t', 'q'), edge('q', 'lp'), edge('lp', 'send', 'each'), edge('lp', 'after', 'done')],
  }
  const [old_, next] = [await runGolden(flow), await runViaDecide(flow)]

  // 两个方向都要成立：既不许多发，也不许把 done 支路一起吞掉
  const ran = (r: GoldenResult, id: string) => r.steps.filter((s) => s.nodeId === id && s.status !== 'skipped').length
  assert.equal(ran(old_, 'send'), 0, '旧引擎：each 末端零执行')
  assert.equal(ran(next, 'send'), 0, '★ 新模型：each 末端同样零执行')
  assert.equal(ran(old_, 'after'), 1, '旧引擎：done 子树照跑')
  assert.equal(ran(next, 'after'), 1, '新模型：done 子树照跑')

  // 登记过的差异：新模型给 send 留了一条 skipped 记录，旧引擎完全没有条目
  const skippedOld = old_.steps.some((s) => s.nodeId === 'send' && s.status === 'skipped')
  const skippedNew = next.steps.some((s) => s.nodeId === 'send' && s.status === 'skipped')
  assert.equal(skippedOld, false, '旧引擎确实一条记录都没有')
  assert.equal(skippedNew, true, '★ 登记的差异必须真的发生 —— 没发生说明这张表是谎言')
})

test('divergence 表每条都有理由', () => {
  assert.ok(DIVERGENCES.length > 0)
  for (const d of DIVERGENCES) {
    assert.ok(d.why.length > 40, `${d.fixture} 的 why 太短，没有理由的差异不是差异是 bug`)
    assert.ok(d.before && d.after)
  }
})

test('★ 暂停的节点两个引擎一致：下游照跑，暂停的记 skipped', async () => {
  await bothAgree('paused', {
    name: 'paused',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('a', 'transform.template', { template: 'A' }, 'fail', { disabled: true }),
      node('b', 'transform.template', { template: 'B' }),
    ],
    edges: [edge('t', 'a'), edge('a', 'b')],
  })
})

test('★ 循环体内暂停的节点两个引擎一致', async () => {
  await bothAgree('paused-in-loop', {
    name: 'paused-in-loop',
    pins: '',
    nodes: [
      node('t', 'trigger.manual'),
      node('v', 'variable.assign', { values: { rows: [{ v: 1 }, { v: 2 }] } }),
      node('lp', 'flow.foreach', { items: '{{ $.nodes.v.output.values.rows }}' }),
      node('body', 'transform.template', { template: 'x{{ $.loop.index }}' }, 'fail', { disabled: true }),
      node('after', 'transform.template', { template: 'done' }),
    ],
    edges: [edge('t', 'v'), edge('v', 'lp'), edge('lp', 'body', 'each'), edge('lp', 'after', 'done')],
  })
})
