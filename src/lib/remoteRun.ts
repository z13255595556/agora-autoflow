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
      // 等待节点睡到几点：没有它，一小时的等待在面板上就是一个干转的「…」
      ...(s.waitKind === 'sleep' && s.resumeAt ? { resumeAt: Date.parse(s.resumeAt) } : {}),
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
  /**
   * 卡在「没有 worker 接手」上了。**只喊一次**，喊完继续轮询 ——
   * worker 起来之后这条运行会照常被捡走，不该替用户判死。
   */
  onStall?: (message: string) => void
  /** 卡多久算卡住。默认 8 秒：worker 一轮 tick 是秒级，8 秒还没动只有一个解释 */
  stallMs?: number
}

/**
 * 「运行按了没反应」的唯一解释，也是这个项目里最容易踩的一脚。
 *
 * 服务端运行**全靠 worker**：createRun 只是往 runs 表里插一行 queued，
 * 真正执行它的是 `npm run worker` 那个进程。worker 不在的时候：
 *
 * - 点运行 → 一条永远 queued 的记录，前端一直轮询 → 界面永远「运行中」
 * - 对**跑起来过**的 run 点停止 → 服务端只记下取消意图（status 保持
 *   running，取消是发给 worker 的请求，见 runstore.request_cancel），
 *   没有 worker 去撤平台任务收尾 → **按钮停在「取消中」不动**
 *
 * 还没被认领过的 run 点停止**不在此列**：服务端直接原子收尾成 canceled，
 * 不需要 worker（以前那条路也走 canceling，然后没有任何角色认领它 ——
 * 永远挂在「取消中」，就是下面 STALL_CANCELING 那句话描述的症状）。
 *
 * 两件事都没有任何报错，本地和线上一模一样地静默。所以卡住必须喊出来，
 * 而且要把话说到"去起 worker"这一步 —— 只说"排队中"等于没说。
 */
const STALL_QUEUED = '运行已入队，但一直没有 worker 接手 —— 服务端运行全靠 worker，先起一个：npm run worker'
// canceling 这个 status 如今只有旧代码写出的存量行、或新旧共存的部署缝隙
// 才会出现，但出现了仍然只有 worker 能收尾 —— 这句话和函数都留着
const STALL_CANCELING = '取消请求已发出，但没有 worker 去收尾 —— 取消要 worker 执行，先起一个：npm run worker'

/**
 * 该不该喊，喊哪一句。
 *
 * 判据是 **status 本身**，不是"等了多久就一律喊"：`running` 的慢查询本来就该
 * 等下去，喊它只是噪音；`queued` 和 `canceling` 这两个状态**只有 worker 能
 * 推动**，等下去不会自己好 —— 这两个才是要喊的。
 */
export function stallMessage(status: string, waitedMs: number, stallMs: number): string | null {
  if (waitedMs < stallMs) return null
  if (status === 'queued') return STALL_QUEUED
  if (status === 'canceling') return STALL_CANCELING
  return null
}

/**
 * 运行记录面板显示的状态。服务端**有意**不把在跑的 run 改成 canceling
 * （取消是过程不是瞬间，见 runstore.request_cancel），「取消中」要靠
 * cancelRequestedAt 推导 —— 不推导的话点了停止界面纹丝不动。
 *
 * 已到终态的即使带着取消时间戳也照终态显示：取消赶在结束之后到，
 * 就是没取消成 —— 不能把一次 success 画成「已取消」。
 */
export function displayRunStatus(run: { status: string; cancelRequestedAt?: string | null }): string {
  const active = run.status === 'queued' || run.status === 'running'
  return active && run.cancelRequestedAt ? 'canceling' : run.status
}

/**
 * 停止按钮出现在哪些（显示）状态下。canceling 也算 —— 按钮要在场但
 * disabled：点完就消失的话，用户分不清「停完了」和「按钮忽然没了」。
 */
export function isRunActive(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'canceling'
}

/**
 * 发起一次服务端运行并跟到终态。
 *
 * 中止时调 `POST /api/runs/{id}/cancel` —— **不是简单地停止轮询**：
 * 平台上的 Hive 任务要真的撤掉，不撤的话它继续跑完，白烧集群资源。
 */
export async function startRemoteRun(opts: RemoteRunOptions): Promise<FlowRun> {
  const { runId } = await api.createRun(opts.flowId, opts.inputs)

  // 失败在这个调用点吞掉：abort 常发生在组件卸载途中，错误无处展示也无需
  // 重试。**不能退回 client 层去吞** —— cancelRun 还有运行记录面板在用，
  // 那边的失败必须能弹出来，否则就是「停止按钮点了没反应」
  const onAbort = () => { void api.cancelRun(runId).catch(() => {}) }
  // **先补一次显式检查，再挂监听**：createRun 是一次网络往返，而
  // `running` 在它之前就置上了 —— 这段时间里"停止"按钮已经可以点。点下去
  // signal 立刻 abort，但那时 runId 还不存在、监听也还没挂上，而
  // addEventListener('abort') 挂到一个**已经 abort 的 signal 上永远不会触发**。
  // 于是这一下停止被整个丢掉：运行照常排队，界面照常转圈，一句话都没有。
  // 手快的人（点完运行马上后悔）百分百踩中，而且看起来就是"停止按钮没用"。
  if (opts.signal?.aborted) {
    onAbort()
  } else {
    opts.signal?.addEventListener('abort', onAbort, { once: true })
  }

  const interval = opts.pollMs ?? 1000
  const stallAfter = opts.stallMs ?? 8000
  // 每种卡法只喊一次。轮询是一秒一次的，不去重会刷成一串一样的提示
  const said = new Set<string>()
  let waitedMs = 0
  try {
    for (;;) {
      const remote = await api.getRun(runId)
      const run = toFlowRun(remote)
      opts.onUpdate(run)
      if (remote.status === 'success' || remote.status === 'error' || remote.status === 'canceled') {
        return run
      }
      const stall = stallMessage(remote.status, waitedMs, stallAfter)
      if (stall && !said.has(stall)) {
        said.add(stall)
        opts.onStall?.(stall)
      }
      await new Promise((r) => setTimeout(r, interval))
      waitedMs += interval
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
