-- 同步 Webhook 的等待上限。运行超过这个时间不会被取消，调用方改拿 runId 查询。
ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS response_timeout_seconds INT NOT NULL DEFAULT 300;

ALTER TABLE webhooks ALTER COLUMN response_mode SET DEFAULT 'lastNode';
