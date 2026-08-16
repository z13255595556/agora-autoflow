#!/usr/bin/env bash
# 每日备份 + 保留策略。挂 cron：0 3 * * * /path/to/deploy/backup.sh
#
# **流程定义是用户的心血，运行记录可以丢，定义不能。**
set -euo pipefail
OUT="${BACKUP_DIR:-/var/backups/workflow}"
mkdir -p "$OUT"
DAY=$(date +%F)
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml")

# 直接在 Postgres 容器内执行，不在宿主机复制数据库密码，也不要求安装 psql。
"${COMPOSE[@]}" exec -T postgres pg_dump -U workflow workflow | gzip > "$OUT/workflow-$DAY.sql.gz"
# 保留 30 天
find "$OUT" -name 'workflow-*.sql.gz' -mtime +30 -delete

# run_events 会长得很快。90 天以上删事件明细，**保留 runs 主记录** ——
# "这条流程去年为什么发了那个数"仍然要答得上来
"${COMPOSE[@]}" exec -T postgres psql -U workflow -d workflow -c "
  DELETE FROM run_events WHERE ts < now() - interval '90 days';
  DELETE FROM webhook_deliveries WHERE received_at < now() - interval '90 days';
  DELETE FROM node_idempotency WHERE created_at < now() - interval '24 hours';
  DELETE FROM alerts WHERE created_at < now() - interval '90 days';
"
