import type { Edge } from '@xyflow/react'
import { decide, type DecideStep } from '../src/lib/engine-core/decide.ts'
import { MAX_LOOP_ITERATIONS, stepKeyOf } from '../src/lib/engine-core/types.ts'
import { prepare, loopScope } from '../src/lib/engine-core/graph.ts'
import { toGraph } from '../src/lib/flowGraph.ts'
import { mockOutput, resolveParams, resolveTemplate } from '../src/lib/engine.ts'
import { validateNode } from '../src/lib/vars.ts'
import { NODE_TYPE_MAP, applyBackendNodes } from '../src/registry.ts'
import type { FlowDefinition } from '../src/types.ts'
import type { FNode } from '../src/store.ts'
import {
  appendEvent, claimRun, finishRun, heartbeat, loadFlowVersion, loadSteps,
  pool, publisherOf, purgeExpiredRuns, purgeOrphanDraftVersions, reapExpired, rollUpUsage,
  writeStep, LEASE_SECONDS, RUN_RETENTION_DAYS, USAGE_ROLLUP_DAYS, type RunRow,
} from './store.ts'
import { beat, runSchedulerTick, syncAllSchedules } from './scheduler.ts'
import { deliverPending, recordRunAlert } from './alerts.ts'
import { backoffMs, DEFAULT_RETRY, failureKindOf, isRetryable } from '../src/lib/engine-core/errorCodes.ts'

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
        if (result.progress === 'stuck') {
          await finishRun(run.id, 'error', '流程卡住：存在环路或不可达的汇合点，没有节点可以推进')
          await recordRunAlert(run.id).catch(() => {})
          return
        }
        return  // waiting：交回队列，由唤醒循环在到期时重新认领
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
    const spec = DEFAULT_RETRY[node.data.typeId]
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
      const body = await r.json()
      if (!r.ok) {
        const d = body?.detail
        const code = d && typeof d === 'object' ? d.code : undefined
        const message = d && typeof d === 'object' ? d.message : (d ?? `HTTP ${r.status}`)
        return fail(message, failureKindOf(code, r.status), code)
      }
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
  // ★ 先落"我即将 submit"再打请求：那一刻还没有 handle，但必须已经有痕迹，
  //   否则崩在 submit 返回之前和"刚认领还没发请求"完全同形，reaper 会重跑
  await writeStep(run.id, {
    ...target, status: 'waiting', input, waitKind: 'poll',
    progress: { submitKey },
  })
  try {
    const r = await fetch(`${API}/nodes/${t.type}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submitKey, ...delegation(creator) },
      body: JSON.stringify({ params: input }),
    })
    const body = await r.json()
    if (!r.ok) {
      const d = body?.detail
      const code = d && typeof d === 'object' ? d.code : undefined
      return fail(d && typeof d === 'object' ? d.message : (d ?? `HTTP ${r.status}`), failureKindOf(code, r.status), code)
    }
    await writeStep(run.id, {
      ...target, status: 'waiting', waitKind: 'poll',
      progress: { submitKey, handle: body.handle },
      nextWakeAt: new Date(Date.now() + (t.runtime.pollIntervalMs ?? 3000)),
    })
    await appendEvent(run.id, 'node.deferred', { handle: body.handle }, target.nodeId, target.loopPath)
  } catch (err) {
    await fail(msg(err), 'infra')
  }
}

/**
 * 唤醒到期的 waiting 步骤（异步节点轮询 / 退避重试）。
 *
 * **不需要单独的 triggerer 进程** —— 塞进同一个 worker 循环即可。
 * 恢复路径的关键：按 progress.handle 继续 poll，**绝不重新 submit**。
 */
async function wakeDeferred(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT s.run_id, s.node_id, s.loop_path, s.progress, r.flow_id, r.flow_version
     FROM steps s JOIN runs r ON r.id = s.run_id
     WHERE s.status = 'waiting' AND s.wait_kind IN ('poll','retry')
       AND s.next_wake_at IS NOT NULL AND s.next_wake_at <= now()
       AND r.status IN ('running','queued')
     FOR UPDATE OF s SKIP LOCKED
     LIMIT 10`,
  )
  for (const row of rows) {
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
    try {
      const r = await fetch(
        `${API}/nodes/${t.type}/poll?handle=${encodeURIComponent(handle)}&limit=1000`,
      )
      const body = await r.json()
      if (!r.ok) throw new Error(body?.detail ?? `HTTP ${r.status}`)
      if (!body.done) {
        await writeStep(row.run_id, {
          ...target, status: 'waiting', waitKind: 'poll',
          progress: { handle, lastProgress: body.progress },
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
      await writeStep(row.run_id, { ...target, status: 'failed', error: msg(err), failureKind: 'infra' })
    }
  }
  return rows.length
}

export async function tick(onlyFlowId?: string): Promise<{ ran: boolean }> {
  await reapExpired()
  // 过期日志清理走同一个循环，和调度器一样不单开进程；节流见 purgeTick
  await purgeTick()
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
