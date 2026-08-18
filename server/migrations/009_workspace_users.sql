-- AutoFlow 控制库中的工作区身份映射。用户表始终位于独立的
-- autoflow_workspace 数据库；这里不保存任何工作区密码。
CREATE TABLE IF NOT EXISTS workspace_users (
  email          TEXT PRIMARY KEY,
  role_name      TEXT NOT NULL UNIQUE,
  schema_name    TEXT NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_bytes     BIGINT NOT NULL DEFAULT 0,
  quota_exceeded BOOLEAN NOT NULL DEFAULT false
);
