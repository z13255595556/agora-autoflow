-- 流程的启停开关（首页卡片右上角那个）。
--
-- 停止 = **自动触发不再跑**：调度器只推进 next_fire_at 不入队，webhook 收到
-- 请求回 409。手动运行**不受影响** —— 停下来通常是为了修它，修好了总得先
-- 手动跑一次验证，才谈得上重新启用。
--
-- 为什么是 flows 上的一列，而不是复用 schedules.enabled：
--   1. webhook 触发的流程根本没有 schedules 行，没处可停；
--   2. schedules 行归调度器管 —— 触发器改成手动再改回来、或撤下发布，
--      那一行会被 syncAllSchedules 删掉重建，寄存在上面的开关状态会静默丢，
--      而且丢的样子就是"流程自己又跑起来了"。
--
-- 存时刻不存布尔：和 archived_at 同一个模式。「停了多久」在排查
-- "为什么这周的日报一直没发"时是第一个要回答的问题。NULL = 在跑。
ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
