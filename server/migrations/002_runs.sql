-- 运行的持久化。
--
-- 在此之前执行跑在浏览器内存里：关掉标签页流程就断，运行记录只留最近 20 条
-- 且刷新即失。这张表落地之后「关掉浏览器流程照跑」才成立。

CREATE TYPE run_status AS ENUM ('queued','running','canceling','success','error','canceled');
CREATE TYPE step_status AS ENUM ('queued','running','waiting','success','failed','skipped','canceled');

-- ─────────────────────────────────────────── 运行

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  flow_id        TEXT NOT NULL REFERENCES flows(id),
  -- 钉住当时那份定义。流程改了之后历史记录仍然解释得通 ——
  -- 不钉的话「这个节点当时为什么输出这个」永远查不明白。
  -- 必须读它而不是 flows.active_version：redrive 时尤其致命
  flow_version   INT  NOT NULL,
  status         run_status NOT NULL DEFAULT 'queued',
  -- manual 才认 pinData（n8n executionMode 语义）；production 一律忽略
  mode           TEXT NOT NULL DEFAULT 'manual',
  trigger_kind   TEXT NOT NULL DEFAULT 'manual',
  trigger_input  JSONB NOT NULL DEFAULT '{}',

  -- 计划执行时刻。**独立字段，不复用 started_at。**
  -- 日期基准、SLA 判定、backfill、幂等键四件事全挂在它上面，
  -- 是整套设计里最不可事后追加的一个字段。
  -- 手动运行时等于创建时刻；定时触发时是那个整点。
  scheduled_time TIMESTAMPTZ NOT NULL DEFAULT now(),

  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,

  -- 租约：worker 认领后写入，心跳续期。过期由 reaper 回收。
  -- 没有它的话 worker 崩了，run 永远停在 running 没人碰
  lease_owner    TEXT,
  lease_expires  TIMESTAMPTZ,
  attempt        INT NOT NULL DEFAULT 0,

  -- 取消意图。**是 run 级事实**，steps 里没有它的投影 ——
  -- decide() 必须能看见它，否则取消一条流程时下游的 notify.wecom
  -- 仍会被判为可跑，取消反而多发一条消息
  cancel_requested_at TIMESTAMPTZ,

  -- 同一个 key 只产生一个 run（定时重复触发、webhook 重投、上游重试）
  idempotency_key TEXT,

  FOREIGN KEY (flow_id, flow_version) REFERENCES flow_versions(flow_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_idem_idx
  ON runs (flow_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- 队列扫描走这条：认领时只看 queued
CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs (created_at) WHERE status = 'queued';
-- reaper 扫这条
CREATE INDEX IF NOT EXISTS runs_lease_idx ON runs (lease_expires) WHERE status IN ('running','canceling');
CREATE INDEX IF NOT EXISTS runs_flow_idx ON runs (flow_id, created_at DESC);

-- ─────────────────────────────────────────── 步骤（执行状态的当前真相）

CREATE TABLE IF NOT EXISTS steps (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  -- 循环路径。'{}' = 不在任何循环体内。数组而不是单个下标：
  -- 嵌套循环放开时一个字段都不用改
  loop_path   INT[] NOT NULL DEFAULT '{}',

  status      step_status NOT NULL,
  attempt     INT NOT NULL DEFAULT 0,

  input       JSONB,
  output      JSONB,
  error       TEXT,
  -- 只在 failed 时有意义。business 不重试，infra 才重试
  failure_kind TEXT,
  -- 只在 waiting 时有意义：poll（等平台）/ retry（等退避）/ fanout（等迭代）
  wait_kind   TEXT,

  -- flow.if 的判定结果。**必须持久化**：重算意味着 decide() 要去解析表达式，
  -- 那它就不再是纯的了，而且条件里可能引用了已被清理的大 output
  matched     BOOLEAN,
  -- flow.foreach 展开了几项。decide() 靠它决定体内跑几次、跑在哪些路径上
  fanout      INT,

  -- 异步节点的断点。**恢复时靠它 re-attach，绝不重新 submit** ——
  -- 重新 submit 意味着平台上多一个 Hive 大查询，第一个还在跑且没人持有它的 handle。
  -- submit_key 先于请求落库：那一刻还没有 handle，但必须已经有"我即将 submit"的痕迹
  progress    JSONB NOT NULL DEFAULT '{}',
  next_wake_at TIMESTAMPTZ,

  -- 为什么没跑。三套灭活逻辑产生的 skipped 在界面上长得一模一样，
  -- 而这是替换调度逻辑时唯一的验证手段
  skip_reason JSONB,

  seq         BIGINT NOT NULL,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,

  PRIMARY KEY (run_id, node_id, loop_path)
);

-- deferred / retry 的唤醒循环扫这条
CREATE INDEX IF NOT EXISTS steps_wake_idx ON steps (next_wake_at)
  WHERE status = 'waiting';

-- ─────────────────────────────────────────── 事件（append-only）

-- steps 是「当前真相」，这里是「发生过什么」。两者职责不同：
-- 前者给 decide() 算下一步，后者给 SSE 增量推送和事后回放。
CREATE TABLE IF NOT EXISTS run_events (
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INT  NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  type       TEXT NOT NULL,
  node_id    TEXT,
  loop_path  INT[],
  payload    JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, seq)
);
