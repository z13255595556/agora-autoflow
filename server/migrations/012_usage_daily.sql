-- 用量统计的按天聚合。**统计要活得比明细久。**
--
-- 运行明细（runs/steps）只留 14 天 —— steps 里装的是查询结果本身，既大又敏感，
-- 不能永久囤着。但「这条流程今年一共跑了多少次」「谁在用」这类问题不该跟着一起
-- 消失：它们只需要计数，不需要任何一行结果数据。
--
-- 所以清理之前先把那一天汇总成几行存在这里。明细 14 天，统计永久。
--
-- flow_name / owner 是**快照，不是外键**：统计要在流程被删掉之后仍然读得懂。
-- 每次滚动都会刷新它们，所以正常情况下跟得上改名。
CREATE TABLE IF NOT EXISTS usage_daily (
  day           DATE NOT NULL,
  flow_id       TEXT NOT NULL,
  -- 手动 / 定时 / webhook 分开存。合并之后就再也拆不出「有多少是人手点的」，
  -- 而这恰恰是判断一条流程是不是真的自动化起来了的唯一依据
  trigger_kind  TEXT NOT NULL,

  flow_name     TEXT NOT NULL DEFAULT '',
  owner         TEXT,

  runs          INT NOT NULL DEFAULT 0,
  succeeded     INT NOT NULL DEFAULT 0,
  failed        INT NOT NULL DEFAULT 0,
  canceled      INT NOT NULL DEFAULT 0,

  -- 存总和而不是均值：**均值不可加**。按天存了均值之后，"最近 30 天平均耗时"
  -- 就只能算出"30 个日均值的均值"，那是另一个数，且跑得多的那天被稀释掉了
  duration_ms   BIGINT NOT NULL DEFAULT 0,
  -- 均值的分母。没结束的运行没有耗时，不能算进去，否则均值会被系统性拉低
  timed_runs    INT NOT NULL DEFAULT 0,

  -- 节点执行次数。运行次数看不出规模 —— 一条 20 节点的流程和一条 2 节点的
  -- 在"跑了 100 次"这个口径下一模一样
  steps         INT NOT NULL DEFAULT 0,

  rolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (day, flow_id, trigger_kind)
);

CREATE INDEX IF NOT EXISTS usage_daily_day_idx ON usage_daily (day DESC);
CREATE INDEX IF NOT EXISTS usage_daily_owner_idx ON usage_daily (owner, day DESC);
