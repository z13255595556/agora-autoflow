import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Edge } from '@xyflow/react'
import { executeFlow } from '../src/lib/engine.ts'
import type { FlowRun, StepRun } from '../src/types.ts'
import type { FNode } from '../src/store.ts'

/**
 * 一次运行必须可复现。
 *
 * 这是 golden 回放测试的前提：没有它，"新引擎和旧引擎行为一致"根本无从比起。
 * 挡住的是三种不确定性：
 * 1. run.id 与 startedAt 取当下 —— 而 startedAt 是 date() 的基准，
 *    跨零点跑会算出不同的日期
 * 2. 执行顺序在 FlowRun.steps 里不存在（Record<nodeId, StepRun[]>，组间无序），
 *    stepDelayMs=0 时所有 startedAt 挤在同一毫秒，拿时间戳也排不出来
 * 3. mock 输出的伪随机源
 */

const node = (id: string, typeId: string, params: Record<string, unknown> = {}): FNode =>
  ({
    id,
    type: 'flowNode',
    position: { x: 0, y: 0 },
    data: { typeId, typeVersion: '1.0.0', label: id, params, onError: 'fail' },
  }) as FNode

const edge = (from: string, to: string, port?: string): Edge =>
  ({ id: `${from}-${to}`, source: from, target: to, sourceHandle: port ?? 'out' }) as Edge

/** 直线：手动触发 → 算日期 → 拼文本 */
const NODES = [
  node('n1', 'trigger.manual'),
  node('n2', 'date.compute', { mode: 'yesterday', format: 'compact' }),
  node('n3', 'transform.template', {
    template: '日期 {{ $.nodes.n2.output.value }} 运行 {{ $.run.id }}',
  }),
]
const EDGES = [edge('n1', 'n2'), edge('n2', 'n3')]

async function run(opts: { runId?: string; startedAtMs?: number; nodes?: FNode[] } = {}): Promise<FlowRun> {
  let last: FlowRun | null = null
  const got = await executeFlow({
    nodes: opts.nodes ?? NODES,
    edges: EDGES,
    trigger: {},
    pinData: {},
    flowInputs: [],
    stepDelayMs: 0,
    runId: opts.runId,
    startedAtMs: opts.startedAtMs,
    onStep: () => {},
    onRunUpdate: (r) => { last = r },
  })
  assert.ok(last, 'onRunUpdate 至少要被调一次')
  return got
}

/** 按写入序号还原执行序列 —— 这正是 steps 这个形状里丢掉的信息 */
function sequence(r: FlowRun): Array<Pick<StepRun, 'nodeId' | 'iteration' | 'status'> & { output: string }> {
  return Object.values(r.steps)
    .flat()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((s) => ({
      nodeId: s.nodeId,
      iteration: s.iteration,
      status: s.status,
      output: JSON.stringify(s.output),
    }))
}

const FIXED = { runId: 'run_fixed', startedAtMs: Date.UTC(2026, 7, 16, 1, 0, 0) }

test('注入 runId / startedAtMs 后两次运行逐字段相同', async () => {
  const a = await run(FIXED)
  const b = await run(FIXED)
  assert.deepEqual(sequence(a), sequence(b))
  assert.equal(a.id, 'run_fixed')
  assert.equal(a.startedAt, FIXED.startedAtMs)
})

test('startedAt 真的被 date() 当基准用了', async () => {
  // 不是摆设：跨零点跑会算出不同日期，而"一次运行里所有日期必须同源"是
  // resolveCall 锁 run.startedAt 的全部理由
  const day1 = await run({ ...FIXED, startedAtMs: Date.UTC(2026, 7, 16, 1, 0, 0) })
  const day2 = await run({ ...FIXED, startedAtMs: Date.UTC(2026, 7, 20, 1, 0, 0) })
  const of = (r: FlowRun) => r.steps.n2?.at(-1)?.output as { value?: string } | undefined
  assert.notEqual(of(day1)?.value, of(day2)?.value)
})

test('seq 单调递增且覆盖每一条写入', async () => {
  const r = await run(FIXED)
  const seqs = Object.values(r.steps).flat().map((s) => s.seq)
  assert.ok(seqs.every((s) => typeof s === 'number'), '每条 StepRun 都要有 seq')
  // record() 对同一 (nodeId, iteration) 是原地覆盖，所以留下来的是最后一次写入的号
  const sorted = [...seqs as number[]].sort((a, b) => a - b)
  assert.deepEqual(new Set(sorted).size, sorted.length, 'seq 不能重复')
})

test('执行顺序按 seq 还原出来是拓扑序', async () => {
  const r = await run(FIXED)
  assert.deepEqual(sequence(r).map((s) => s.nodeId), ['n1', 'n2', 'n3'])
})

test('不传 runId / startedAtMs 时行为和以前一样（各自生成）', async () => {
  const a = await run()
  const b = await run()
  assert.match(a.id, /^run_/)
  assert.notEqual(a.id, b.id, '不注入时两次运行应当是不同的 id')
})

test('打乱 nodes 数组顺序不改变结果（拓扑关系不变）', async () => {
  const straight = await run(FIXED)
  const shuffled = await run({ ...FIXED, nodes: [NODES[2], NODES[0], NODES[1]] })
  assert.deepEqual(sequence(straight), sequence(shuffled))
})

test('模板里的 $.run.id 用的是注入的那个', async () => {
  const r = await run(FIXED)
  const text = (r.steps.n3?.at(-1)?.output as { text?: string })?.text ?? ''
  assert.match(text, /run_fixed/)
})
