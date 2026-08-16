-- 节点级幂等。
--
-- **必须先于重试上线。** 否则"重试"和"崩溃恢复"两个功能都会变成
-- "群里收到三条一样的日报"。
--
-- 键由 worker 确定性地算出来：run_id:node_id:loop_path。
-- **含 iteration 但不含 attempt** —— 含了等于没有去重，每次重试 key 都变。
CREATE TABLE IF NOT EXISTS node_idempotency (
  key        TEXT PRIMARY KEY,
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS node_idem_gc_idx ON node_idempotency (created_at);
