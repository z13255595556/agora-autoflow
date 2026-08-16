-- Webhook 密钥允许在管理面板持续查看。
--
-- secret_hash 仍用于认证，避免认证逻辑依赖可回显字段；secret_plain 只供受保护的
-- /api/flows/{id}/webhook 管理接口读取。历史记录无法从 hash 还原，轮换后才会有值。
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS secret_plain TEXT;
