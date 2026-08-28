#!/usr/bin/env bash
# 裸机（不用 Docker）跑 Python 代码节点的沙箱服务。
#
#   bash scripts/sandbox.sh            # 前台跑；服务器上用 systemd/nohup 包一层常驻
#
# 然后在 api 的 server/.env 里配 SANDBOX_URL=http://127.0.0.1:9000 并重启 api
# （或者在管理页「Python 依赖」点「重新对账」）。
#
# 隔离说明，别骗自己：
# - 和 api 同一个用户跑：环境变量对用户代码是清空的，但**文件系统没有隔离**，
#   用户代码能直接读 server/.env 里的全部凭证。内部工具可以接受的话就这么跑。
# - 加固档（推荐）：建一个独立低权用户跑本脚本，并把 server/.env chmod 600 ——
#   用户代码以低权用户执行，凭证文件直接读不到。做法见 README「Python 代码节点」。
# - 真正的边界仍然是容器（docker compose 里已内置 sandbox 服务）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SANDBOX_PORT="${SANDBOX_PORT:-9000}"
# 只听本机：这个服务没有任何认证，靠"只有本机的 api 能连到它"兜底。
# 要跨机部署沙箱，把它放到内网防火墙后面再改这个值
SANDBOX_HOST="${SANDBOX_HOST:-127.0.0.1}"
VENV="server/.venv"
SANDBOX_VENV="${SANDBOX_VENV:-server/.venv-sandbox}"

if [ ! -x "$VENV/bin/python" ]; then
  echo "✗ 没有 $VENV —— 先按 README 起过一次 api（scripts/dev.sh 会自动建），或手动："
  echo "  python3 -m venv $VENV && $VENV/bin/pip install -r server/requirements.txt"
  exit 1
fi

# 用户代码的独立 venv。只建空壳 —— 预装包清单的正本在 sandbox_packages 表里，
# api 起来后会推过来装（管理页「重新对账」也会）
if [ ! -x "$SANDBOX_VENV/bin/python" ]; then
  echo "→ 建沙箱 venv（$SANDBOX_VENV）…"
  python3 -m venv "$SANDBOX_VENV"
  "$SANDBOX_VENV/bin/pip" install -q --upgrade pip
fi

# 端口占着就先收掉旧的（同 dev.sh 的理由：改了代码没生效这种问题查起来很贵）
if lsof -tiTCP:"$SANDBOX_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "→ 端口 $SANDBOX_PORT 上有旧进程，先停掉"
  lsof -tiTCP:"$SANDBOX_PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 1
fi

echo "→ 启动沙箱服务 http://$SANDBOX_HOST:$SANDBOX_PORT（用户代码解释器：$SANDBOX_VENV）"
echo "  前台常驻。出现「Uvicorn running on …」即就绪；另开窗口可验证："
echo "  curl http://127.0.0.1:$SANDBOX_PORT/health"
# 日志用 uvicorn 默认档（info），**不要压到 warning**：就绪提示是 INFO 级，
# 压掉之后成功启动和卡死看起来一模一样 —— 有人真的以为它挂了。
# 顺带每次执行留一行访问日志，出问题时能对上"哪次调用"
exec env PYTHONPATH=server SANDBOX_PYTHON="$SANDBOX_VENV/bin/python" \
  "$VENV/bin/python" -m uvicorn service:app \
  --app-dir sandbox --host "$SANDBOX_HOST" --port "$SANDBOX_PORT"
