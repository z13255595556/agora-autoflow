-- 定时触发。
--
-- 在此之前 trigger.schedule **只有 UI**：节点配得好好的、界面翻译成
-- 「每天 09:00」显示给用户，但没有任何进程会在 09:00 跑它。
-- 这不是"功能还没做"，是界面在撒谎。

CREATE TABLE IF NOT EXISTS schedules (
  flow_id     TEXT PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,

  -- **存储层只认 cron 一种。** UI 的四种模式（daily/hourly/interval/cron）
  -- 在发布时归一成它 —— 调度器不必为四种模式各写一份"下次几点"的计算。
  cron        TEXT NOT NULL,

  -- IANA 名（Asia/Shanghai），**不是 UTC 偏移**：偏移量在有夏令时的地区是错的，
  -- 而且错法隐蔽 —— 一年里只有两天会错，错一小时
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',

  enabled     BOOLEAN NOT NULL DEFAULT true,

  -- 下次该触发的时刻。调度器扫的就是它
  next_fire_at TIMESTAMPTZ NOT NULL,
  last_fire_at TIMESTAMPTZ,

  -- 错过了触发窗口怎么办。
  --   fire_once（默认）：补跑一次，但只补最近的那一次
  --   skip：直接跳到下一个点
  -- 默认 fire_once 而不是 skip：机器夜里重启，早上 9 点的日报 10 点补发一次
  -- 是有价值的；skip 会让今天彻底没有日报**而且用户不知道** —— 那正是
  -- 这个项目要消灭的失败模式。刷屏问题由 grace 窗口和重叠策略解决，
  -- 不该用"干脆不跑"来解决
  misfire     TEXT NOT NULL DEFAULT 'fire_once',
  -- 迟到多久之内还值得补。超过就放弃这一次，直接排下一次
  grace_seconds INT NOT NULL DEFAULT 3600,

  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules (next_fire_at) WHERE enabled;

-- ─────────────────────────────────────────── 并发与重叠

ALTER TABLE flows
  -- 同一把钥匙下只允许一条在跑。默认按流程分组；
  -- 写成表达式可以按参数分组（比如不同 vid 互不阻塞）
  ADD COLUMN IF NOT EXISTS concurrency_key TEXT,
  -- 上一次还没跑完时怎么办：skip（默认）/ queue / cancel_running
  --
  -- **必须和调度器同批上线**：trigger.schedule 的 interval 模式最小 1 分钟，
  -- 而 Hive 查询跑几分钟 —— 第二次触发在第一次没跑完时启动，
  -- 群里就是两条日报，接着两条 SQL 同时压平台
  ADD COLUMN IF NOT EXISTS on_overlap TEXT NOT NULL DEFAULT 'skip';

-- ─────────────────────────────────────────── 同一时刻只触发一次
--
-- **锁是性能优化，唯一约束才是正确性保证。** 两者都要：
-- advisory lock 让多个 worker 里只有一个在扫表（省 CPU），
-- 而这条约束保证即使锁失效也不会重复入队。
--
-- 键里必须含 trigger_kind：同一个 scheduled_time 上的手动重跑不算重复。
CREATE UNIQUE INDEX IF NOT EXISTS runs_sched_once_idx
  ON runs (flow_id, trigger_kind, scheduled_time)
  WHERE trigger_kind <> 'manual';

-- ─────────────────────────────────────────── 调度器心跳
--
-- 「定时触发未生效」那行提示不能靠一个硬编码常量控制 ——
-- 调度器静默死掉和从来没有过是同一种后果，而且更隐蔽：
-- 那时用户有理由相信它在跑。所以前端读的是这张表，不是常量。
CREATE TABLE IF NOT EXISTS worker_heartbeat (
  id        TEXT PRIMARY KEY,
  role      TEXT NOT NULL,
  beat_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
