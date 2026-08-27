-- 每个人自己的失败通知地址。
--
-- 在此之前告警只能**按流程**配（flows.notify_config，004 建的列，ee34e11 补的界面）：
-- 想收到告警，得进每一条流程的设置里各配一遍。新建一条流程就默默地没有告警 ——
-- 而"这条流程没有告警"这件事本身不会以任何形式表现出来，直到某天日报没发出来
-- 也没人知道。这正是 worker/alerts.ts 开头那段想解决的问题，只是解决了一半。
--
-- email 是主键，和 flows.owner 同一个身份（athena 的 HCIAuthToken 解出来的那个）。
-- 008 那段注释讲的就是这件事：归属、查数权限、告警投递必须共用一个身份，
-- 否则"这条流程是我的"和"它失败了通知我"会在某天对不上，而且是静默的。
--
-- **有行 = 配了，删行 = 关掉。** webhook 声明成 NOT NULL 是刻意的：
-- 留一个可空列就多出"有行但地址是 NULL"这种既不是开也不是关的第三态，
-- 而读它的是 worker 里一句 COALESCE —— 第三态在那里会退化成静默不发。
--
-- 和 flows.notify_config 的关系：**流程级覆盖用户级**（worker/alerts.ts 里的 ??）。
-- 语义是"这条关键流程单独发到值班群，其余都进我的个人群"。
CREATE TABLE IF NOT EXISTS user_notify_settings (
  email      TEXT PRIMARY KEY,
  webhook    TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
