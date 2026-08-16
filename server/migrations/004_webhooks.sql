-- Webhook 触发。
--
-- 这是把内部工具变成「任何能 POST 的人都能触发一条 Hive 大查询」的口子，
-- 所以限流和认证不是可选项，是和功能一起上线的东西。

CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  flow_id     TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,

  -- URL 里那一段。32 字节随机，**不可枚举** —— 防止有人遍历 /hooks/1、/hooks/2。
  -- 但它**不是认证**：会进 nginx access log、进上游的配置文件、可能进 Referer
  token       TEXT NOT NULL UNIQUE,

  -- 真正的认证在第二层。存 hash，明文只在创建和轮换时给用户看一次
  secret_hash TEXT,
  auth_mode   TEXT NOT NULL DEFAULT 'secret',   -- secret | hmac | none

  -- lastNode（默认）：同步等待结束节点；immediate：202 + runId，立刻返回
  response_mode TEXT NOT NULL DEFAULT 'lastNode',
  response_timeout_seconds INT NOT NULL DEFAULT 300,

  enabled     BOOLEAN NOT NULL DEFAULT true,
  rate_limit_per_min INT NOT NULL DEFAULT 60,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS webhooks_flow_idx ON webhooks (flow_id);

-- 投递记录。「上游说发了但没跑」是这类集成最常见的争议，没有这张表就说不清。
--
-- **不存 body 原文**：body 里可能有用户 id、手机号、业务数据。
-- 只存字节数和摘要（够判断是不是重复投递），真要看 body 走 /api/runs/{id}
-- 那里受权限控制且经过脱敏。
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  webhook_id    TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES runs(id),   -- 被拒绝时为 NULL
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  remote_ip     TEXT,
  status_code   INT NOT NULL,
  reject_reason TEXT,
  body_bytes    INT,
  body_digest   TEXT
);

-- 限流按这条数：最近一分钟内这个 webhook 收了几次
CREATE INDEX IF NOT EXISTS webhook_deliveries_rate_idx
  ON webhook_deliveries (webhook_id, received_at DESC);

-- ─────────────────────────────────────────── 告警（旁路）
--
-- **告警不能是 DAG 里的一个节点。** 现在唯一的通知手段 notify.wecom 就是
-- 流程中的一个节点 —— SQL 挂了根本走不到它，最需要告警的情况恰好是
-- 告警发不出去的情况；而且整条流程静默停止，没有任何人会知道日报没发出来。
CREATE TABLE IF NOT EXISTS alerts (
  id          BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  flow_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- run_failed | run_crashed
  -- 去重键：同一个 flow + 同一类错误在抑制窗口内只发一条。
  -- **必须和告警同批上线** —— 数据平台挂半小时，十条流程各失败三次，
  -- 群里就是几十条消息，接着所有人把这个群设免打扰。
  -- 告警系统失效的标准路径，而且失效之后没人知道它失效了
  dedup_key   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | suppressed | failed
  attempts    INT NOT NULL DEFAULT 0,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  error       TEXT
);

-- 同一次运行的同一种告警只发一次（reaper 重试三次不该变成三条群消息）
CREATE UNIQUE INDEX IF NOT EXISTS alerts_once_idx ON alerts (run_id, kind);
CREATE INDEX IF NOT EXISTS alerts_pending_idx ON alerts (created_at) WHERE status = 'pending';

-- 告警要发到哪。credentialId 将来指向凭证层；现在直接放地址
ALTER TABLE flows ADD COLUMN IF NOT EXISTS notify_config JSONB;
