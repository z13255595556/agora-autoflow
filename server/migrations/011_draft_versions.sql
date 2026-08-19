-- 调试运行的定义快照。
--
-- 手动运行 = 调试，跑的必须是画布上的**草稿** —— 在此之前它跑的是已发布版本，
-- 于是「改完图点运行、结果没变」，而且流程从未发布时第一次手动运行还会**隐式发一版**，
-- 用户没点发布线上就已经换了。
--
-- 但 runs.flow_version 的复合外键要求执行的定义在 flow_versions 里有一行
-- （002 的注释：「钉住当时那份定义，流程改了之后历史记录仍然解释得通」）。
-- 于是调试也钉快照，但用**负数版本号**：和发布共用一张表，所以 worker 的
-- loadFlowVersion / publisherOf 一行不用改、运行记录事后仍解释得通；
-- 却完全不参与发布编号，也不动 active_version。
--
-- 为什么不给 flow_versions 单独一套计数器：主键是 (flow_id, version)，
-- runs 的复合外键钉着它。两套从 1 开始的计数器会主键冲突，要修就得改主键，
-- 也就是动这个 schema 里最强的那条不变量 —— 代价和一个调试功能不对等。
--
-- 为什么不是「固定一行 -1，每次覆盖」：那会让 flow_versions 出现**可变的一行**，
-- 而 001 那条「版本快照不可变」正是为了不让「运行记录钉住的定义不会变」退化成
-- 一句约定。上午跑 A 版、9:05 改成 B 版再跑，两条 run 都指向 -1 —— 上午那条
-- 运行记录就开始说谎了，而调试恰恰是最需要「我刚才到底跑的哪一版」的场景。
ALTER TABLE flow_versions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'published';

-- 让「负数 = 调试」成为数据库校验的事实，而不是一句注释。
-- 少了它，将来谁写一句 MAX(version)+1 会静默算出 0 或负数 —— 而 active_version
-- 指向 0 之后所有触发都取不到定义，全程没有任何报错。
ALTER TABLE flow_versions DROP CONSTRAINT IF EXISTS flow_versions_kind_ck;
ALTER TABLE flow_versions ADD CONSTRAINT flow_versions_kind_ck
  CHECK ((kind = 'published' AND version > 0) OR (kind = 'draft' AND version < 0));

-- 取「最近一条调试快照」（去重复用）和清理器扫孤儿快照都走这条。
-- 按 created_at 而不是 version 排：负数域里 -1 > -2，按 version 排方向是反的。
CREATE INDEX IF NOT EXISTS flow_versions_draft_idx
  ON flow_versions (flow_id, created_at DESC) WHERE version < 0;

-- ─────────────────────────────────────────── 顺带修：清理运行日志会被外键挡住
--
-- 引用 runs 的四张表里，steps / run_events / alerts 都是 ON DELETE CASCADE，
-- 只有 webhook_deliveries 是 NO ACTION。于是 010 加的运行日志保留期
-- （purgeExpiredRuns 那条批量 DELETE FROM runs）一旦扫到任何超过保留期的
-- webhook 触发的 run 就抛外键错误，**整次清理失败**；而 worker 把异常吞掉
-- 只打一行日志 —— 任何用了 webhook 的部署，保留期实际上从来没生效过。
--
-- 用 SET NULL 而不是 CASCADE：投递记录本身要留着，「上游说发了但没跑」
-- 的争议全靠它，只是不再指向一条已经被清掉的运行。
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_run_id_fkey;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL;
