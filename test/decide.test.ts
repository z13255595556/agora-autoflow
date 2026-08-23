import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, type DecideInput, type DecideStep } from '../src/lib/engine-core/decide.ts'
import { stepKeyOf } from '../src/lib/engine-core/types.ts'
import { edge, node } from './golden/harness.ts'

/**
 * decide() 的性质测试。
 *
 * 前三条是**契约**，不是功能：worker 崩溃重启后要从库里的 steps 重算下一步，
 * 算出来的必须和崩之前一致。不纯、不幂等、或者 toRun/toSkip 相交，
 * 都会表现成"要么漏跑要么重跑"，而重跑一个 notify.wecom 就是群里多一条消息。
 */

const line = (): DecideInput => ({
  nodes: [
    node('t', 'trigger.manual'),
    node('a', 'transform.template', { template: 'A' }),
    node('b', 'transform.template', { template: 'B' }),
  ],
  edges: [edge('t', 'a'), edge('a', 'b')],
  run: { status: 'running' },
  steps: [],
})

const withSteps = (base: DecideInput, steps: DecideStep[]): DecideInput => ({ ...base, steps })
const S = (nodeId: string, status: DecideStep['status'], extra: Partial<DecideStep> = {}): DecideStep =>
  ({ nodeId, loopPath: [], status, ...extra })

// ---------------------------------------------------------------- 契约

test('★ 纯：深冻结输入不抛，且不读时钟', () => {
  const input = line()
  const frozen = Object.freeze({
    ...input,
    nodes: Object.freeze(input.nodes.map((n) => Object.freeze(n))),
    edges: Object.freeze(input.edges),
    steps: Object.freeze([]),
    run: Object.freeze(input.run),
  }) as DecideInput

  const realNow = Date.now
  Date.now = () => { throw new Error('decide 不许读时钟') }
  try {
    assert.doesNotThrow(() => decide(frozen))
  } finally {
    Date.now = realNow
  }
})

test('★ 幂等：同一份输入连调两次结果完全相同', () => {
  // 这条同时钉死"roots 计算随 dead 集合增长而漂移"那个坑
  const input = withSteps(line(), [S('t', 'success')])
  assert.deepEqual(JSON.stringify(decide(input)), JSON.stringify(decide(input)))
})

test('★ toRun 与 toSkip 恒不相交', () => {
  const cases: DecideInput[] = [
    line(),
    withSteps(line(), [S('t', 'success')]),
    withSteps(line(), [S('t', 'failed')]),
    withSteps(line(), [S('t', 'success'), S('a', 'skipped')]),
    withSteps(line(), [S('t', 'canceled')]),
  ]
  for (const c of cases) {
    const r = decide(c)
    const runKeys = new Set(r.toRun.map(stepKeyOf))
    for (const s of r.toSkip) assert.ok(!runKeys.has(stepKeyOf(s)), `${stepKeyOf(s)} 同时出现在两边`)
  }
})

// ---------------------------------------------------------------- 推进

test('空 steps 时只有触发器可跑', () => {
  const r = decide(line())
  assert.deepEqual(r.toRun.map((x) => x.nodeId), ['t'])
  assert.equal(r.progress, 'advanced')
})

test('上游成功后下游就绪，再下游仍在等', () => {
  const r = decide(withSteps(line(), [S('t', 'success')]))
  assert.deepEqual(r.toRun.map((x) => x.nodeId), ['a'])
  assert.deepEqual(r.blocked.map((x) => x.nodeId), ['b'])
  assert.deepEqual(r.blocked[0].waitingOn, ['a'], '要说清在等谁')
})

test('running / waiting 的行不重复下发', () => {
  for (const st of ['running', 'waiting'] as const) {
    const r = decide(withSteps(line(), [S('t', 'success'), S('a', st)]))
    assert.equal(r.toRun.length, 0, `${st} 的行不该再被下发`)
  }
})

test('全部终态 → finished=success', () => {
  const r = decide(withSteps(line(), [S('t', 'success'), S('a', 'success'), S('b', 'success')]))
  assert.equal(r.finished, 'success')
})

// ---------------------------------------------------------------- 错误传播

test('★ 全局 fail-fast：无关的并行分支也进 toSkip', () => {
  const input: DecideInput = {
    nodes: [node('t', 'trigger.manual'), node('bad', 'transform.template'), node('other', 'transform.template')],
    edges: [edge('t', 'bad'), edge('t', 'other')],
    run: { status: 'running' },
    steps: [S('t', 'success'), S('bad', 'failed')],
  }
  const r = decide(input)
  assert.ok(r.toSkip.some((s) => s.nodeId === 'other'), '与失败点无关的分支也要停')
  assert.equal(r.toRun.length, 0)
})

test('★ 源节点 onError=continue 时不触发 fail-fast，下游照常就绪', () => {
  const input: DecideInput = {
    nodes: [
      node('t', 'trigger.manual'),
      node('bad', 'transform.template', {}, 'continue'),
      node('down', 'transform.template'),
    ],
    edges: [edge('t', 'bad'), edge('bad', 'down')],
    run: { status: 'running' },
    steps: [S('t', 'success'), S('bad', 'failed')],
  }
  const r = decide(input)
  assert.deepEqual(r.toRun.map((x) => x.nodeId), ['down'], '有 step 且要跑，不是 skipped')
})

test('★ canceled 的源不算活，下游进 toSkip', () => {
  // 取消过程中 reaper 把在跑的行写成 canceled（终态、非 skipped）。
  // 用"非 skipped 就算活"这条规则，下游的 notify.wecom 会在取消中真发消息
  const input: DecideInput = {
    nodes: [node('t', 'trigger.manual'), node('w', 'notify.wecom')],
    edges: [edge('t', 'w')],
    run: { status: 'running' },
    steps: [S('t', 'canceled')],
  }
  const r = decide(input)
  assert.equal(r.toRun.length, 0, 'canceled 的下游绝不能跑')
  assert.ok(r.toSkip.some((s) => s.nodeId === 'w'))
})

// ---------------------------------------------------------------- 取消

test('★ canceling：不新起任何节点，正在跑的进 toCancel', () => {
  const input: DecideInput = {
    nodes: [node('t', 'trigger.manual'), node('q', 'sql.query'), node('w', 'notify.wecom')],
    edges: [edge('t', 'q'), edge('q', 'w')],
    run: { status: 'canceling' },
    steps: [S('t', 'success'), S('q', 'waiting')],
  }
  const r = decide(input)
  assert.equal(r.toRun.length, 0, '取消中一个都不许新起')
  assert.deepEqual(r.toCancel.map((x) => x.nodeId), ['q'], '在等平台结果的要撤掉')
  assert.ok(r.toSkip.some((s) => s.nodeId === 'w'))
})

test('★ 取消时下游企微节点不会被下发（否则取消反而多发一条）', () => {
  const input: DecideInput = {
    nodes: [node('t', 'trigger.manual'), node('w', 'notify.wecom')],
    edges: [edge('t', 'w')],
    run: { status: 'canceling' },
    steps: [S('t', 'success')],
  }
  assert.equal(decide(input).toRun.length, 0)
})

test('canceling 且全部终态 → finished=canceled', () => {
  const input: DecideInput = {
    nodes: [node('t', 'trigger.manual')],
    edges: [],
    run: { status: 'canceling' },
    steps: [S('t', 'success')],
  }
  assert.equal(decide(input).finished, 'canceled')
})

// ---------------------------------------------------------------- 循环作用域

const loopGraph = (fanout?: number): DecideInput => ({
  nodes: [
    node('t', 'trigger.manual'),
    node('lp', 'flow.foreach', { items: '{{ $.x }}' }),
    node('send', 'notify.wecom'),
    node('after', 'transform.template'),
  ],
  edges: [edge('t', 'lp'), edge('lp', 'send', 'each'), edge('lp', 'after', 'done')],
  run: { status: 'running' },
  steps: [S('t', 'success'), { nodeId: 'lp', loopPath: [], status: 'success', ...(fanout === undefined ? {} : { fanout }) }],
})

test('★★ 循环展开 3 次 → each 末端跑 3 次，且都在带下标的路径上', () => {
  const r = decide(loopGraph(3))
  const sends = r.toRun.filter((x) => x.nodeId === 'send')
  assert.equal(sends.length, 3)
  assert.deepEqual(sends.map((x) => x.loopPath), [[0], [1], [2]])
  assert.ok(!sends.some((x) => x.loopPath.length === 0), '绝不许出现顶层路径的那一次')
})

test('★★ 三次迭代都跑完之后，不许再有第 4 次', () => {
  // 这是"局部 join 规则对 foreach 不成立"的那个反例：loop 置 success 之后，
  // 只看"唯一入边源已终态且非 skipped"会判 send 就绪，loopPath 取默认 {}，
  // 与已有的 {0}/{1}/{2} 主键不冲突 → 第 4 条企微消息发出去，运行记录还是绿的
  const base = loopGraph(3)
  const done: DecideStep[] = [
    ...base.steps,
    { nodeId: 'send', loopPath: [0], status: 'success' },
    { nodeId: 'send', loopPath: [1], status: 'success' },
    { nodeId: 'send', loopPath: [2], status: 'success' },
  ]
  const r = decide({ ...base, steps: done })
  assert.equal(r.toRun.filter((x) => x.nodeId === 'send').length, 0, '★ 不许多发第 4 条')
  assert.deepEqual(r.toRun.map((x) => x.nodeId), ['after'], 'done 子树照跑')
})

test('★★ fanout=0：each 末端一次都不跑，done 子树照跑', () => {
  // 两个方向都要断言。Hive 返回 0 行时，今天是"一条都不发"；
  // 换成局部规则会变成"发一条本不该发的"—— 从静默不发翻成静默错发
  const r = decide(loopGraph(0))
  assert.equal(r.toRun.filter((x) => x.nodeId === 'send').length, 0)
  assert.ok(r.toSkip.some((s) => s.nodeId === 'send' && s.reason.kind === 'no_iterations'))
  assert.ok(r.toRun.some((x) => x.nodeId === 'after'), 'done 支路不许被一起吞掉')
})

test('foreach 还没展开时体内节点不动', () => {
  const r = decide(loopGraph(undefined))
  assert.equal(r.toRun.filter((x) => x.nodeId === 'send').length, 0)
})

// ---------------------------------------------------------------- 卡住

test('★ 有环图报 stuck 而不是干等', () => {
  // 局部规则在环上没有不动点：环里每个节点都在等前驱到终态。
  // 不返回 stuck 的话 run 会永久停在 running —— reaper 只扫 running/waiting
  // 的行，一行都没有，谁也碰不到它
  const input: DecideInput = {
    nodes: [node('t', 'trigger.manual'), node('a', 'transform.template'), node('b', 'transform.template')],
    edges: [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
    run: { status: 'running' },
    steps: [S('t', 'success')],
  }
  const r = decide(input)
  assert.equal(r.toRun.length, 0)
  assert.equal(r.progress, 'stuck')
  assert.equal(r.finished, undefined, 'stuck 不是完成')
})

test('便签不参与任何判定', () => {
  const input: DecideInput = {
    nodes: [node('t', 'trigger.manual'), node('note', 'canvas.note'), node('a', 'transform.template')],
    edges: [edge('t', 'a')],
    run: { status: 'running' },
    steps: [S('t', 'success')],
  }
  const r = decide(input)
  assert.ok(!r.toRun.some((x) => x.nodeId === 'note'))
  assert.ok(!r.toSkip.some((x) => x.nodeId === 'note'))
})

// ---------------------------------------------------------------- 暂停（活着但不跑）

test('★ 暂停的节点记成 skipped{disabled}，但要等上游到终态之后', () => {
  const base = line()
  const paused = {
    ...base,
    nodes: [base.nodes[0], node('a', 'transform.template', { template: 'A' }, 'fail', { disabled: true }), base.nodes[2]],
  }
  // 触发器还没跑：a 的入边源非终态，a 该 blocked 而不是被提前记成 skipped ——
  // 否则 b 会拿一个"终态"的源去判，把 pending 当成 dead
  const r0 = decide(paused)
  assert.ok(!r0.toSkip.some((s) => s.nodeId === 'a'))
  assert.ok(r0.blocked.some((b) => b.nodeId === 'a'))

  const r1 = decide(withSteps(paused, [S('t', 'success')]))
  assert.ok(!r1.toRun.some((x) => x.nodeId === 'a'), '暂停的节点不跑')
  const skip = r1.toSkip.find((s) => s.nodeId === 'a')
  assert.equal(skip?.reason.kind, 'disabled')
})

test('★★ 暂停对下游透明：a 暂停，b 照跑；a 的上游死了，b 也死', () => {
  const base = line()
  const paused = {
    ...base,
    nodes: [base.nodes[0], node('a', 'transform.template', { template: 'A' }, 'fail', { disabled: true }), base.nodes[2]],
  }
  const r = decide(withSteps(paused, [
    S('t', 'success'),
    S('a', 'skipped', { skipReason: { kind: 'disabled' } }),
  ]))
  assert.deepEqual(r.toRun.map((x) => x.nodeId), ['b'], '上游活 → 暂停节点的下游照跑')

  // 同样的 skipped，但原因是 unreachable —— 下游必须跟着死。两种 skipped 在 status 上一样，
  // 靠 skipReason 分辨；没有它两个引擎就会对"暂停"给出不同答案
  const r2 = decide(withSteps(paused, [
    S('t', 'success'),
    S('a', 'skipped', { skipReason: { kind: 'unreachable' } }),
  ]))
  assert.ok(!r2.toRun.some((x) => x.nodeId === 'b'))
  assert.ok(r2.toSkip.some((s) => s.nodeId === 'b'))
})

test('条件 / 循环 / 触发器上的 disabled 被忽略 —— 引擎要读它们的判定结果', () => {
  const input: DecideInput = {
    nodes: [
      node('t', 'trigger.manual', {}, 'fail', { disabled: true }),
      node('i', 'flow.if', { condition: 'true' }, 'fail', { disabled: true }),
      node('a', 'transform.template', { template: 'A' }),
    ],
    edges: [edge('t', 'i'), edge('i', 'a', 'true')],
    run: { status: 'running' },
    steps: [],
  }
  const r0 = decide(input)
  assert.ok(r0.toRun.some((x) => x.nodeId === 't'), '触发器照跑')
  const r1 = decide(withSteps(input, [S('t', 'success')]))
  assert.ok(r1.toRun.some((x) => x.nodeId === 'i'), 'flow.if 照跑，否则下游永远 stuck')
})

test('暂停的节点跑完整条之后 run 是 success，不是 error', () => {
  const base = line()
  const paused = {
    ...base,
    nodes: [base.nodes[0], node('a', 'transform.template', { template: 'A' }, 'fail', { disabled: true }), base.nodes[2]],
  }
  const r = decide(withSteps(paused, [
    S('t', 'success'),
    S('a', 'skipped', { skipReason: { kind: 'disabled' } }),
    S('b', 'success'),
  ]))
  assert.equal(r.finished, 'success')
})
