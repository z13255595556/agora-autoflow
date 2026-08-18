# AutoFlow 物理机部署手册

本文记录 AutoFlow 在 Athena Ubuntu 22.04 服务器上的实际部署方式。该方案不使用
Docker，复用宿主机现有 Nginx 和 OA 认证。

## 部署信息

| 项目 | 当前配置 |
| --- | --- |
| 访问地址 | `https://athena.agoralab.co/autoflow/` |
| 项目目录 | `/home/devops/ka/autoflow` |
| 前端目录 | `/var/www/autoflow` |
| API | `127.0.0.1:8791` |
| PostgreSQL | `127.0.0.1:5432` |
| 数据库 / 用户 | `autoflow` / `athena` |
| API 服务 | `autoflow-api.service` |
| Worker 服务 | `autoflow-worker.service` |
| 环境文件 | `/home/devops/ka/autoflow/deploy/app.env` |
| Nginx 路由 | `/etc/nginx/sites-available/autoflow.conf` |

`80`、`443` 由宿主机现有 Nginx 监听。网页和控制接口经过现有 Athena OA；
`/autoflow/hooks/*` 不经过浏览器 OA，使用 Webhook Secret 或 HMAC 认证。

## 1. 系统依赖

当前验证版本：

```text
Ubuntu 22.04
Node.js 24.16.0（NVM）
Python 3.10.12
PostgreSQL 14
```

安装缺少的系统包：

```bash
sudo apt update
sudo apt install -y postgresql postgresql-client python3.10-venv
```

项目使用 Python 虚拟环境，不要在系统 Python 中执行 `sudo pip install`。

## 2. 获取代码

服务器直连 `github.com` 可能返回 `Empty reply from server`。官方 codeload 域名可用时：

```bash
mkdir -p /home/devops/ka/autoflow
curl -fL \
  https://codeload.github.com/z13255595556/agora-autoflow/tar.gz/refs/heads/main \
  | tar -xz --strip-components=1 -C /home/devops/ka/autoflow
```

这种方式不包含 `.git`，后续更新仍需重新下载代码包。不要把旧代码直接覆盖后就立刻
重启服务；参照本文“升级与回滚”一节先构建和验证。

## 3. PostgreSQL

创建数据库用户。密码由操作者设置，不得复用服务器登录密码：

```bash
sudo -u postgres createuser --pwprompt athena
sudo -u postgres createdb --owner=athena autoflow
```

从 `/home/devops/ka` 执行时，PostgreSQL 可能提示无法进入当前目录。这只是系统用户
`postgres` 无权访问用户目录的警告，不影响数据库命令。

验证连接：

```bash
psql -h 127.0.0.1 -U athena -d autoflow \
  -c "SELECT current_user, current_database();"
```

数据库只监听本机，不要将 `5432` 暴露到公网。API 首次访问数据库时会自动执行
`server/migrations/` 中尚未应用的迁移。

## 4. 安装依赖与构建

```bash
cd /home/devops/ka/autoflow

python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt

npm ci
VITE_PUBLIC_BASE=/autoflow/ npm run build
```

`VITE_PUBLIC_BASE` 不能遗漏，否则前端资源和页面跳转会错误地指向网站根目录。

发布静态文件：

```bash
sudo install -d -o root -g www-data -m 755 /var/www/autoflow
sudo cp -a dist/. /var/www/autoflow/
```

## 5. 环境变量

环境文件权限必须为 `600`：仅文件所有者可读写，服务器上的其他普通用户不可读取。

```bash
chmod 600 /home/devops/ka/autoflow/deploy/app.env
```

文件内容如下，所有占位值都必须替换，真实值不得提交到 Git：

```ini
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=autoflow
PGUSER=athena
PGPASSWORD=替换为数据库密码

NODE_SERVICE=http://127.0.0.1:8791
PUBLIC_BASE_PATH=/autoflow
CORS_ORIGINS=

OAUTH_CLIENT_ID=替换
OAUTH_CLIENT_SECRET=替换
OAUTH_USERNAME=替换
OAUTH_PASSWORD=替换

# Worker 代跑定时/Webhook 任务时，用它向 API 证明自己是 Worker。
# API 和 Worker 读的是同一个 EnvironmentFile，配一次两边都生效。
# 不配的话定时任务一律退回机器人账号的权限（fail closed），不会报错。
# 生成：openssl rand -hex 32
WORKER_TOKEN=替换

# 自建 PostgreSQL 节点的独立工作区库。不要使用上面的 autoflow 控制库账号。
# 先按本节下方的命令初始化数据库和管理员账号，再填入这个 DSN。
WORKSPACE_ADMIN_DSN=postgresql://autoflow_workspace_admin:替换为工作区管理员密码@127.0.0.1:5432/autoflow_workspace
# 生成：openssl rand -hex 32。长期保留，变更会轮换所有用户工作区账号密码。
WORKSPACE_ROLE_SECRET=替换
# 每个 OA 用户私有 schema 的软配额，默认 1 GiB。
WORKSPACE_QUOTA_BYTES=1073741824
```

用户身份不需要任何配置：本服务与 Athena 同域，浏览器 Cookie 会随请求送达 API。
API 服务只把原始 Cookie 转发到固定的 `https://athena.agoralab.co/api/me`，由 Athena
验证登录态并返回用户信息；AutoFlow 不解析 `HCIAuthToken`。返回的邮箱同时决定
**流程归属**和**查询用谁的数据权限**。

本机开发环境中的 OAuth 配置位于 `server/.env`，生产环境中应通过安全渠道逐项录入，
不要粘贴到聊天、工单或 Git 提交中。

验证环境文件格式和数据库密码，不输出密钥：

```bash
bash -c 'set -a; source "$HOME/ka/autoflow/deploy/app.env"; psql -c "SELECT current_user, current_database();"'
```

### 5.1 自建 PostgreSQL 工作区

自建 PostgreSQL 节点不会使用保存流程和运行记录的 `autoflow` 数据库。首次部署时，由
PostgreSQL 管理员创建独立的 `autoflow_workspace` 数据库和仅用于自动开通用户私有
schema 的管理员账号：

```bash
cd /home/devops/ka/autoflow
export WORKSPACE_ADMIN_PASSWORD="$(openssl rand -hex 32)"
./deploy/init-workspace-db.sh
```

将上面生成的密码安全写入 `WORKSPACE_ADMIN_DSN`，再生成并写入
`WORKSPACE_ROLE_SECRET`。执行节点时系统会按 OA 邮箱自动创建受限数据库角色和同名私有
schema；用户无法获得数据库地址或密码，也不能访问其他人的 schema 或 `autoflow`
控制库。

`WORKSPACE_ADMIN_DSN` 和 `WORKSPACE_ROLE_SECRET` 配置完成后重启 API 与 Worker：

```bash
sudo systemctl restart autoflow-api autoflow-worker
```

## 6. systemd

API 服务 `/etc/systemd/system/autoflow-api.service`：

```ini
[Unit]
Description=AutoFlow API
Wants=network-online.target
After=network-online.target postgresql.service

[Service]
Type=simple
User=devops
Group=devops
WorkingDirectory=/home/devops/ka/autoflow
EnvironmentFile=/home/devops/ka/autoflow/deploy/app.env
ExecStart=/home/devops/ka/autoflow/server/.venv/bin/python -m uvicorn sql_service.main:app --host 127.0.0.1 --port 8791 --app-dir /home/devops/ka/autoflow/server
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Worker 服务 `/etc/systemd/system/autoflow-worker.service`：

```ini
[Unit]
Description=AutoFlow Worker
Wants=network-online.target autoflow-api.service
After=network-online.target postgresql.service autoflow-api.service

[Service]
Type=simple
User=devops
Group=devops
WorkingDirectory=/home/devops/ka/autoflow
EnvironmentFile=/home/devops/ka/autoflow/deploy/app.env
ExecStart=/home/devops/.nvm/versions/node/v24.16.0/bin/node --experimental-strip-types /home/devops/ka/autoflow/worker/index.ts
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

NVM 升级 Node.js 后路径可能变化。升级前运行 `command -v node`，并同步修改 Worker
的 `ExecStart`。

加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now autoflow-api
sudo systemctl enable --now autoflow-worker
```

## 7. Nginx 与 OA

`/etc/nginx/sites-available/autoflow.conf` 是 location 片段，必须被包含在
`athena.agoralab.co` 的 HTTPS `server` 块内。当前通过下面一行从
`/etc/nginx/sites-available/tools.conf` 引入：

```nginx
include /etc/nginx/sites-available/autoflow.conf;
```

路由要求：

- `/autoflow/`：静态前端，使用 `auth_request /_ka_auth`。
- `/autoflow/api/*`：转发到 API `/api/*`，使用 OA。
- `/autoflow/registry/*`、`options/*`、`nodes/*`：转发到同名后端接口，使用 OA。
- `/autoflow/health`：转发到 `/health`，使用 OA。
- `/autoflow/whoami`：转发到 `/whoami`，使用 OA。**漏了它会落进 SPA 回退**，
  接口原地变成一张 HTML 首页——调用方拿到的是 200 加一段解析不了的 JSON 报错，
  很难往这上面想。首页那行「当前是 xxx 的工作台」就是从它来的。
- `/autoflow/hooks/*`：转发到 `/hooks/*`，关闭 OA，仅使用 Webhook 自身认证。
- Webhook `proxy_read_timeout` 至少为 `1810s`，大于同步响应最大等待时间 `1800s`。
- 静态目录使用 `root /var/www`，SPA 回退到 `/autoflow/index.html`。

修改配置后始终先检查，再平滑重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` 的既有 CIDR/MIME 警告不会阻止重载，但应由 Nginx 配置维护者另行修复。

## 8. 验收

本机健康检查：

```bash
curl -s http://127.0.0.1:8791/health
```

必须满足：

```json
{
  "ok": true,
  "missingCredentials": [],
  "storage": { "configured": true, "ok": true },
  "scheduler": { "alive": true }
}
```

身份自检（判断"这次以谁的权限查数"，排查权限问题的第一站）：

```bash
curl -s http://127.0.0.1:8791/whoami
```

本机直连没有浏览器 Cookie，预期是 `{"creator":null,"source":"none",...}`。
带上真实 Cookie 才能看到邮箱——用浏览器登录后打开
`https://athena.agoralab.co/autoflow/whoami`，预期：

```json
{ "creator": "你的邮箱@agora.io", "source": "athena", "note": null }
```

`source` 对浏览器用户必须是 `athena`。`none` 表示 Athena 未能验证登录态，此时
查询会使用机器人账号权限，不能作为已登录用户操作流程。

OA 跳转检查：

```bash
curl -I https://athena.agoralab.co/autoflow/
```

未带登录 Cookie 时预期返回 `302`，跳转到 `/api/auth/login?redirect=/autoflow/`。
最后使用浏览器完成 OA 登录并检查首页、流程保存/发布、SQL/HTTP 试运行和 Webhook。

## 9. 日常运维

查看状态：

```bash
sudo systemctl status autoflow-api --no-pager
sudo systemctl status autoflow-worker --no-pager
```

查看日志：

```bash
sudo journalctl -u autoflow-api -n 100 --no-pager
sudo journalctl -u autoflow-worker -n 100 --no-pager
sudo journalctl -u autoflow-api -f
```

重启：

```bash
sudo systemctl restart autoflow-api autoflow-worker
```

数据库备份：

```bash
install -d -m 700 /home/devops/backups/autoflow
PGPASSWORD='从安全存储读取' pg_dump \
  -h 127.0.0.1 -U athena -d autoflow -Fc \
  -f "/home/devops/backups/autoflow/autoflow-$(date +%F-%H%M%S).dump"
```

生产环境应使用受保护的 `.pgpass` 或备份服务注入密码，不要把真实密码直接写入
crontab。备份必须定期恢复演练，仅有 dump 文件不等于可恢复。

## 10. 升级与回滚

由于当前通过 codeload 获取代码，升级时应先在临时目录构建，不要直接破坏运行目录：

1. 下载新代码到独立目录，例如 `/home/devops/ka/autoflow-next`。
2. 创建虚拟环境并安装 Python/Node 依赖。
3. 执行 `npm test`、后端测试和 `VITE_PUBLIC_BASE=/autoflow/ npm run build`。
4. 备份 PostgreSQL。
5. 停止 Worker，再停止 API。
6. 保存旧目录为带时间戳的回滚目录，将新目录切换为 `/home/devops/ka/autoflow`。
7. 复制新的 `dist` 到 `/var/www/autoflow`。
8. 启动 API 和 Worker，检查 `/health` 及日志。

回滚代码前要先判断数据库迁移是否向后兼容。数据库迁移可能已经改变表结构，不能只
替换旧代码就假定可以回滚。

## 11. 升级到「按用户隔离」版本

这一版把流程、运行记录和查询权限都收到**登录邮箱**这一个维度下。升级步骤仍按第
10 节执行，但有四件事只在这一次需要做。

### 11.1 升级前：确认存量归属情况

```bash
psql -h 127.0.0.1 -U athena -d autoflow \
  -c "SELECT COALESCE(created_by,'(空)') AS 发布者, count(*) FROM flow_versions GROUP BY 1;"
```

若 `created_by` 全是空，说明现有 Nginx 没有向 API 注入 `X-Forwarded-User`（OA 走
`auth_request`，通常不注入）。这不影响升级，但会有两个后果，见 11.4。

### 11.2 升级中：数据库迁移会自动执行

`server/migrations/008_flow_owner.sql` 在 API 启动首次访问数据库时自动应用。它只做
两件事：给 `flows` 加一列 `owner`、建一个索引。**纯增量**，旧代码看不见这一列也能
正常跑——所以这次升级的回滚不需要处理数据库（第 10 节末尾那条告诫在这一版不适用）。

顺序仍是：停 Worker → 停 API → 切目录 → **先起 API**（迁移在这一步跑）→ 再起 Worker。

### 11.3 升级后：立刻做的两件事

1. 在 `deploy/app.env` 里补 `WORKER_TOKEN`（见第 5 节），重启两个服务。
   不补的话定时任务会静默地用机器人账号权限跑，而不是发布者的权限。
2. 在 Nginx 里补 `/autoflow/whoami` 路由（见第 7 节），`nginx -t` 后 reload。

### 11.4 升级后：存量流程的归属

升级瞬间，所有已存在的流程 `owner` 都是空。**无主流程对所有人可见**，谁发布一次
就归谁（界面上带一枚「还没有归属」的标签）。这是刻意的：批量指派错了比不指派更难
发现。

让各人自己发布一次即可完成认领。若确认全部属于同一个人，也可以一次性划归：

```bash
psql -h 127.0.0.1 -U athena -d autoflow \
  -c "UPDATE flows SET owner = '某人@agora.io' WHERE owner IS NULL;"
```

第二个后果与定时任务有关：**定时和 Webhook 触发的运行以「这一版的发布者」的名义去
数据平台查数**，发布者读自 `flow_versions.created_by`。11.1 查出来是空的那些版本，
其定时任务会继续用机器人账号的权限跑，直到有人重新发布一次（发布时才会写入邮箱）。
若这些流程本来就依赖机器人账号的权限，不重新发布也能继续跑，不必着急处理。

### 11.5 升级后验收

除第 8 节的检查外，另加两条：

```bash
# 1. 迁移确实应用了
psql -h 127.0.0.1 -U athena -d autoflow -c "\d flows" | grep owner

# 2. 两个人分别登录浏览器打开首页，确认只看得到自己的流程，
#    且副标题显示「当前是 <各自邮箱> 的工作台」
```

隔离是否生效不要只看界面。用两个账号的 Cookie 直接打接口更可靠——B 读 A 的流程应当
返回 `404`（不是 403：403 等于承认这条存在，把别人的流程 id 透出去了）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Cookie: <B 的完整 Cookie>" \
  https://athena.agoralab.co/autoflow/api/flows/<A 的流程 id>
```

### 11.6 本次升级的测试注意

第 10 节第 3 步的"后端测试"里，`server/test_flowstore.py` 需要 `DATABASE_URL` 才会
真正执行，否则它会打印"跳过"并以 0 退出——**看起来像跑过了**。它会建表、写入并删除
`test_*` 开头的数据，**绝不要指向生产库**。请在临时库上跑：

建库要用 `postgres` 执行：`createdb` 默认拿当前系统用户名当数据库角色，服务器上
没有 `devops` 这个角色；`athena` 建立时也没给建库权限。

```bash
sudo -u postgres createdb -O athena autoflow_verify
```

连接参数从 `app.env` 取，`DATABASE_URL` 只覆盖库名——这样密码不出现在命令行里，
也不用担心密码里的特殊字符在 URL 里要转义（`dbname=` 这种 keyword 形式 libpq 同样
认，缺的参数自动落到 `PGHOST`/`PGUSER`/`PGPASSWORD` 上）：

```bash
cd /home/devops/ka/autoflow-next/server
bash -c 'set -a; source /home/devops/ka/autoflow/deploy/app.env; set +a; \
  DATABASE_URL="dbname=autoflow_verify" \
  .venv/bin/python -c "
from sql_service import db
with db.pool().connection() as c:
    print(\"即将测试的库 =\", c.execute(\"SELECT current_database()\").fetchone()[0])
"'
```

**先确认这一行打印的是 `autoflow_verify`**，再跑测试。这一步不是多余的：`DATABASE_URL`
里显式写的 `dbname` 优先于 `app.env` 带进来的 `PGDATABASE`，但一旦哪里写错落到了
`autoflow` 上，测试会在生产库里建删 `test_*` 数据。

```bash
bash -c 'set -a; source /home/devops/ka/autoflow/deploy/app.env; set +a; \
  DATABASE_URL="dbname=autoflow_verify" .venv/bin/python test_flowstore.py'
sudo -u postgres dropdb autoflow_verify
```

预期 `56 通过, 0 失败`，其中包含全部归属与越权用例。

前提是 `autoflow-next` 里已经按第 4 节建好了 `server/.venv` 并装完依赖，否则这里会
提示找不到 `.venv/bin/python`。

## 安全要求

- `deploy/app.env`、数据库密码、OAuth 凭证、Webhook Secret 不得提交 Git。
- PostgreSQL 和 API 仅监听 `127.0.0.1`。
- Webhook 必须使用 HTTPS；不要在 access log 中记录请求 body。
- `/autoflow/hooks/*` 不走 OA 是设计要求，但必须开启 Secret 或 HMAC 认证和限流。
- 修改现有 Athena Nginx 前先备份并执行 `nginx -t`。
- 不要使用 `root` 运行 API 或 Worker。
- 生产环境的 `app.env` 中 `DEV_COOKIE`、`DATALEGO_USER` 必须留空。配上任意一个，
  所有人都会以同一个人的权限查数，而界面上完全看不出来。
- `WORKER_TOKEN` 与数据库密码同级：拿到它就能以任意邮箱的身份向数据平台提交查询。
