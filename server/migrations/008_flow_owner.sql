-- 流程归属。
--
-- 在此之前谁都能看见、改动、发布、归档所有人的流程 —— 001 那条「不做 RBAC，
-- 只回答谁改的」在只有几个人共用时成立，但流程里躺着企微群机器人地址、
-- HTTP 节点的凭证、以及跑出来的查询结果，串在一起就不再只是"不整洁"。
--
-- owner 是**邮箱**（从 athena 的 HCIAuthToken 里解出来的那个），不是 basic auth
-- 的用户名 —— 数据平台按邮箱裁决查询权限，两处身份必须是同一个，否则
-- "这条流程是我的"和"这条流程用我的权限查数"会在某天对不上。
--
-- NULL 的含义是**这条迁移之前建的流程，还没有主**。不给它们随便指派一个人：
-- 指派错了比没指派更难发现。无主流程对所有人可见，谁发布一次就归谁
-- （见 flowstore.publish 里的 COALESCE）—— 让归属通过正常使用长出来，
-- 而不是靠一次拍脑袋的批量 UPDATE。
ALTER TABLE flows ADD COLUMN IF NOT EXISTS owner TEXT;

-- 列表页唯一的查询模式：我的（外加无主的），按更新时间倒序
CREATE INDEX IF NOT EXISTS flows_owner_idx ON flows (owner, updated_at DESC);
