-- 流程定义的持久化。
--
-- 在此之前流程存在每个人自己浏览器的 localStorage 里：换台机器就没了、
-- 同事看不到、刷新可能丢。这是把编排搬到服务端的第一步。

-- ─────────────────────────────────────────── 流程

CREATE TABLE IF NOT EXISTS flows (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,

  -- 草稿 = 编辑器里的当前内容。发布才产生一个不可变版本。
  -- 放在 flows 上而不是 flow_versions 里加一个 is_draft 标记，
  -- 是为了让"flow_versions 每一行都不可变"这句话字面成立 —— 一旦有一行
  -- 是可变的，"运行记录钉住的那份定义不会变"就只是个约定而不是约束。
  draft          JSONB NOT NULL,

  -- 已发布并生效的版本号。NULL = 从未发布。
  -- 定时和 webhook 只触发这一版，草稿改坏了不影响线上。
  active_version INT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 归档而不是物理删：运行记录会外键指向流程版本，删掉就没法解释历史了
  archived_at    TIMESTAMPTZ
);

-- ─────────────────────────────────────────── 版本快照（不可变）

CREATE TABLE IF NOT EXISTS flow_versions (
  flow_id    TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version    INT  NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  PRIMARY KEY (flow_id, version)
);

-- flows.active_version 必须指向真实存在的版本。
-- 不用外键约束是因为它可以为 NULL 且 flows 先于 flow_versions 插入；
-- 由 publish 事务保证。
CREATE INDEX IF NOT EXISTS flow_versions_flow_idx
  ON flow_versions (flow_id, version DESC);

-- ─────────────────────────────────────────── 审计（append-only）

-- 不做 RBAC。只回答"谁改的"——
-- 流程从各人的 localStorage 搬到共享服务器之后，
-- "谁把日报的 SQL 改坏了" 现在完全无法回答。
--
-- actor 由反向代理把 SSO 用户名带进请求头，服务端不自己做认证。
CREATE TABLE IF NOT EXISTS audit (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT,
  action      TEXT NOT NULL,      -- flow.create / flow.save / flow.publish / flow.archive
  target_type TEXT NOT NULL,      -- flow
  target_id   TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      JSONB
);

CREATE INDEX IF NOT EXISTS audit_target_idx ON audit (target_type, target_id, at DESC);
