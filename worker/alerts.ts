import { pool } from './store.ts'

/**
 * 告警。**旁路投递，不是 DAG 里的一个节点。**
 *
 * 在此之前唯一的通知手段 notify.wecom 是流程中的一个节点 —— SQL 节点挂了
 * 就根本走不到它。**最需要告警的情况，恰好是告警发不出去的情况。**
 * 而且整条流程静默停止，没有任何人会知道日报没发出来。
 *
 * 三条硬规则：
 * 1. run 进终态时**写一行**，由同一个 worker tick 投递并重试
 * 2. **发送失败只记 error，绝不改 run 状态** —— 告警是运行的旁路，不是一环
 * 3. 抑制和告警同批上线：数据平台挂半小时、十条流程各失败三次，
 *    群里就是几十条消息，接着所有人把这个群设免打扰 ——
 *    告警系统失效的标准路径，而且失效之后没人知道它失效了
 */

/** 同一个 dedup_key 在这个窗口内只发一条，后续的记 suppressed */
const SUPPRESS_WINDOW_SECONDS = 600

const API = process.env.NODE_SERVICE ?? 'http://localhost:8791'

/**
 * run 进终态时登记一条告警。成功的运行不告警。
 *
 * dedup_key 取 流程 + 第一个失败节点 + 错误摘要：同一个原因反复失败
 * 只在窗口内发一条，而不同原因各自发。
 */
export async function recordRunAlert(runId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT r.flow_id, r.status, r.error, r.trigger_kind, r.scheduled_time,
            f.name AS flow_name, f.notify_config,
            (SELECT s.node_id FROM steps s
              WHERE s.run_id = r.id AND s.status = 'failed'
              ORDER BY s.seq LIMIT 1) AS failed_node,
            (SELECT s.error FROM steps s
              WHERE s.run_id = r.id AND s.status = 'failed'
              ORDER BY s.seq LIMIT 1) AS failed_error
       FROM runs r JOIN flows f ON f.id = r.flow_id
      WHERE r.id = $1`,
    [runId],
  )
  const r = rows[0]
  if (!r || r.status === 'success' || r.status === 'canceled') return
  if (!r.notify_config?.webhook) return   // 没配通知就不登记，避免堆一堆发不出去的

  const reason = String(r.failed_error ?? r.error ?? '未知错误').slice(0, 120)
  const dedup = `${r.flow_id}:${r.failed_node ?? '-'}:${reason.slice(0, 60)}`

  await pool.query(
    `INSERT INTO alerts (run_id, flow_id, kind, dedup_key, payload)
     VALUES ($1,$2,'run_failed',$3,$4)
     ON CONFLICT (run_id, kind) DO NOTHING`,
    [
      runId, r.flow_id, dedup,
      JSON.stringify({
        flowName: r.flow_name,
        failedNode: r.failed_node,
        reason,
        triggerKind: r.trigger_kind,
        scheduledTime: r.scheduled_time,
        webhook: r.notify_config.webhook,
      }),
    ],
  )
}

/**
 * 投递待发的告警。**发送失败绝不影响 run 的状态。**
 *
 * 返回发出去几条。
 */
export async function deliverPending(limit = 10): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, run_id, flow_id, dedup_key, payload, attempts FROM alerts
      WHERE status = 'pending' AND attempts < 3
      ORDER BY created_at LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  )

  let sent = 0
  for (const a of rows) {
    // 抑制：同一个原因在窗口内已经发过就不再发，但要留痕说明"是被抑制了"
    const { rows: recent } = await pool.query(
      `SELECT count(*)::int AS n FROM alerts
        WHERE dedup_key = $1 AND status = 'sent'
          AND sent_at > now() - ($2 || ' seconds')::interval`,
      [a.dedup_key, SUPPRESS_WINDOW_SECONDS],
    )
    if (recent[0].n > 0) {
      await pool.query(
        "UPDATE alerts SET status = 'suppressed', sent_at = now() WHERE id = $1", [a.id],
      )
      continue
    }

    const p = a.payload as Record<string, string>
    const text = [
      `【流程失败】${p.flowName}`,
      `失败节点：${p.failedNode ?? '（未定位）'}`,
      `原因：${p.reason}`,
      `触发方式：${p.triggerKind}`,
      `运行详情：/api/runs/${a.run_id}`,
    ].join('\n')

    try {
      const resp = await fetch(`${API}/nodes/notify.wecom/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { webhook: p.webhook, msgtype: 'text', content: text } }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      await pool.query("UPDATE alerts SET status = 'sent', sent_at = now() WHERE id = $1", [a.id])
      sent++
    } catch (err) {
      // ★ 只记在 alerts 上。run 的状态一个字都不动
      await pool.query(
        `UPDATE alerts SET attempts = attempts + 1, error = $2,
           status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END
         WHERE id = $1`,
        [a.id, err instanceof Error ? err.message : String(err)],
      )
    }
  }
  return sent
}
