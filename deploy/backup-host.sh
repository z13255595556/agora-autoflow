#!/usr/bin/env bash
# 宿主机部署（systemd + 本机 PostgreSQL）的每日备份 + 清理。
#
# docker compose 那套见 backup.sh，**两者不要同时挂** —— 会互相覆盖备份文件，
# 而且清理语句跑两遍没有意义。
#
# 挂 root 的 cron（脚本内部要 sudo -u postgres，非 root 跑不了）：
#   sudo crontab -e
#   0 3 * * * /home/devops/ka/autoflow/deploy/backup-host.sh >> /var/log/autoflow-backup.log 2>&1
#
# **流程定义是用户的心血，运行记录可以丢，定义不能。**
# flows.draft 和 flow_versions.definition 是这份备份真正的目的，
# 其余表丢了都能重来。
set -euo pipefail

OUT="${BACKUP_DIR:-/var/backups/autoflow}"
KEEP_DAYS="${KEEP_DAYS:-30}"
UNIT="${UNIT:-autoflow-api}"
DAY=$(date +%F)

[ "$(id -u)" -eq 0 ] || { echo "✗ 要用 root 跑（内部 sudo -u postgres）" >&2; exit 1; }

# 700：里面是数据库全量和明文凭证，不能让同机其他用户读
install -d -m 700 "$OUT"

dump() {
  local db="$1"
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
    echo "− 跳过 $db（库不存在）"
    return
  fi
  # 先写 .part 再改名：**半截文件绝不能长得像一次成功的备份**。
  # 磁盘满或者进程被杀时，最糟的结果是"备份文件在、但恢复不出来"，
  # 而那件事通常要等到真的需要恢复的那天才会发现
  local tmp="$OUT/$db-$DAY.sql.gz.part"
  # set -o pipefail 已开：pg_dump 失败会让整条管道失败，不会留下一个空 gz
  sudo -u postgres pg_dump --clean --if-exists "$db" | gzip -9 > "$tmp"
  gzip -t "$tmp"                       # 压缩包本身完整吗
  [ -s "$tmp" ] || { echo "✗ $db 备份是空的" >&2; rm -f "$tmp"; exit 1; }
  mv "$tmp" "$OUT/$db-$DAY.sql.gz"
  chmod 600 "$OUT/$db-$DAY.sql.gz"
  echo "✓ $db  $(du -h "$OUT/$db-$DAY.sql.gz" | cut -f1)"
}

dump autoflow
dump autoflow_workspace

# ── 凭证
#
# app.env 不在 git 里：数据平台的机器人账号、WORKER_TOKEN、库连接串都在里面，
# 丢了要重新申请。位置从 systemd 单元问出来而不是写死 —— 写死的那天迁了目录，
# 备份会安静地少一样东西
ENV_FILE="${ENV_FILE:-$(systemctl show "$UNIT" -p EnvironmentFiles --value 2>/dev/null | awk '{print $1}')}"
if [ -n "$ENV_FILE" ] && [ -r "$ENV_FILE" ]; then
  install -m 600 "$ENV_FILE" "$OUT/env-$DAY"
  echo "✓ 凭证 $ENV_FILE"
else
  echo "⚠ 没找到凭证文件（UNIT=$UNIT），只备了数据库" >&2
fi

# ── 保留策略
find "$OUT" -maxdepth 1 -name '*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$OUT" -maxdepth 1 -name 'env-*'    -mtime +"$KEEP_DAYS" -delete

# ── 清理没人管的表
#
# worker 每小时只清 runs（级联 steps / run_events / alerts）和过期的调试快照。
# 下面这两张**没有任何东西在清**，会一直涨：
#   node_idempotency —— 每次带幂等键的节点执行一行，24 小时之后就没用了
#   webhook_deliveries —— 每次投递一行；run_id 是 ON DELETE SET NULL，
#     所以 run 被清掉之后它自己还留着（这是有意的：「上游说发了但没跑」的争议靠它）
sudo -u postgres psql -d autoflow -v ON_ERROR_STOP=1 -q -c "
  DELETE FROM node_idempotency   WHERE created_at  < now() - interval '24 hours';
  DELETE FROM webhook_deliveries WHERE received_at < now() - interval '90 days';
"
echo "✓ 清理完成  $(date '+%F %T')"
