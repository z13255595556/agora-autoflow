#!/usr/bin/env bash
# 一条命令拉起整套：SQL 节点服务 + 前端 dev server。
#
# 凭证由 server/.env 自动加载，使用者不需要知道里面是什么。
# 退出时会把后端一起收掉 —— 否则改天再跑会撞端口，而且带着凭证的进程
# 不该在后台无声无息地活着。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 刻意不叫 PORT —— 各种启动器（IDE、预览面板）会把 PORT 设成前端端口，
# 复用这个名字会让后端去抢前端的端口，且现象很隐蔽。
# 8787 也别用，被内网 agora-gateway 占着。
API_PORT="${API_PORT:-8791}"
WEB_PORT="${WEB_PORT:-5273}"
VENV="server/.venv"

# ---------- 后端 ----------
if [ ! -x "$VENV/bin/python" ]; then
  echo "→ 首次运行，建 venv 并装依赖…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r server/requirements.txt
fi

# Python 代码节点的沙箱 venv。独立于 server/.venv：那边装着 psycopg/fastapi，
# 共用等于把服务端依赖面整个递给用户代码。这里只建空壳 —— 预装包清单的
# 正本在 sandbox_packages 表里，api 启动时对账安装（管理员页面可增删）。
SANDBOX_VENV="server/.venv-sandbox"
if [ ! -x "$SANDBOX_VENV/bin/python" ]; then
  echo "→ 建 Python 代码节点的沙箱 venv（$SANDBOX_VENV）…"
  python3 -m venv "$SANDBOX_VENV"
  "$SANDBOX_VENV/bin/pip" install -q --upgrade pip
fi

if [ ! -f server/.env ]; then
  echo "⚠ 没有 server/.env —— SQL 节点会因缺凭证报错，其余节点仍走 mock。"
  echo "  照 server/.env.example 建一份即可。"
fi

# 端口占着就先收掉旧的，避免"改了代码没生效"这类找半天的问题
if lsof -tiTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "→ 端口 $API_PORT 上有旧进程，先停掉"
  lsof -tiTCP:"$API_PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 1
fi

# --reload：改一行 Python 就自动重起。不加的话每次改后端都要整个停掉再起，
# 而"改了没生效"这种问题查起来很贵 —— 现象是代码明明改了行为却是旧的。
# --reload-dir 限定只看 sql_service：不限的话 reloader 会去遍历 .venv 和
# node_modules，启动慢好几秒，还会因为文件数过多在 macOS 上撞 fd 上限。
echo "→ 启动 SQL 节点服务 :${API_PORT}（改 server/ 下的代码会自动重载）"
(cd server && exec ../"$VENV"/bin/python -m uvicorn sql_service.main:app \
  --port "$API_PORT" --host 127.0.0.1 --log-level warning \
  --reload --reload-dir sql_service) &
API_PID=$!

cleanup() {
  echo
  echo "→ 收掉 SQL 节点服务"
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  # reloader 是父子两个进程。父进程收到 TERM 时一般会带走子进程，但它没来得及
  # （或者被 -9 掉）时子进程会继续占着端口，下次启动就撞端口。按端口再扫一遍兜底
  lsof -tiTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 等它起来，顺便把凭证状态说清楚
for _ in $(seq 1 15); do
  sleep 0.5
  if HEALTH=$(curl -s -m 2 "http://127.0.0.1:$API_PORT/health" 2>/dev/null); then
    case "$HEALTH" in
      *'"ok":true'*)  echo "  ✓ 已连接数据平台，SQL 节点走真实执行" ;;
      *)              echo "  ⚠ 服务在，但缺凭证 —— SQL 节点会报错，其余节点走 mock" ;;
    esac
    break
  fi
done

# ---------- 前端 ----------
[ -d node_modules ] || { echo "→ 装前端依赖…"; npm install; }

echo "→ 启动前端 http://localhost:$WEB_PORT"
echo
# 显式传端口并清掉继承来的 PORT —— vite 也会读它，不清的话两边抢同一个口
unset PORT
exec npx vite --port "$WEB_PORT" --strictPort
