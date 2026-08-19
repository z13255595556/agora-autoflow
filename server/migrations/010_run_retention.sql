-- 运行日志的保留期。
--
-- steps 里装的是每个节点的输入输出 —— 查询结果本身，比流程定义敏感也比它大。
-- 不清理的话库只会单调膨胀，最终把控制库拖垮。保留 14 天（可用
-- RUN_RETENTION_DAYS 调）：足够回查"上周那次为什么发错了"，又不至于
-- 永久囤着别人的查询结果。
--
-- 清理本身由 worker 周期执行（见 worker/store.ts 的 purgeExpiredRuns）；
-- steps 和 run_events 都是 ON DELETE CASCADE，删 runs 一条就全干净。
-- 这里只建扫描用的索引：只对终态行建（partial），清理扫描不碰在跑的 run。
CREATE INDEX IF NOT EXISTS runs_retention_idx ON runs (finished_at)
  WHERE status IN ('success','error','canceled');
