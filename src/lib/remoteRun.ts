import type { FlowRun, StepRun } from '../types.ts'
import * as api from './client.ts'

/**
 * 服务端运行：入队 + 按 seq 增量拉事件，折叠成前端已有的 FlowRun 形状。
 *
 * **UI 组件一行不用改** —— RunPanel / FlowNodeView / NodeDetailView 读的还是
 * 同一个 FlowRun。这是当初把 record() 设计成事件形状换来的红利。
 *
 * 用轮询而不是 SSE：事件本来就按 seq 增量拉取（断线重连带上最后收到的 seq，
 * 不丢也不重），SSE 只是省掉几次空请求。等真的嫌吵再换，接口契约不用动。
 */

export interface RemoteEvent {
  seq: number
  ts: string
  type: string
  nodeId: string | null
  loopPath: number[] | null
  payload: Record<string, unknown>
}

/** 服务端 7 态 → 前端 5 态。canceled 在 UI 上按 skipped 呈现（都是"没跑成"） */
function toStepStatus(s: string): StepRun['status'] {
  if (s === 'failed') return 'error'
  if (s === 'canceled') return 'skipped'
  if (s === 'queued' || s === 'waiting') return 'running'
  return s as StepRun['status']
}

function toRunStatus(s: string): FlowRun['status'] {
  if (s === 'success') return 'success'
  if (s === 'error' || s === 'canceled') return 'error'
  return 'running'
}

/** 服务端的一次运行 → 前端的 FlowRun */
export function toFlowRun(remote: api.RemoteRun): FlowRun {
  const steps: Record<string, StepRun[]> = {}
  for (const s of remote.steps ?? []) {
    const iteration = s.loopPath?.length ? s.loopPath[0] : undefined
    const list = steps[s.nodeId] ?? (steps[s.nodeId] = [])
    list.push({
      nodeId: s.nodeId,
      status: toStepStatus(s.status),
      startedAt: s.startedAt ? Date.parse(s.startedAt) : 0,
      durationMs: s.startedAt && s.finishedAt ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : 0,
      input: (s.input ?? {}) as Record<string, unknown>,
      output: s.output ?? null,
      ...(s.error ? { error: s.error } : {}),
      ...(iteration === undefined ? {} : { iteration }),
      // 跳过的原因带回来：「已暂停」和「分支没命中」在面板上要分得开
      ...(s.skipReason && typeof s.skipReason === 'object' ? { skipReason: s.skipReason as StepRun['skipReason'] } : {}),
      // 服务端跑的一律算真实执行；handle 不外泄，只说在不在等平台
      live: true,
      seq: s.seq,
    })
  }
  return {
    id: remote.id,
    status: toRunStatus(remote.status),
    startedAt: remote.startedAt ? Date.parse(remote.startedAt) : Date.parse(remote.createdAt),
    ...(remote.finishedAt ? { finishedAt: Date.parse(remote.finishedAt) } : {}),
    trigger: remote.triggerInput ?? {},
    steps,
    ...(remote.error ? { error: remote.error } : {}),
  }
}

export interface RemoteRunOptions {
  flowId: string
  inputs: Record<string, unknown>
  onUpdate: (run: FlowRun) => void
  signal?: AbortSignal
  /** 拉取间隔。慢查询动辄几分钟，1 秒足够，不必更密 */
  pollMs?: number
}

/**
 * 发起一次服务端运行并跟到终态。
 *
 * 中止时调 `POST /api/runs/{id}/cancel` —— **不是简单地停止轮询**：
 * 平台上的 Hive 任务要真的撤掉，不撤的话它继续跑完，白烧集群资源。
 */
export async function startRemoteRun(opts: RemoteRunOptions): Promise<FlowRun> {
  const { runId } = await api.createRun(opts.flowId, opts.inputs)

  const onAbort = () => { void api.cancelRun(runId) }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const interval = opts.pollMs ?? 1000
  try {
    for (;;) {
      const remote = await api.getRun(runId)
      const run = toFlowRun(remote)
      opts.onUpdate(run)
      if (remote.status === 'success' || remote.status === 'error' || remote.status === 'canceled') {
        return run
      }
      await new Promise((r) => setTimeout(r, interval))
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
