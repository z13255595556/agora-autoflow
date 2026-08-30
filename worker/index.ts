import type { Edge } from '@xyflow/react'
import { decide, type DecideStep } from '../src/lib/engine-core/decide.ts'
import { MAX_LOOP_ITERATIONS, stepKeyOf } from '../src/lib/engine-core/types.ts'
import { prepare, loopScope } from '../src/lib/engine-core/graph.ts'
import { toGraph } from '../src/lib/flowGraph.ts'
import { mockOutput, plannedWaitSeconds, resolveParams, resolveTemplate } from '../src/lib/engine.ts'
import { validateNode } from '../src/lib/vars.ts'
import { NODE_TYPE_MAP, applyBackendNodes } from '../src/registry.ts'
import type { FlowDefinition, NodeType } from '../src/types.ts'
import type { FNode } from '../src/store.ts'
import {
  appendEvent, claimRun, deferRun, finishRun, heartbeat, loadFlowVersion, loadSteps,
  pool, publisherOf, purgeExpiredRuns, purgeOrphanDraftVersions, reapExpired, rollUpUsage,
  writeStep, LEASE_SECONDS, RUN_RETENTION_DAYS, USAGE_ROLLUP_DAYS, type RunRow,
} from './store.ts'
import { beat, runSchedulerTick, syncAllSchedules } from './scheduler.ts'
import { refreshCnCalendar } from '../src/lib/engine-core/cnCalendar.ts'
import { deliverPending, recordRunAlert } from './alerts.ts'
import {
  backoffMs, failureKindOf, isRetryable, MAX_CONSECUTIVE_POLL_FAILURES, resolveRetry,
} from '../src/lib/engine-core/errorCodes.ts'

/**
 * 服务端执行器。**这是「关掉浏览器流程照跑」成立的地方。**
 *
 * 循环结构刻意和 test/golden/decideRunner.ts 保持同形：
 *   decide(从库里读的 steps) → 执行一步 → 写回库 → 再 decide
 *
 * 那个内存版本已经被等价性测试证明与 executeFlow 行为一致；
 * 这里换成真的读写数据库，多出来的只有租约、心跳和事件。
 * **每次 decide 都从库全量重算，不保留任何跨步的内存状态** ——
 * 所以 worker 在任何一步之后崩掉，新 worker 接上算出的下一步都一样。
 */

const API = process.env.NODE_SERVICE ?? 'http://localhost:8791'
const WORKER_ID = `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1000)

/**
 * 运行日志清理的节流。删除是幂等的，但没必要每秒对着 runs 表发一条
 * DELETE —— 保留期以天计，一小时扫一次绰绰有余。这里的时间戳只是
 * 节流器（和心跳的 setInterval 同类），不是执行状态，不违反
 * 「decide 不留跨步内存状态」的约定。
 */
const PURGE_INTERVAL_MS = 60 * 60 * 1000
let lastPurgeAt = 0
const CALENDAR_REFRESH_MS = 24 * 60 * 60 * 1000
let lastCalendarAt = 0

/**
 * 到点就滚一次用量统计、再清一次过期的运行日志。失败只记日志不断 tick。
 *
 * **汇总必须在清理之前** —— 反过来就是先把明细删了再去统计，那一天的数据
 * 永久少一块，且事后无从发现。
 */
async function purgeTick(): Promise<void> {
  if (Date.now() - lastPurgeAt < PURGE_INTERVAL_MS) return
  lastPurgeAt = Date.now()
  try {
    const rolled = await rollUpUsage()
    if (rolled > 0) console.log(`已汇总 ${rolled} 行用量统计（最近 ${USAGE_ROLLUP_DAYS} 天）`)
    const purged = await purgeExpiredRuns()
    if (purged > 0) console.log(`已清理 ${purged} 条超过 ${RUN_RETENTION_DAYS} 天保留期的运行日志`)
    // 顺序不能反：runs 对 flow_versions 有外键，先收运行记录才轮得到它们引用的快照
    const versions = await purgeOrphanDraftVersions()
    if (versions > 0) console.log(`已清理 ${versions} 份没有运行记录引用的调试快照`)
  } catch (err) {
    console.error('用量汇总 / 清理过期运行日志失败：', msg(err))
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function calendarTick(): Promise<void> {
  if (Date.now() - lastCalendarAt < CALENDAR_REFRESH_MS) return
  lastCalendarAt = Date.now()
  try {
    const { applied } = await refreshCnCalendar()
    if (applied.length) console.log(`已刷新中国节假日历：${applied.join('、')}`)
  } catch (err) {
    console.error('刷新中国节假日历失败，沿用内置数据：', msg(err))
  }
}

/** 读一次节点服务的响应。error 有值就是这次调用失败了，code 供重试判定用 */
interface NodeResponse<T> {
  body: T
  error?: string
  code?: string
}

/**
 * 读节点服务的响应体。**先看状态码再解析，而且解析失败本身不能变成错误内容。**
 *
 * 以前这里是 `const body = await r.json()`，还排在 `if (!r.ok)` 前面。上游一旦
 * 回了非 JSON 的错误体 —— 服务端没接住的异常（text/plain 的
 * "Internal Server Error"）、网关的 502 HTML 页、SSO 的登录页 —— 抛出来的是
 * 解析异常本身，节点上于是显示
 *
 *     Unexpected token 'I', "Internal S"... is not valid JSON
 *
 * 状态码、上游原话、错误码一起丢光。更糟的是它落进 catch 分支、不带错误码，
 * 而认不出错误码一律不重试，于是一次平台抖动被判成永久失败。
 *
 * 非 JSON 的响应体**不补错误码**：认不出就是认不出，宁可不重试也不猜 ——
 * 猜错的方向是"给群里重发三条一样的日报"，比多失败一次贵。
 */
export async function readNodeResponse<T = Record<string, unknown>>(r: Response): Promise<NodeResponse<T>> {
  const text = await r.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    const snippet = text.trim().replace(/\s+/g, ' ').slice(0, 200)
    return { body: {} as T, error: `节点服务返回了非 JSON 响应（HTTP ${r.status}）：${snippet || '(空)'}` }
  }
  const body = (parsed ?? {}) as T
  if (r.ok) return { body }
  // FastAPI 的错误在 detail 里；现在是 {code, retryable, message}，老格式是字符串
  const d = (parsed as { detail?: unknown } | null)?.detail
  if (d && typeof d === 'object') {
    const o = d as { code?: string; message?: string }
    return { body, error: o.message ?? `HTTP ${r.status}`, code: o.code }
  }
  return { body, error: typeof d === 'string' ? d : `HTTP ${r.status}` }
}

/** poll 的返回。字段全是可选的 —— 老服务端和错误响应都可能缺 */
interface PollBody {
  done?: boolean
  failed?: boolean
  progress?: number
  error?: string
  output?: unknown
}

/** 拉后端节点注册表。**必须成功** —— 拿前端兜底定义去跑会和线上行为不一致 */
async function loadRegistry(): Promise<void> {
  const r = await fetch(`${API}/registry/nodes`)
  if (!r.ok) throw new Error(`拉不到节点注册表：HTTP ${r.status}`)
  const { nodes } = (await r.json()) as { nodes: Parameters<typeof applyBackendNodes>[0] }
  applyBackendNodes(nodes)
}

/**
 * 代提交的身份头。
 *
 * 密钥和邮箱**必须一起给**：只给邮箱服务端不认（fail closed），
 * 只给密钥则退回机器人账号权限。没配 WORKER_TOKEN 时一个头都不发 ——
 * 让"没配"是一个安静的降级，而不是一堆被服务端默默丢掉的头。
 */
const WORKER_TOKEN = process.env.WORKER_TOKEN ?? ''
const delegation = (creator: string | null): Record<string, string> =>
  WORKER_TOKEN && creator
    ? { 'X-Worker-Token': WORKER_TOKEN, 'X-Run-Creator': creator }
    : {}

interface Ctx {
  trigger: Record<string, unknown>
  run: { id: string; startedAt: string }
  nodes: Record<string, { output: unknown }>
  loop?: { item: unknown; index: number }
}

/** 执行一条 run 直到终态或没事可做 */
async function driveRun(run: RunRow): Promise<void> {
  const definition = (await loadFlowVersion(run.flow_id, run.flow_version)) as unknown as FlowDefinition
  // 以发布者的名义去数据平台查数。服务端只在 WORKER_TOKEN 对得上时才认这个头
  // （见 identity.delegated_creator）—— 否则任何人加个头就能冒充别人查数
  const creator = await publisherOf(run.flow_id, run.flow_version)
  const graph = toGraph(definition)
  const { nodes, edges } = prepare(graph.nodes, graph.edges)
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  await appendEvent(run.id, 'run.started', { workerId: WORKER_ID, attempt: run.attempt })

  // scheduled_time 是日期基准 —— 不是 now()。补跑昨天的日报时，
  // date('now-1d') 必须算出的是"相对那个计划时刻的昨天"
  const base = run.scheduled_time.getTime()

  const beat = setInterval(() => { void heartbeat(run.id, WORKER_ID) }, (LEASE_SECONDS / 3) * 1000)

  try {
    for (let tick = 0; tick < 10000; tick++) {
      // ★ 每一轮都重新读：租约、取消意图、steps 全部从库里来，不留内存状态
      const [{ rows: fresh }, steps] = await Promise.all([
        pool.query<RunRow>('SELECT * FROM runs WHERE id = $1', [run.id]),
        loadSteps(run.id),
      ])
      const cur = fresh[0]
      if (!cur || cur.lease_owner !== WORKER_ID) return   // 租约被抢走，立刻停手

      const result = decide({
        nodes,
        edges,
        run: { status: cur.cancel_requested_at ? 'canceling' : 'running' },
        steps: steps.map((s) => ({
          nodeId: s.nodeId, loopPath: s.loopPath, status: s.status,
          ...(s.matched === undefined ? {} : { matched: s.matched }),
          ...(s.fanout === undefined ? {} : { fanout: s.fanout }),
          // 暂停的 skipped 要被下游判成活，靠的就是这一个字段
          ...(s.skipReason === undefined ? {} : { skipReason: s.skipReason }),
        })) as DecideStep[],
      })

      for (const s of result.toSkip) {
        if (steps.some((x) => stepKeyOf(x) === stepKeyOf(s))) continue
        await writeStep(run.id, { ...s, status: 'skipped', skipReason: s.reason })
        await appendEvent(run.id, 'node.skipped', { reason: s.reason }, s.nodeId, s.loopPath)
      }

      for (const c of result.toCancel) {
        const row = steps.find((x) => stepKeyOf(x) === stepKeyOf(c))
        const handle = (row?.progress as { handle?: string } | undefined)?.handle
        if (handle) {
          // 不撤的话平台那边继续跑完，白烧集群资源
          const t = nodeById.get(c.nodeId)?.data.typeId
          await fetch(`${API}/nodes/${t}/cancel`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle }),
          }).catch(() => {})
        }
        await writeStep(run.id, { ...c, status: 'canceled' })
        await appendEvent(run.id, 'node.canceled', {}, c.nodeId, c.loopPath)
      }

      if (result.finished) {
        await finishRun(run.id, result.finished)
        // 告警登记在 run 收尾之后、且**不影响收尾结果** ——
        // 它是运行的旁路，不是一环
        await recordRunAlert(run.id).catch(() => {})
        return
      }

      if (!result.toRun.length) {
        // 这一轮只写了 skipped / canceled 行、没有可跑的：状态变了，**立刻重算**
        // 而不是交接出去。否则会走到下面的 deferRun —— 它释放租约后只有"等外部
        // 系统"的行会把 run 唤回来，而 skip 和 cancel 都不是这种行，run 就停在
        // running 直到一小时后 reaper 来收。
        // 暂停的节点第一次把 toSkip 这条路走出来了；toCancel 是等待节点踩出来的：
        // 取消一条"触发器 → 等待"的 run，取消轮里 toSkip 恰好为空，漏了 continue
        // 的症状是**步骤都 canceled 了、run 却在界面上"取消中"挂一个小时** ——
        // 取消正在等 SQL 的 run 且 SQL 是末节点时同样中招
        if (result.toSkip.length || result.toCancel.length) continue
        if (result.progress === 'stuck') {
          await finishRun(run.id, 'error', '流程卡住：存在环路或不可达的汇合点，没有节点可以推进')
          await recordRunAlert(run.id).catch(() => {})
          return
        }
        // waiting：有行在等外部系统（异步查询轮询 / 退避重试）。
        // **必须显式交接,不能只是 return** —— 光 return 的话租约会在 60 秒后
        // 过期,reaper 把"正在等 Hive 出结果"误判成"worker 失联"。见 deferRun
        await deferRun(run.id, WORKER_ID)
        return
      }

      // 一次只跑一个再重新 decide。批量执行等于偷偷引入并行，
      // 而并行会静默绕过全局 fail-fast（等价性测试抓到过这一条）
      const target = result.toRun[0]
      await runOneStep(run, cur, definition, nodes, edges, nodeById, steps, target, base, creator)
    }
  } finally {
    clearInterval(beat)
  }
}

async function runOneStep(
  run: RunRow,
  cur: RunRow,
  definition: FlowDefinition,
  nodes: FNode[],
  edges: Edge[],
  nodeById: Map<string, FNode>,
  steps: Awaited<ReturnType<typeof loadSteps>>,
  target: { nodeId: string; loopPath: number[] },
  baseMs: number,
  /** 以谁的名义调数据平台 —— 这一版的发布者。见 store.publisherOf */
  creator: string | null,
): Promise<void> {
  const node = nodeById.get(target.nodeId)!
  const t = NODE_TYPE_MAP.get(node.data.typeId)

  // ctx 装配的硬规则：只取 success 的行；循环体内只取同 loopPath 的行。
  // 跨 loopPath 取值一律视为缺失 —— 否则 i=1 失败时下游会静默读到 i=0 的数据
  const ctx: Ctx = {
    trigger: cur.trigger_input,
    run: { id: run.id, startedAt: new Date(baseMs).toISOString() },
    nodes: {},
  }
  const sameScope = (p: number[]) => p.length === 0 || stepKeyOf({ nodeId: '', loopPath: p }) === stepKeyOf({ nodeId: '', loopPath: target.loopPath })
  for (const s of steps) {
    if (s.status !== 'success' || !sameScope(s.loopPath)) continue
    ctx.nodes[s.nodeId] = { output: s.output }
  }
  if (target.loopPath.length) {
    const owner = nodes.find((n) => n.data.typeId === 'flow.foreach' && loopScope(n.id, edges).has(node.id))
    const items = owner
      ? ((steps.find((s) => s.nodeId === owner.id)?.output as { results?: Array<{ item: unknown }> })?.results ?? [])
      : []
    ctx.loop = { item: items[target.loopPath[0]]?.item, index: target.loopPath[0] }
  }

  await writeStep(run.id, { ...target, status: 'running' })
  await appendEvent(run.id, 'node.started', {}, target.nodeId, target.loopPath)

  /**
   * 记一次失败。**可重试的错误不直接判死**，置 waiting/retry 等退避到期。
   *
   * 重试必须排在幂等键之后 —— 否则"重试"会变成"群里收到三条一样的日报"。
   * 有副作用的节点（notify.wecom / http.request）带确定性幂等键，
   * 服务端 24 小时内同 key 直接返回上次结果不重发。
   */
  const attempt = (steps.find((x) => stepKeyOf(x) === stepKeyOf(target)) as { attempt?: number } | undefined)?.attempt ?? 0
  const fail = async (error: string, kind: string, code?: string) => {
    // 策略只从节点类型的 policy.retry 来（manifest 是唯一出处），实例可以覆盖次数 /
    // 首次间隔或干脆关掉。以前这里读一张写死的 DEFAULT_RETRY 表，和 manifest 不一致
    const spec = resolveRetry(NODE_TYPE_MAP.get(node.data.typeId)?.policy?.retry, node.data.retry)
    const canRetry = spec && isRetryable(code) && attempt + 1 < spec.maxAttempts
    if (canRetry) {
      const wait = backoffMs(spec, attempt + 1)
      await writeStep(run.id, {
        ...target, status: 'waiting', waitKind: 'retry', error, failureKind: kind,
        nextWakeAt: new Date(Date.now() + wait),
      })
      await appendEvent(run.id, 'node.retrying',
        { error, failureKind: kind, attempt: attempt + 1, nextInMs: wait }, target.nodeId, target.loopPath)
      return
    }
    await writeStep(run.id, { ...target, status: 'failed', error, failureKind: kind })
    await appendEvent(run.id, 'node.failed', { error, failureKind: kind, attempt }, target.nodeId, target.loopPath)
  }

  const pinData = (definition.pinData ?? {}) as Record<string, unknown>
  if (cur.mode === 'manual' && Object.prototype.hasOwnProperty.call(pinData, node.id)) {
    await writeStep(run.id, { ...target, status: 'success', output: pinData[node.id] })
    await appendEvent(run.id, 'node.succeeded', { pinned: true }, target.nodeId, target.loopPath)
    return
  }

  let input: Record<string, unknown>
  try {
    input = resolveParams(node.data.params, ctx, t?.input)
  } catch (err) {
    return fail(msg(err), 'business')
  }

  const errors = validateNode(node, nodes, edges, toGraph(definition).inputs)
  if (errors.length) return fail(errors[0], 'business')

  if (node.data.typeId === 'flow.foreach') {
    try {
      const resolved = resolveTemplate(node.data.params.items, ctx)
      if (!Array.isArray(resolved)) {
        throw new Error(
          `循环的「数据来源」要指向一个数组，实际解析出的是 ${resolved === null ? 'null' : typeof resolved}。` +
            `通常应该引用上游的结果集，例如 {{ $.nodes.q1.output.rows }}`,
        )
      }
      if (resolved.length > MAX_LOOP_ITERATIONS) {
        throw new Error(
          `循环项有 ${resolved.length} 条，超过上限 ${MAX_LOOP_ITERATIONS}。` +
            `请在上游 SQL 里加 LIMIT，或先用「列表操作」节点截取`,
        )
      }
      const output = {
        results: resolved.map((item, index) => ({ index, item })),
        okCount: resolved.length,
        failCount: 0,
      }
      await writeStep(run.id, { ...target, status: 'success', input, output, fanout: resolved.length })
      await appendEvent(run.id, 'loop.expanded', { fanout: resolved.length }, target.nodeId, target.loopPath)
    } catch (err) {
      await fail(msg(err), 'business')
    }
    return
  }

  // ── 等待节点：**不占着 worker 睡觉**。写一行 waiting/sleep + 到点时刻就交回
  //    队列，到点由 wakeDeferred 置成 success —— 和异步查询同一套「无人持有的
  //    等待」。在这里 setTimeout 的话，一个 1 小时的等待就占死一个 worker，
  //    而且 worker 一重启等待就凭空消失。
  //
  //    随机时长在这里**掷一次并立刻落库**，到点结算只读库里的数。崩溃重来会
  //    重掷（此时还没有任何可观察的痕迹，无害）；但绝不能到点再掷 ——
  //    那样「实际等了多久」和运行详情里写的对不上，静默且无法复现。
  if (node.data.typeId === 'flow.wait') {
    let seconds: number
    try {
      seconds = plannedWaitSeconds(input, Math.random())
    } catch (err) {
      // 参数解析不出秒数是配置问题：重试一百次也一样
      return fail(msg(err), 'business')
    }
    const resumeAt = new Date(Date.now() + seconds * 1000)
    await writeStep(run.id, {
      ...target, status: 'waiting', input, waitKind: 'sleep',
      progress: { waitSeconds: seconds, resumeAt: resumeAt.toISOString() },
      nextWakeAt: resumeAt,
    })
    await appendEvent(run.id, 'node.deferred', { waitSeconds: seconds, resumeAt: resumeAt.toISOString() }, target.nodeId, target.loopPath)
    return
  }

  // 真实节点走后端服务；没有 runtime 的（控制/变换类）本地算
  if (!t?.runtime) {
    try {
      const output = mockOutput(node, ctx, input, edges)
      await writeStep(run.id, {
        ...target, status: 'success', input, output,
        ...(node.data.typeId === 'flow.if' ? { matched: (output as { matched: boolean }).matched } : {}),
      })
      await appendEvent(run.id, 'node.succeeded', {}, target.nodeId, target.loopPath)
    } catch (err) {
      await fail(msg(err), 'business')
    }
    return
  }

  if (t.runtime.kind === 'http') {
    try {
      // 幂等键含 iteration 但**不含 attempt** —— 含了等于没有去重，
      // 每次重试 key 都变，重试就还是会重复发消息
      const idem = `${run.id}:${target.nodeId}:${target.loopPath.join('.')}`
      const r = await fetch(`${API}/nodes/${t.type}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idem, ...delegation(creator) },
        body: JSON.stringify({ params: input }),
      })
      const { body, error, code } = await readNodeResponse(r)
      if (error) return fail(error, failureKindOf(code, r.status), code)
      await writeStep(run.id, { ...target, status: 'success', input, output: body.output ?? {} })
      await appendEvent(run.id, 'node.succeeded', {}, target.nodeId, target.loopPath)
    } catch (err) {
      await fail(msg(err), 'infra')
    }
    return
  }

  // ── http-async：submit 之后**不阻塞**，置 waiting 交回队列
  //
  // 阻塞等的话一条五分钟的 Hive 查询会让 worker 在这五分钟里既不能重启
  // 也不能释放；而且崩了之后 handle 就丢了，只能重新 submit ——
  // 那意味着平台上多一个大查询，第一个还在跑且没人持有它的 handle。
  const submitKey = `${run.id}:${target.nodeId}:${target.loopPath.join('.')}:${cur.attempt}`
  // ★ 截止时刻在**提交那一刻**就算成绝对时间存下来，不在每次轮询时重算：
  //   中途改流程定义、或者 reaper 把 run 重排一次，都不该让一条已经在跑的
  //   查询悄悄拿到一个新的截止时间
  const timeoutMinutes = timeoutMinutesOf(t, input)
  const deadlineAt = new Date(Date.now() + timeoutMinutes * 60_000).toISOString()
  // ★ 先落"我即将 submit"再打请求：那一刻还没有 handle，但必须已经有痕迹，
  //   否则崩在 submit 返回之前和"刚认领还没发请求"完全同形，reaper 会重跑
  await writeStep(run.id, {
    ...target, status: 'waiting', input, waitKind: 'poll',
    progress: { submitKey, deadlineAt, timeoutMinutes },
  })
  try {
    const r = await fetch(`${API}/nodes/${t.type}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submitKey, ...delegation(creator) },
      body: JSON.stringify({ params: input }),
    })
    const { body, error, code } = await readNodeResponse(r)
    if (error) return fail(error, failureKindOf(code, r.status), code)
    await writeStep(run.id, {
      ...target, status: 'waiting', waitKind: 'poll',
      progress: { submitKey, handle: body.handle, deadlineAt, timeoutMinutes },
      nextWakeAt: new Date(Date.now() + (t.runtime.pollIntervalMs ?? 3000)),
    })
    await appendEvent(run.id, 'node.deferred', { handle: body.handle }, target.nodeId, target.loopPath)
  } catch (err) {
    await fail(msg(err), 'infra')
  }
}

/**
 * 这个异步节点最多跑多久（分钟）。
 *
 * 优先级：节点参数 > manifest 的 runtime 兜底 > 15。
 * 最后那个 15 只是"注册表都拉不到"时的保险，正常永远走不到 —— 真正的默认值
 * 在 server/sql_service/manifest.py 的 SQL_TIMEOUT_MINUTES，单一出处。
 */
const FALLBACK_TIMEOUT_MINUTES = 15

function timeoutMinutesOf(t: NodeType, input: Record<string, unknown>): number {
  const raw = Number(input.timeoutMinutes ?? t.runtime?.defaultTimeoutMinutes ?? FALLBACK_TIMEOUT_MINUTES)
  // 填了 0 / 负数 / 非数字都退回默认值，**不当成"不超时"** ——
  // 那会让一次手滑变成一条永远挂在那里的 run
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_TIMEOUT_MINUTES
  // 上限在这里**真的**夹一次。manifest 里的 maximum 只管到表单控件，
  // 导入的流程 JSON、老版本前端、手改的定义都绕得过去；而超过判死线
  // （3 × DEFERRED_LEASE_SECONDS）的超时等于没有超时
  return Math.min(wanted, t.runtime?.maxTimeoutMinutes ?? Infinity)
}

/**
 * 唤醒到期的 waiting 步骤（异步节点轮询 / 退避重试 / 等待节点到点）。
 *
 * **不需要单独的 triggerer 进程** —— 塞进同一个 worker 循环即可。
 * 恢复路径的关键：按 progress.handle 继续 poll，**绝不重新 submit**。
 *
 * sleep 行多一条唤醒条件：run 被请求取消就**提前**醒。轮询行每 3 秒
 * 自然醒一次，取消最多迟到一轮；而 sleep 一觉最长 1 小时，不提前醒的话
 * 「点了停止」要等睡醒才生效 —— 用户看到的就是停止按钮坏了。
 */
async function wakeDeferred(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT s.run_id, s.node_id, s.loop_path, s.wait_kind, s.progress,
            r.flow_id, r.flow_version, r.cancel_requested_at
     FROM steps s JOIN runs r ON r.id = s.run_id
     WHERE s.status = 'waiting' AND s.wait_kind IN ('poll','retry','sleep')
       AND s.next_wake_at IS NOT NULL
       AND (s.next_wake_at <= now()
            OR (s.wait_kind = 'sleep' AND r.cancel_requested_at IS NOT NULL))
       AND r.status IN ('running','queued')
     FOR UPDATE OF s SKIP LOCKED
     LIMIT 10`,
  )
  for (const row of rows) {
    // ── 等待节点到点（或被取消提前唤醒）。**必须排在 !handle 的 retry 分支
    //    之前**：sleep 行没有 handle，掉进那个分支会被置回 queued 重新执行，
    //    重新执行又掷一次时长、再睡一觉 —— 一个永远睡不完的循环
    if (row.wait_kind === 'sleep') {
      const target = { nodeId: row.node_id, loopPath: row.loop_path as number[] }
      if (row.cancel_requested_at) {
        // 只把 run 交回队列，这一行不动 —— 「取消」是 run 级语义，
        // 由 decide 的 canceling 分支统一把 waiting 行记成 canceled
        await pool.query("UPDATE runs SET status='queued', lease_owner=NULL WHERE id=$1 AND status='running'", [row.run_id])
        continue
      }
      const waited = (row.progress as { waitSeconds?: number })?.waitSeconds ?? null
      await writeStep(row.run_id, {
        ...target, status: 'success',
        output: { waitSeconds: waited, resumedAt: new Date().toISOString() },
      })
      await appendEvent(row.run_id, 'node.succeeded', { waitSeconds: waited }, target.nodeId, target.loopPath)
      await pool.query("UPDATE runs SET status='queued', lease_owner=NULL WHERE id=$1 AND status='running'", [row.run_id])
      continue
    }
    const handle = row.progress?.handle
    if (!handle) {
      // retry 到期：把这一行放回 queued，让 decide 重新下发（attempt 已经记在行上）
      await pool.query(
        `UPDATE steps SET status='queued', next_wake_at=NULL, attempt=attempt+1
           WHERE run_id=$1 AND node_id=$2 AND loop_path=$3`,
        [row.run_id, row.node_id, row.loop_path],
      )
      await pool.query("UPDATE runs SET status='queued', lease_owner=NULL WHERE id=$1 AND status='running'", [row.run_id])
      continue
    }
    const definition = (await loadFlowVersion(row.flow_id, row.flow_version)) as unknown as FlowDefinition
    const nodeDef = definition.nodes.find((n) => n.id === row.node_id)
    const t = nodeDef && NODE_TYPE_MAP.get(nodeDef.type)
    if (!t?.runtime?.kind) continue
    const target = { nodeId: row.node_id, loopPath: row.loop_path as number[] }

    // ── 超时：撤掉平台上的任务，再判失败
    //
    // 顺序不能反 —— 先写失败再撤的话，中间崩一次这个 job 就永远没人撤了，
    // 它会在集群上一直跑到自己结束。撤销失败不影响判失败（catch 吞掉）：
    // 撤不掉最多浪费资源，而让一条已经超时的 run 无限等下去更糟。
    const deadlineAt = (row.progress as { deadlineAt?: string })?.deadlineAt
    if (deadlineAt && Date.parse(deadlineAt) <= Date.now()) {
      const mins = (row.progress as { timeoutMinutes?: number })?.timeoutMinutes
      await fetch(`${API}/nodes/${t.type}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
      }).catch(() => {})
      const why = `查询超过 ${mins ?? '设定'} 分钟还没结束，已向平台撤销任务。要跑更久就把节点的「超时时间」调大`
      // business 而不是 infra：重试一次同样会超时，能改的是 SQL 或这个设置
      await writeStep(row.run_id, { ...target, status: 'failed', error: why, failureKind: 'business' })
      await appendEvent(row.run_id, 'node.failed', { error: why, timeout: true }, target.nodeId, target.loopPath)
      await pool.query("UPDATE runs SET status='queued', lease_owner=NULL WHERE id=$1 AND status='running'", [row.run_id])
      continue
    }

    try {
      const r = await fetch(
        `${API}/nodes/${t.type}/poll?handle=${encodeURIComponent(handle)}&limit=1000`,
      )
      const { body, error, code } = await readNodeResponse<PollBody>(r)
      if (error) throw Object.assign(new Error(error), { code })
      if (!body.done) {
        await writeStep(row.run_id, {
          ...target, status: 'waiting', waitKind: 'poll',
          // deadlineAt 必须原样带着走 —— 每轮 writeStep 都是整行覆盖 progress，
          // 漏掉它等于每轮把超时重置成"永不超时"。
          // pollFailures 归零：连续失败的计数只有"连续"时才算数
          progress: { ...(row.progress ?? {}), handle, lastProgress: body.progress, pollFailures: 0 },
          nextWakeAt: new Date(Date.now() + (t.runtime.pollIntervalMs ?? 3000)),
        })
        continue
      }
      if (body.failed) {
        await writeStep(row.run_id, { ...target, status: 'failed', error: body.error ?? '查询失败', failureKind: 'business' })
        await appendEvent(row.run_id, 'node.failed', { error: body.error }, target.nodeId, target.loopPath)
      } else {
        await writeStep(row.run_id, { ...target, status: 'success', output: body.output ?? {} })
        await appendEvent(row.run_id, 'node.succeeded', {}, target.nodeId, target.loopPath)
      }
      // 结果到手，把 run 放回队列让 worker 接着推进
      await pool.query("UPDATE runs SET status='queued', lease_owner=NULL WHERE id=$1 AND status='running'", [row.run_id])
    } catch (err) {
      // **轮询失败 ≠ 查询失败**：平台上那个 job 还好好地跑着。可重试的错误先等
      // 下一轮，连续到 MAX_CONSECUTIVE_POLL_FAILURES 次才认输 —— 和浏览器里的
      // 引擎同一条规则。真正兜底的仍是上面的 deadlineAt，它不因这里多等几轮而变。
      const code = (err as { code?: string }).code
      const failures = ((row.progress as { pollFailures?: number })?.pollFailures ?? 0) + 1
      if (isRetryable(code) && failures < MAX_CONSECUTIVE_POLL_FAILURES) {
        await writeStep(row.run_id, {
          ...target, status: 'waiting', waitKind: 'poll',
          progress: { ...(row.progress ?? {}), handle, pollFailures: failures },
          nextWakeAt: new Date(Date.now() + (t.runtime.pollIntervalMs ?? 3000)),
        })
        continue
      }
      const why = failures > 1 ? `连续 ${failures} 次查询状态失败：${msg(err)}` : msg(err)
      await writeStep(row.run_id, { ...target, status: 'failed', error: why, failureKind: 'infra' })
      await appendEvent(row.run_id, 'node.failed', { error: why }, target.nodeId, target.loopPath)
      // 步骤判死了，run 必须立刻回队列让 decide 收尾。不放回去它会挂在 'running'
      // 上直到 deferred 租约（1 小时）过期：界面上一直显示"运行中"，而且 reaper
      // 会把它记成一次 "worker 失联"，攒够三次整条 run 直接判 error
      await pool.query("UPDATE runs SET status='queued', lease_owner=NULL WHERE id=$1 AND status='running'", [row.run_id])
    }
  }
  return rows.length
}

export async function tick(onlyFlowId?: string): Promise<{ ran: boolean }> {
  await reapExpired()
  // 过期日志清理走同一个循环，和调度器一样不单开进程；节流见 purgeTick
  await purgeTick()
  void calendarTick()
  // 调度器跑在同一个循环里，靠 advisory lock 保证多 worker 时只有一个在扫表
  await syncAllSchedules()
  await beat(WORKER_ID)
  const fired = await runSchedulerTick()
  const woke = await wakeDeferred()
  // 告警投递失败绝不影响执行链路，所以吞掉异常
  await deliverPending().catch(() => {})
  const run = await claimRun(WORKER_ID, onlyFlowId)
  if (run) {
    try {
      await driveRun(run)
    } catch (err) {
      await finishRun(run.id, 'error', `引擎异常：${msg(err)}`)
      await recordRunAlert(run.id).catch(() => {})
    }
    return { ran: true }
  }
  return { ran: woke > 0 || fired > 0 }
}

export async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim() && !process.env.PGHOST?.trim()) {
    console.error('未配置 DATABASE_URL 或 PGHOST，worker 无法启动')
    process.exit(1)
  }
  await loadRegistry()
  await calendarTick()
  console.log(`worker ${WORKER_ID} 启动，API=${API}`)
  for (;;) {
    try {
      const { ran } = await tick()
      if (!ran) await new Promise((r) => setTimeout(r, POLL_MS))
    } catch (err) {
      console.error('tick 失败：', msg(err))
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  }
}

if (process.argv[1]?.endsWith('worker/index.ts')) void main()
