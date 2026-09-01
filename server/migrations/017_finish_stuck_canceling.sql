-- 收尾历史上卡死在「取消中」的运行。
--
-- request_cancel 曾把还在排队的 run 置成 canceling，但没有任何角色会认领
-- 这个状态：claimRun 只认 queued；reaper 只扫租约过期的行，而排队的 run
-- 根本没有租约（lease_expires 是 NULL，NULL < now() 不成立）；wakeDeferred
-- 只认 running/queued；清理器只清终态。于是这些 run 永远显示「取消中」，
-- 连 14 天保留期都轮不到它们 —— 而且界面上看不出任何异常。
-- 代码已改成：从未被认领过的 run 请求取消时直接原子收尾
-- （见 runstore.request_cancel），这里把存量的收掉。
--
-- started_at IS NULL = 从未被任何 worker 认领过（claimRun 认领时才写它）。
-- 钉住这个收窄条件：万一有跑过的行不知怎么进了 canceling，直接判终态
-- 会把它可能还持着的平台任务漏撤 —— 那种行宁可留着人工看。
-- 不补 run.finished 事件 —— 这些 run 从没跑起来过，没有订阅者要回放它们。
UPDATE runs SET status = 'canceled', finished_at = now()
 WHERE status = 'canceling' AND lease_owner IS NULL AND started_at IS NULL;
