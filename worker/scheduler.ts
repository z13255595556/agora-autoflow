import { nextFireAt, toCron } from '../src/lib/engine-core/cron.ts'
import type { FlowDefinition } from '../src/types.ts'
import { pool } from './store.ts'

/**
 * 调度器。**跑在 worker 进程内，不单开进程。**
 *
 * 用 Postgres advisory lock 保证多个 worker 里只有一个在扫表 —— 但那只是
 * 省 CPU。真正保证「同一时刻只触发一次」的是 runs 上那条唯一索引
 * `(flow_id, trigger_kind, scheduled_time)`：即使锁失效、即使两个调度器同时扫，
 * 第二次插入也会被数据库挡掉。**锁是性能优化，约束才是正确性保证。**
 */

/** advisory lock 的 key。随便取一个不会和别人撞的常量 */
const SCHEDULER_LOCK = 918_273_645

export interface DueSchedule {
  flow_id: string
  cron: string
  timezone: string
  next_fire_at: Date
  misfire: string
  grace_seconds: number
  on_overlap: string
  concurrency_key: string | null
  active_version: number | null
}

/**
 * 扫一遍到期的排程并入队。返回入队了几条。
 *
 * `now` 显式传进来而不是在里面取 —— 测试要能把时钟拨到任意时刻，
 * 而这段逻辑最需要测的恰恰是"错过了很久之后怎么办"。
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<number> {
  const client = await pool.connect()
  let queued = 0
  try {
    const { rows: locked } = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS ok', [SCHEDULER_LOCK],
    )
    if (!locked[0]?.ok) return 0   // 别的 worker 正在扫，这一轮不用我

    try {
      const { rows } = await client.query<DueSchedule>(
        `SELECT s.flow_id, s.cron, s.timezone, s.next_fire_at, s.misfire, s.grace_seconds,
                f.on_overlap, f.concurrency_key, f.active_version
           FROM schedules s JOIN flows f ON f.id = s.flow_id
          WHERE s.enabled AND s.next_fire_at <= $1 AND f.archived_at IS NULL`,
        [now],
      )

      for (const s of rows) {
        const due = s.next_fire_at
        const lateSeconds = (now.getTime() - due.getTime()) / 1000

        // 迟到太久：这一次放弃，直接排下一次。
        // 不是"跳过所有错过的"——那样服务停一天就一次都不补；
        // 也不是"全部补跑"——那样恢复后会连发一堆。只补最近的一次
        const tooLate = lateSeconds > s.grace_seconds
        const shouldFire = s.misfire === 'fire_once' ? !tooLate : lateSeconds <= 60

        if (shouldFire && s.active_version !== null) {
          const ok = await enqueue(client, s, due)
          if (ok) queued++
        }

        const next = nextFireAt(s.cron, s.timezone, now)
        await client.query(
          `UPDATE schedules SET next_fire_at = $2, last_fire_at = CASE WHEN $3 THEN $4 ELSE last_fire_at END
             WHERE flow_id = $1`,
          [s.flow_id, next ?? new Date(now.getTime() + 86400_000), shouldFire, due],
        )
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK])
    }
  } finally {
    client.release()
  }
  return queued
}

/**
 * 入队一次定时运行。返回 false 表示按重叠策略跳过了。
 *
 * `scheduled_time` 写的是**计划时刻**而不是当下 —— 补跑昨天 9 点的日报时，
 * `date('now-1d')` 必须算出"相对那个计划时刻的昨天"。
 */
async function enqueue(client: import('pg').PoolClient, s: DueSchedule, due: Date): Promise<boolean> {
  const key = s.concurrency_key ?? s.flow_id

  if (s.on_overlap !== 'queue') {
    const { rows: busy } = await client.query(
      `SELECT r.id FROM runs r JOIN flows f ON f.id = r.flow_id
        WHERE COALESCE(f.concurrency_key, f.id) = $1
          AND r.status IN ('queued','running','canceling')
        LIMIT 1`,
      [key],
    )
    if (busy.length) {
      if (s.on_overlap === 'cancel_running') {
        await client.query(
          "UPDATE runs SET cancel_requested_at = now() WHERE id = $1", [busy[0].id],
        )
      } else {
        // skip：**必须留痕**。悄悄不跑会让用户以为流程根本没触发，
        // 而真相是"上一次还没结束"——这两件事的排查方向完全不同
        await client.query(
          `INSERT INTO runs (id, flow_id, flow_version, mode, trigger_kind, scheduled_time,
                             status, finished_at, error)
           VALUES ($1,$2,$3,'production','schedule',$4,'error',now(),
                   '上一次运行还没结束，本次按重叠策略跳过')
           ON CONFLICT DO NOTHING`,
          [`run_skip_${Math.random().toString(36).slice(2, 10)}`, s.flow_id, s.active_version, due],
        )
        return false
      }
    }
  }

  const runId = `run_${Math.random().toString(36).slice(2, 14)}`
  const { rowCount } = await client.query(
    `INSERT INTO runs (id, flow_id, flow_version, mode, trigger_kind, scheduled_time, trigger_input)
     VALUES ($1,$2,$3,'production','schedule',$4,'{}')
     ON CONFLICT DO NOTHING`,
    [runId, s.flow_id, s.active_version, due],
  )
  if (!rowCount) return false   // 唯一约束挡下了重复触发，这正是它的用途
  await client.query(
    `INSERT INTO run_events (run_id, seq, type, payload)
     VALUES ($1, 1, 'run.queued', jsonb_build_object('triggerKind','schedule','scheduledFor',$2::text))`,
    [runId, due.toISOString()],
  )
  return true
}

/**
 * 把已发布流程里的定时配置同步进 schedules 表。
 *
 * **由 worker 做而不是发布时由 Python 做**：cron 的归一（四种 UI 模式 → 表达式）
 * 在 engine-core/cron.ts 里，Python 侧再写一份必然漂移，而漂移的表现是
 * "界面显示每天 9 点、实际按另一个时刻跑" —— 没人会想到去对两份代码。
 *
 * 每轮 tick 扫一遍。流程数量是个位数到几十，代价可以忽略。
 */
export async function syncAllSchedules(now: Date = new Date()): Promise<void> {
  const { rows } = await pool.query<{ flow_id: string; definition: FlowDefinition }>(
    `SELECT f.id AS flow_id, v.definition
       FROM flows f JOIN flow_versions v ON v.flow_id = f.id AND v.version = f.active_version
      WHERE f.archived_at IS NULL`,
  )
  const wanted = new Set<string>()
  for (const r of rows) {
    const trigger = (r.definition?.trigger ?? {}) as Record<string, unknown>
    if (trigger.kind !== 'schedule') continue
    let cron: string
    try {
      cron = toCron(trigger)
    } catch {
      // 表达式坏掉不该让整个调度器停摆。这条流程不排程，
      // 而"为什么没跑"由发布期的校验负责说清楚
      continue
    }
    wanted.add(r.flow_id)
    await syncSchedule(r.flow_id, cron, String(trigger.timezone ?? 'Asia/Shanghai'), now)
  }
  // 取消了定时触发的流程要把排程删掉，否则它会一直按旧配置跑
  const stale = rows.map((r) => r.flow_id).filter((id) => !wanted.has(id))
  if (stale.length) {
    await pool.query('DELETE FROM schedules WHERE flow_id = ANY($1)', [stale])
  }
}

/** 心跳。前端据此判断"定时触发到底会不会跑" */
export async function beat(workerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeat (id, role, beat_at) VALUES ($1,'scheduler',now())
     ON CONFLICT (id) DO UPDATE SET beat_at = now()`,
    [workerId],
  )
}

/** 发布流程时同步排程。没有定时触发器就删掉那一行 */
export async function syncSchedule(
  flowId: string,
  cron: string | null,
  timezone: string,
  now: Date = new Date(),
): Promise<void> {
  if (!cron) {
    await pool.query('DELETE FROM schedules WHERE flow_id = $1', [flowId])
    return
  }
  const next = nextFireAt(cron, timezone, now)
  await pool.query(
    `INSERT INTO schedules (flow_id, cron, timezone, next_fire_at, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (flow_id) DO UPDATE SET
       cron = EXCLUDED.cron, timezone = EXCLUDED.timezone,
       -- ★ **只在配置真的变了时才重算 next_fire_at。**
       --
       -- 无条件重算的后果是：这个函数每个 tick 都跑一次，每次都把下次触发
       -- 推到"现在之后"，于是它**永远不会到期，定时永远不跑**。
       -- 而症状极其隐蔽 —— 心跳正常、排程行在、next_fire_at 看着完全合理。
       next_fire_at = CASE
         WHEN schedules.cron IS DISTINCT FROM EXCLUDED.cron
           OR schedules.timezone IS DISTINCT FROM EXCLUDED.timezone
         THEN EXCLUDED.next_fire_at
         ELSE schedules.next_fire_at
       END,
       updated_at = CASE
         WHEN schedules.cron IS DISTINCT FROM EXCLUDED.cron
           OR schedules.timezone IS DISTINCT FROM EXCLUDED.timezone
         THEN now() ELSE schedules.updated_at
       END`,
    [flowId, cron, timezone, next],
  )
}
