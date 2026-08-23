import type { Edge } from '@xyflow/react'
import { executeFlow } from '../../src/lib/engine.ts'
import type { FlowInputField, FlowRun, StepRun } from '../../src/types.ts'
import type { FNode } from '../../src/store.ts'

/**
 * golden 回放的最小骨架。
 *
 * 用途不是"测某个函数对不对"，而是**在重构 engine 期间持续证明行为没变**。
 * M1 要动 engine 的条目有二十多条（token 模型、join 判定、foreach 作用域、
 * 状态机），没有这层等于每一步都拿生产日报当测试用例。
 *
 * 三条设计约束：
 * 1. **全程离线**：isLive 固定成 false，绝不依赖 isOnline() 这个全局，
 *    也不发任何真实请求。CI 里没有后端。
 * 2. **完全确定**：runId / startedAtMs 注入固定值。mock 输出本身无随机源
 *    （原先那个 makeSeq 已经删掉了）。
 * 3. **比序列不比时间**：durationMs / startedAt 一律忽略，
 *    执行顺序靠 StepRun.seq 还原 —— 它在 FlowRun.steps 这个形状里本来是丢失的。
 */

export const FIXED_RUN_ID = 'run_golden'
export const FIXED_STARTED_AT = Date.UTC(2026, 7, 16, 1, 0, 0)

export interface GoldenFlow {
  name: string
  /** 这份用例钉死的是什么。改坏了看这句话就知道踩到哪条 */
  pins: string
  nodes: FNode[]
  edges: Edge[]
  flowInputs?: FlowInputField[]
  trigger?: Record<string, unknown>
  pinData?: Record<string, unknown>
}

/** 比较用的规范形态：只留会影响正确性的字段 */
export interface GoldenStep {
  nodeId: string
  iteration?: number
  status: StepRun['status']
  /** JSON 化，避免 deepEqual 在 undefined / null 上给出难读的 diff */
  output: string
  error?: string
  pinned?: boolean
}

export interface GoldenResult {
  runStatus: FlowRun['status']
  /** 按写入序号还原的执行序列 */
  order: string[]
  steps: GoldenStep[]
}

export function node(
  id: string,
  typeId: string,
  params: Record<string, unknown> = {},
  onError: 'fail' | 'continue' = 'fail',
  settings: { disabled?: boolean; note?: string } = {},
): FNode {
  return {
    id,
    type: 'flowNode',
    position: { x: 0, y: 0 },
    data: { typeId, typeVersion: '1.0.0', label: id, params, onError, ...settings },
  } as FNode
}

export function edge(from: string, to: string, port?: string): Edge {
  return {
    id: `${from}:${port ?? 'out'}->${to}`,
    source: from,
    target: to,
    // 显式 undefined 而不是 'out'：要能表达"这条边没带 handle"这个真实情况，
    // flow.if 的分支灭活对它有专门的行为（两侧都不灭活）
    ...(port === undefined ? {} : { sourceHandle: port }),
  } as Edge
}

/** 跑一份用例，产出可比较的规范形态 */
export async function runGolden(flow: GoldenFlow): Promise<GoldenResult> {
  const run = await executeFlow({
    nodes: flow.nodes,
    edges: flow.edges,
    trigger: flow.trigger ?? {},
    pinData: flow.pinData ?? {},
    flowInputs: flow.flowInputs ?? [],
    stepDelayMs: 0,
    runId: FIXED_RUN_ID,
    startedAtMs: FIXED_STARTED_AT,
    // 离线：不碰 isOnline()，所有节点走 mock
    isLive: () => false,
    onStep: () => {},
    onRunUpdate: () => {},
  })

  const flat = Object.values(run.steps).flat().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return {
    runStatus: run.status,
    order: flat.map((s) => (s.iteration === undefined ? s.nodeId : `${s.nodeId}#${s.iteration}`)),
    steps: flat.map((s) => ({
      nodeId: s.nodeId,
      ...(s.iteration === undefined ? {} : { iteration: s.iteration }),
      status: s.status,
      output: JSON.stringify(s.output),
      ...(s.error ? { error: s.error } : {}),
      ...(s.pinned ? { pinned: true } : {}),
    })),
  }
}

/** 取某个节点最后一次执行的记录 */
export function stepOf(r: GoldenResult, nodeId: string, iteration?: number): GoldenStep | undefined {
  const hits = r.steps.filter((s) => s.nodeId === nodeId && (iteration === undefined || s.iteration === iteration))
  return hits.at(-1)
}

export function outputOf<T = unknown>(r: GoldenResult, nodeId: string, iteration?: number): T | undefined {
  const s = stepOf(r, nodeId, iteration)
  return s ? (JSON.parse(s.output) as T) : undefined
}
