# AutoFlow Studio

内部工作流编排平台。SQL / HTTP / 企微等节点在画布上拼「查数 → 加工 → 发日报」。
有 Postgres 时走服务端 + Worker；没有后端时退回本机缓存。

编辑器快捷方式：
- `Tab` 或双击空白处添加节点；加节点时按动作搜（「发群」「查数」「判断」都能搜到）
- `⌘/Ctrl+K` 命令栏（运行、回首页、跳转节点）；`?` 看全部快捷键
- 顶栏「运行」直接开跑；缺入参才打开底栏
- 引用字段默认胶囊，单击取数、双击改表达式

## 节点设置（每种节点都有）

选中节点，配置面板最下面「设置」一节：

| 项 | 做什么 |
|---|---|
| **暂停** | 跳过不执行，但**对下游透明**：它的上游活，它的下游就活（n8n Deactivate / Activepieces Skip 的语义）。调 SQL 时先把企微节点暂停，不用删掉再加回来。引用了它输出的下游会在校验期报错，不会静默拿到空值。条件 / 循环 / 触发器不能暂停 —— 引擎要读它们的判定结果 |
| **失败时** | 中断整条流程 / 记录错误并继续 |
| **失败后重试** | 默认按节点类型（manifest 的 `policy.retry`，worker 重试的唯一出处）；可关掉或改次数 / 首次间隔。**只在基础设施类错误上重试**（平台抖动、限流、超时），SQL 语法错改了参数才能解决，重试一百次也一样。HTTP 节点在节点内自己重试（高级设置里），故意不叠 worker 这一层 |
| **备注** | 显示在卡片下面，不参与执行，改它不算「未发布的改动」 |

暂停在画布上也能点：节点悬停工具条和右键菜单都有「暂停 / 恢复」。

## 流程设置：入参与失败通知

入参的种类有 文本 / 整数 / 小数 / 是/否 / **日期** / **下拉**，可以带默认值和说明。
日期落到定义里是 `string + format: 'date'`，下拉是 `string + enum` —— webhook 入参按同一份 schema 校验，
格式不对 400 并指明字段。运行表单按种类画控件，**有默认值的项预填**，填过的值按流程记在本机，下次打开还在。

**失败通知**分两层，都填企微群机器人地址：

- **个人默认**（首页的「失败通知」按钮）：**你名下所有流程**失败都发到这里，配一次就够。
  存在 `user_notify_settings`，按登录邮箱一人一行；地址不接受调用方指定，服务端从 cookie 解。
- **单条流程**（流程设置里的「失败时通知」）：只给这条流程用，存在 `flows.notify_config`。

**填了流程级就以流程级为准**（合并只在 `worker/alerts.ts` 取地址那一步做，`?? `一句）——
语义是"这条关键流程单独发到值班群，其余都进我的个人群"。两个都没配就不发；
**无主流程**（`owner IS NULL`，008 迁移之前建的）没有"通知谁"这个答案，也不发。

不管走哪一层，消息里都有流程名、失败在哪个节点、具体原因、触发方式和运行详情链接。
整条运行失败（不管是定时、Webhook 还是手动）才发，单个节点失败但流程继续的不发；
同一原因 10 分钟内只发一条，发不出去不影响运行状态（告警是运行的旁路）。
「运行详情」链接要能点开，得给 worker 配 `PUBLIC_APP_URL`（前端的对外地址，见 `deploy/env.example`）——
没配就给 `/api/runs/{id}` 这个 JSON 接口。

定时触发器的配置面板会显示**接下来三次**会在几点跑（「发布后将按：明天 09:00 · 后天 09:00 …」）；
首页卡片上的「下次」来自调度器记的时刻（含补跑 / 重叠之后的实际值），不从草稿算。

节点贡献约定见 `docs/node-contract.md`。

```bash
npm install
npm run dev     # http://localhost:5273
```

SQL 节点已经接了真实的数据平台。要跑真查询还需要起节点服务：

```bash
cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env    # 填四项 OAUTH_* 机器人凭证
.venv/bin/python -m uvicorn sql_service.main:app --port 8791
```

已经有别处的 `.env`（比如 abtest 项目）就直接 source，不用把凭证复制成第二份：

```bash
cd server && set -a && . ~/Desktop/abtest/.env && set +a && .venv/bin/python -m uvicorn sql_service.main:app --port 8791
```

端口用 8791 —— 8787 被内网的 agora-gateway 占着。

**服务不起也能用** —— 探不到就整站退回 mock，编辑器照常摆流程。工具栏右上角
会显示当前状态：`已连接` / `缺凭证` / `mock`。

## SQL 节点（真实执行）

服务在 `server/`，参考内网 `runsql.py` 的做法实现。四条要点：

**1. 凭证只有一个来源：机器人账号。** 四项 `OAUTH_*` 从 `server/.env` 读，
绝不接受调用方传入 —— 那样会进流程定义、进日志、进 git。票缓存在进程内提前
2 分钟续，一条流程里几十个 SQL 节点不会换几十次票。
有了 Python 代码节点之后补一句：**也绝不暴露给用户代码** —— 沙箱子进程的
环境变量是清空的（专项测试钉着），而用户代码能联网，漏一次就是可外传的全套凭证。

**2. 异步节点协议。** manifest 声明 `runtime.kind: "http-async"`：submit 秒回
handle，引擎按 `pollIntervalMs` 轮询。Hive 慢查询跑几分钟，同步等必然撞网关
的 `proxy_read_timeout`，而且每个慢查询占死一个 worker。中止运行会调 cancel
把平台上的任务撤掉 —— 不撤的话它会继续跑完，白烧集群资源。

**3. 判完成看 schema，不看进度。** 平台的 progress 不单调，多阶段任务会走到
100 再掉回去重爬。拿进度判完成会提前取到空结果。

**4. 占位符由 SQL 推导，参数行自动列出来。**

「占位符参数」不是自由填的键值对 —— 它的行**从 SQL 里扫出来**：写了
`{{date}}` 或 `:vid`，表单里立刻出现对应的行。这样不用手抄一遍名字、
改 SQL 时行自动跟着变，也不可能填出 SQL 里没有的多余参数（后端会为此报错）。

每行右侧标出值从哪来：

| 标签 | 含义 |
|---|---|
| `↑ 整数` | 留空，自动取同名流程入参（并显示类型） |
| `已覆盖` | 填了值，以填的为准 |
| `缺值` | 既没同名入参也没填 —— 保存期就报错 |

清空输入框会把这个键**删掉**而不是存成空字符串，否则会被渲染成 SQL 里的 `''`。
删掉某个占位符后，之前填的值也会从定义里剔除 —— 参数集合永远以 SQL 为准。

**5. 两种写法都认，且自动代入流程入参。**

SQL 里写 `{{date}}`（数据平台自带 UI 的写法）或 `:date` 都行，可以混用。
**只要有同名的流程入参，值就自动代入** —— 现成的 SQL 直接贴进来就能跑，
不用再填一遍键值对。要覆盖或算值时才用「占位符参数」，显式填的优先。

这里有个语法冲突必须讲清楚：`{{ }}` 同时是工作流的变量引用语法。判别规则是
**`$.` 前缀**：

| 写法 | 含义 | 谁解析 |
|---|---|---|
| `{{ $.trigger.date }}` | 工作流变量 | 前端引擎 |
| `{{date}}` | SQL 占位符 | 后端渲染 |

前端遇到裸 `{{name}}` 会原样透传，不解析。哪些字段有自己的占位符语法由
manifest 里的 `x-placeholders` 声明，不是硬编码 —— 别的服务想要同样的行为，
在自己的 manifest 里声明一句就行。

没声明这个的普通字段里写裸 `{{date}}` 仍然会报错，因为那基本都是笔误：
早先的实现会把它原样还回去，SQL 变成 `where date = date`，恒真且全表扫，
静默出错。现在保存期就拦。

**6. 平台不支持绑定参数，所以参数渲染层就是唯一的注入防线。**
`sqlparams.py` 做三件事，每件都有测试：
- 占位符扫描跳过字符串/注释/`::` 转型 —— 否则 `SELECT 'a:b'` 里的 `:b` 会被替换
- 字符串**先转义反斜杠再转义引号**（三个引擎都把反斜杠当转义符，只转义单引号会被 `\'` 绕过）
- 占位符与参数必须一一对应，多了少了都报错 —— 静默留下 `:vid` 会被平台报成
  语法错，完全看不出是名字拼错了

另外只放行只读语句（SELECT/WITH/SHOW/DESC/EXPLAIN），并在外面套一层 LIMIT。
自助平台不该让人从流程节点里改数据。

```bash
cd server
python3 test_sqlparams.py          # 41 用例：注入、扫描器、只读、LIMIT
.venv/bin/python test_service.py   # 86 用例：假上游跑通 submit/poll/probe/cancel
.venv/bin/python test_wecom.py     # 27 用例
.venv/bin/python test_ssrf.py      # 33 用例：出网防护
.venv/bin/python test_flowdef.py   # 33 用例：流程定义校验
```

## 部署

本机开发不需要容器 —— Postgres 用 Homebrew、其余直接跑（见下一节）。
这份是给服务器的：

```bash
cp deploy/env.example deploy/app.env     # 填四项 OAUTH_*
openssl rand -hex 32 > deploy/pg_password.txt
# 安装过 htpasswd（apache2-utils/httpd-tools）后交互式设置控制台账号密码。
# 使用 APR1，确保 nginx:alpine 可以直接校验。
htpasswd -cm deploy/htpasswd workflow-admin
# 证书放 deploy/certs/{fullchain,privkey}.pem
docker compose config                    # 上线前先确认挂载和环境完整
docker compose up -d --build
```

四个服务：`postgres` / `api` / `worker` / `nginx`。
前端由 `deploy/web.Dockerfile` 在镜像内构建，服务器不需要单独安装 Node.js。
**沙箱容器（Python 代码节点的隔离执行）暂时没有** —— 节点已上线但生产默认
闸死：不配 `SANDBOX_URL` 时它直接报「沙箱未配置」拒绝执行，不留洞
（见「Python 代码节点」一节）。

几条不能省的：

- **凭证走 `env_file` 挂载，绝不 COPY 进镜像** —— 镜像会被推到仓库、
  被 pull、被 `docker history` 看光
- **HTTPS 内网也要上**：webhook 带密钥，明文 HTTP 等于密钥裸奔
- 默认用 `deploy/htpasswd` 的 Basic Auth 保护编辑器和控制面；接入公司 SSO 后，
  用网关认证替换 nginx 中的 `auth_basic`，但不要让 `/api`、`/nodes` 裸露公网
- API 和 worker 从同一份 `pg_password` Docker Secret 读取密码，不需要再拼
  `DATABASE_URL`，密码也不会出现在 `docker compose config` 输出中
- nginx 的 `client_max_body_size 1m` 要和服务端的上限对齐；
  `/hooks/` 的 `proxy_read_timeout` 必须大于同步响应可配置的最大等待时间（当前 1800 秒）
- access log **保持默认不记 body** —— 里面可能有用户 id、手机号
- `deploy/backup.sh` 挂 cron：每日 `pg_dump` + 90 天清理 `run_events`，
  但**保留 `runs` 主记录**（"去年为什么发了那个数"仍要答得上来）

worker 起多个也安全：认领走 `FOR UPDATE SKIP LOCKED`，
调度器靠 advisory lock 保证只有一个在扫表。

## 流程持久化（M0）

流程原先存在每个人自己浏览器的 localStorage 里：换台机器就没了、同事看不到。
现在可以存到 Postgres：

两种起库方式，任选：

```bash
# A. Homebrew（本机装，开机自启，端口 5432）
brew install postgresql@16 && brew services start postgresql@16
psql -d postgres -c "CREATE ROLE workflow LOGIN PASSWORD 'workflow'"
createdb -O workflow workflow
export DATABASE_URL=postgresql://workflow:workflow@127.0.0.1:5432/workflow

# B. Docker（端口 5433，和 A 不冲突，可以并存）
docker compose up -d
export DATABASE_URL=postgresql://workflow:workflow@localhost:5433/workflow
```

然后照常起服务，建表由服务端自动迁移：

```bash
cd server
.venv/bin/python -m uvicorn sql_service.main:app --port 8791
```

**没配 DATABASE_URL 也照样能用** —— 流程接口一律返回 503 并说清原因，
前端继续用 localStorage。这和"节点服务探不到就整站退回 mock"是同一个约定：
clone 下来第一件事不该是被迫装个数据库。当前状态在 `GET /health` 的
`storage` 字段里。

迁移是裸 SQL 文件 + 一张 `schema_migrations` 表，服务启动时自动跑，不引 Alembic
（整个服务端四个依赖，为两张表引一套迁移框架不划算，出事时裸 SQL 也更容易接管）。

### 草稿与版本

| 概念 | 存哪 | 谁会读它 |
|---|---|---|
| **草稿** | `flows.draft` | 编辑器。防抖自动保存打的就是它，不产生版本 |
| **版本** | `flow_versions`，**不可变** | 运行记录按 `runs.flow_version` 钉住的那一份 |
| **生效版本** | `flows.active_version` | 将来的定时和 webhook 只触发这一版 |

在此之前根本没有版本概念 —— `toDefinition()` 里 `version: 1` 是硬编码的。
没有它，"改了流程之后历史运行记录还解释得通吗"这个问题无法回答。

草稿改了不发布，线上不会变。列表页的 `hasUnpublishedChanges` 会标出来
（只比逻辑不比布局，拖一下节点位置不算改动）——否则"我明明改了怎么没生效"
是一定会发生的。

### 服务端只拒绝，不修复

前端有一份 `normalizeFlowDefinition`，它的职责是把外部 JSON **补齐**成编辑器
能安全加载的样子。服务端的 `flowdef.validate` 职责不同：它是完整性边界，
只判定不转换。

理由是硬的：前端补一个默认值用户马上能在界面上看见；服务端补一个默认值则是
悄悄存下一份和用户以为的不一样的定义。而且两份"修复"逻辑必然漂移，漂移的
表现是"本地能存、线上存出来是另一个样"。

拒绝的包括：悬空的边引用、重复节点 id、非法 `onError`、`pinData` 指向不存在的
节点，以及体积上限（整份 1 MB、单条 pin 256 KB、节点数 500）——
未认证的接口收 JSONB，没有上限就是一个内存放大器。

`id` 和 `version` **由服务端分配**，客户端提交什么都不作数。

### 审计

不做 RBAC，只回答"谁改的"。`actor` 由反向代理把 SSO 用户名放进
`X-Forwarded-User`，服务端不自己做认证。记录建立/发布/归档；
**存草稿不记** —— 编辑器几秒存一次，记了会把审计表变成击键日志。

### 存量流程的影响面分析

节点的 input schema 由后端 manifest 整份下发，改一个字段名，所有已保存流程里
那个参数就变成孤儿。[types.ts](src/types.ts) 里为同一类问题写过一句：这种不一致
"一上线就没，而且**只在线上没，本地永远测不出来**"。

流程还在各人 localStorage 里的时候这件事没法检测；集中到服务端之后既可检测
也更致命 —— 一次变更同时打坏所有人的日报。

```bash
npm run check:flows                      # 从服务端拉全部流程逐条校验
npm run check:flows -- exported/*.json   # 或者查一批导出的 JSON
```

退出码非 0 表示有流程会因当前的节点定义而失效，CI 可以直接拿它当门禁。
它用的是**后端下发的注册表**而不是前端那份兜底定义 —— 要检测的正是后端
manifest 的破坏性变更，拿前端的定义去查等于什么都没查。

```bash
cd server
.venv/bin/python test_flowdef.py        # 33 用例，纯校验，不需要数据库
DATABASE_URL=... .venv/bin/python test_flowstore.py   # 集成，需要真 Postgres
```

## HTTP 节点的出网防护

`http.request` 从服务端发请求（浏览器直连会撞 CORS，行为还取决于谁的机器）。
这意味着**服务端的网络位置就是这个节点的能力边界** —— 而这个进程同时持有
数据平台的机器人票和企微 webhook 地址，且服务端目前没有任何认证。

所以默认拦住三类目的地：回环、RFC1918 内网、链路本地（`169.254.169.254`
云元数据在这里）。**跳转的每一跳都重新校验** —— 只校验第一跳等于没校验，
一个指向元数据地址的 302 就能绕过全部检查。跨主机跳转还会剥掉 `Authorization`，
否则恶意跳转能直接把 token 收走。

三个环境变量：

| 变量 | 作用 |
|---|---|
| `HTTP_NODE_ALLOWED_URLS` | 精确 URL 例外：只放行列出的协议、主机、端口和路径；查询参数不参与匹配。不改变默认的公网放行策略，空格或逗号分隔 |
| `HTTP_NODE_ALLOWED_HOSTS` | 设了就是**严格白名单**：只有列出的主机能访问（内网地址也放行，那是运维明确同意的）。空格或逗号分隔 |
| `HTTP_NODE_BLOCKED_CIDRS` | 在默认网段之外追加要拦的段，例如 k8s 用了 `100.64.0.0/10` |

判定用的是**显式网段**而不是 `ipaddress.is_private`。后者是个大杂烩：
`198.18.0.0/15`（RFC2544 基准测试段）也算 private，而 Zscaler / AnyConnect 这类
代理型 DNS 恰好把所有外部域名解析到这一段 —— 用 `is_private` 判会把企微 webhook
一起拦掉，一个安全修复变成"所有出网都不通"。

残余风险照实说：校验和建连之间有 TOCTOU 窗口，DNS rebinding 理论上仍可绕过。
彻底解决要固定已校验的 IP 去建连（自定义连接池适配器），成本超出这次修复的范围。

## Python 代码节点（code.python）

transform/list 这类节点表达不了的加工（分组统计、多结果集关联、条件汇总）
写一段 Python：入口固定 `def main(inputs) -> dict`，返回的键直接成为下游可引用
的输出字段，`print` 全部收进 `logs`（结果走独立通道，随手 print 不会搞坏结果）。

**数据只走「输入变量」**：kv 映射把上游引用装进 `inputs` 字典。代码字段本身
**绝不做模板插值**（schema 标记 `x-no-template`，有防回归测试）——
这是整个节点最重要的一条：如果代码也支持 `{{ $.trigger.x }}`，webhook body
里的内容就会变成服务端执行的 Python，是货真价实的 RCE。

**执行模式三档**（`server/sql_service/code_python.py`），默认闸死：

| 模式 | 条件 | 隔离程度 |
|---|---|---|
| 未配置（默认） | 什么都不配 | 节点报「沙箱未配置」拒绝执行，生产不留洞 |
| 本地子进程 | `CODE_NODE_LOCAL_EXEC=1` 且无 `PGHOST` | 环境变量清空、独立 venv、超时 SIGKILL、rlimit 尽力而为；**没有**文件系统/内存隔离，仅限本地开发 |
| 沙箱服务 | `SANDBOX_URL`（优先） | 转发给独立沙箱服务（容器，未做，接口缝已留好） |

**联网是有意放开的**（推翻了设计文档 §10.5 的原案）：用户代码可以直接访问
内外网。代价说在明处 —— HTTP 节点那套出网白名单和"URL/凭证在流程定义里可审计"
对这个节点不成立，兜底是内部工具 + SSO + `flows.owner` 按邮箱可追溯到人。
HTTP 调用仍建议走 HTTP 节点（可审计、有重试语义）；也因为联网放开，
"子进程环境变量绝不继承"升级为和插值红线并列的第二条红线。

**预装包由管理员管**（首页「Python 依赖」，正本在 `sandbox_packages` 表）：
版本必须钉死，增删后后台对账线程把沙箱 venv 收敛成表的样子。种子五件套：
pandas / numpy / python-dateutil / orjson / requests。**不支持用户代码自装** ——
pip 的安装脚本本身就是任意代码，供应链面收在管理员手里；import 没装的包会
报 ImportError 并指引来这一页。

限额：代码 ≤1MB（内嵌在流程定义里，跟着版本走）、结果 ≤10MB、
超时默认 30s 上限 120s（卡在网关超时之下）、stdout/stderr 各留 64KB。
错误都带用户代码行号，沙箱包装层的栈帧已剥掉；只有「沙箱不可用」会重试，
代码本身的错误重跑也一样，不重试。

## 已经能用的

- **首页 = 流程列表**：卡片网格，带搜索、创建副本、导出 / 导入 JSON、删除；
  卡片上标出触发方式和用到的节点种类，一眼认出"这条是发企微的"
- **防抖自动保存**：真实流程改动停止 900ms 后写入本地流程库；选择节点、开关面板和纯运行记录不触发保存，运行中学到的字段结构会保存，离开编辑器前同步落盘，写入失败会保留重试状态
- **加节点有三个入口**（都弹同一个搜索式选择器）：
  节点右侧的 `+`（自动落位 + 自动连线）、连线中间的 `+`（插进两个节点之间，
  下游自动右移腾位）、画布左上角的「添加节点」。选择器里也能把节点拖到画布上自选落点
- **节点卡片上写着它配成了什么** —— 几点跑、查哪个引擎、发去哪、缺哪个必填项，
  不用逐个点开看
- **节点悬停工具条**：试运行 / 详情 / 复制 / 删除，不用先选中再去右栏找
- **空流程快捷开始**：触发器旁直接添加 SQL、HTTP 或打开完整节点选择器，不用先读教程；
  节点选择器会把最近使用的类型排在前面，并支持方向键、Home / End 和 Enter
- **画布右键菜单**：节点上可查看详情、复制、创建副本、删除；空白处可在指针位置粘贴或添加节点
- 画布连线、移动、框选、删除（`Delete` / `Backspace`）、**自动整理**（拓扑分层重排）
- **非法连线即时阻止**：自环、重复边和会形成环路的回连无法落下，并在画布顶部说明原因；导入的旧流程也会做整图拓扑校验
- **唯一入口节点**：入口不能复制或删除；选择另一种触发器会原位替换当前入口，保留节点 ID、位置和下游连线，并支持撤销
- **编辑历史与快捷键**：最多 50 步撤销/重做；连续编辑同一字段合并为一步，
  节点拖动也只记一步；多选复制粘贴会保留选区内连线；支持 `⌘/Ctrl+C`、
  `⌘/Ctrl+V`、`⌘/Ctrl+Z`、`⌘/Ctrl+Shift+Z`、`⌘/Ctrl+D`、
  `⌘/Ctrl+O`、`⌘/Ctrl+1`、`Shift+1` 和 `⌘/Ctrl + / -`，输入控件内不抢键
- 多出口节点：`条件分支` 真/假两口，`循环遍历` 每一项/完成两口
- **配置面板浮在画布上**，收起时画布是整块的；
  适应画布、自动整理和面板开合都会按浮层后的真实可见区域定位，不把节点藏到面板下面；
  按节点的 **input JSON Schema 自动渲染表单**
  （select / 代码框 / 键值对 / 数字 / 开关，由 `x-ui.widget` 决定）
- **Slash 变量选择器**：在文本中输入 `/` 列出当前节点可引用的变量，继续输入即筛选，
  支持方向键 + Enter 插入；行首或空白后的 `/` 才触发，URL 和路径不误触
- **HTTP 响应字段学习**：真实运行后只记录响应体字段名和类型，不保存响应值；
  下游输入 `/token` 可直接插入 `output.body.token`，嵌套对象字段同样支持，重载后仍保留
- **HTTP 状态可信**：4xx / 5xx 默认让节点失败并展示状态码与响应摘要；需要自行分支处理时，
  可打开「接受错误状态码」把错误响应保留为正常输出
- **请求头防旁观泄露**：Authorization、Cookie、API Key、Token 等敏感请求头默认遮罩，
  可临时查看；运行详情只显示 `[REDACTED]`，真实请求仍使用原值（流程定义存储本身未加密）
- **静态校验**：必填项、引用了不存在或非上游的变量，实时反映在
  字段下方 chip → Inspector 错误区 → 顶栏问题列表 → 节点卡片上的提示条；
  顶栏可展开全部问题，逐项定位到对应节点和具体字段，聚焦后可直接修复
- **添加后立即配置**：新增或插入节点会保持选中并自动打开配置面板，不需要再点一次节点
- **配置与执行闭环**：Inspector 底部固定显示单节点运行、最近状态和查看结果；
  填完参数可按 `⌘/Ctrl+Enter` 立即执行，必填错误会阻止误运行并直接说明原因
- **试运行探测**：SQL 这类输出结构运行时才确定的节点，探测一次把真实列缓存到节点实例，下游即可提示
- 流程定义 JSON 的导出 / 导入，逻辑与布局分离
- **统一导入校验**：旧定义缺少 `edges` / `layout` / `inputs` 时自动补齐；重复节点 ID、悬空连线和无效字段会指出准确路径，编辑器内覆盖导入保留当前流程 ID

## 从 n8n 抄来的（按其源码实测语义实现）

- **条件显示 `x-show` / `x-hide`**（= n8n `displayOptions`）：
  show 的多个 key 之间 AND、候选值数组内 OR；hide 跨 key OR、优先于 show；
  被引用参数未填时用 default 参与比较；隐藏字段不做必填校验；
  隐藏参数编辑器里保留、**导出时剥离**（n8n 是编辑器里就 strip）。
  示例：`http.request` 的请求体只在 POST/PUT/PATCH 时出现
- **固定输出 pinData**：NDV 输出栏可把节点输出固定 / 手写 JSON；
  调试运行直接用固定数据不真正执行（生产触发忽略，注释里已标）；
  pinned 节点跳过参数校验；只有**恰好一个出口**的节点能 pin
  （If/foreach/终点节点不行）；对 pinned 节点试运行先弹「取消固定并执行」确认；
  pinData 随流程定义导出（n8n 同款）
- **mock 执行引擎 + 运行态**：拓扑执行、if 分支跳过（只灭「仅从死分支可达」的节点）、
  foreach 循环体每项跑一遍（一个节点多条 StepRun，对齐 n8n `ITaskData[]`）、
  onError fail/continue 两种策略
- **NDV 节点详情**（双击节点打开）：输入（解析后入参 + 上游输出）| 参数 | 输出 三栏，
  输出栏 表格/JSON 切换、循环多次执行的运行选择器、单节点试运行
  （上游数据用最近一次运行 + pinned 覆盖，改参数不用重跑整条流程）
- **画布运行反馈**：节点 ✓/✗/⊘/📌/spinner 角标；连线条数标签
  （pinned 源显示 `n 项 📌`，多次执行显示 `共 n 项`）
- **dirty 标记**：参数改过但没重跑 → 黄色 ⚠ 替代绿色 ✓ + NDV 里过期提示
  （= n8n `PARAMETERS_UPDATED`），重跑或单节点试运行后清除
- **表达式预览**：跑过一次后，字段下的引用 chip 显示 `→ 实际值`
- **底部运行面板**：触发表单（流程入参渲染）、运行历史、分步时间线（点击跳 NDV）；
  顶部边界可拖动调整高度，支持方向键微调、双击复位和本机高度记忆，增高后画布自动适配

## 前后端节点定义必须一致

`sql.query` / `postgres.workspace` / `notify.wecom` / `http.request` 由后端 manifest **整份覆盖**前端 `registry.ts` 的同名项。
前端那份多写的注解（`x-ui.group`、`keywords`、`policy.retry`……）一上线就没，而且只在线上没。
`test/manifestParity.test.ts` 逐字段比对两边（`runtime` 允许后端独有），有 `server/.venv` 时随 `npm test` 一起跑。
改这四个节点先改 `server/sql_service/manifest.py`，再把 `registry.ts` 那份镜像对齐。

## 代码结构

| 文件 | 作用 |
|---|---|
| `src/types.ts` | 节点 manifest、流程 DSL、运行态（FlowRun/StepRun）的类型契约 |
| `src/registry.ts` | 节点注册表（**写死的假数据**，正式版从 `GET /registry/nodes` 拉） |
| `src/store.ts` | zustand 状态 + 序列化 + 运行/pin/dirty 状态 |
| `src/lib/vars.ts` | 上游节点遍历、可用变量计算、静态校验 |
| `src/lib/display.ts` | `x-show`/`x-hide` 条件显示求值（n8n displayParameter 语义） |
| `src/lib/summary.ts` | 节点卡片上那行"配成了什么"的摘要 |
| `src/lib/layout.ts` | 自动整理（拓扑分层 + 重心法排序）、`+` 加节点的落位、插入时的下游平移 |
| `src/lib/engine.ts` | **mock 执行引擎**：拓扑执行、分支/循环、表达式解析、单节点试运行。后端接上后整个文件换成订阅 run 的 SSE/WS 流，UI 不用改 |
| `src/components/SchemaForm.tsx` | JSON Schema → 表单渲染器（含条件显示、表达式预览） |
| `src/components/NodePicker.tsx` | 加节点的搜索式选择器（三个入口共用，支持点选和拖放） |
| `src/components/FlowEdge.tsx` | 连线：悬停冒出「插入节点 / 删除」，运行后挂条数标签 |
| `src/components/Icon.tsx` | 界面线条图标（节点自己的图标来自注册表，不在这里） |
| `src/components/VarPicker.tsx` | 文本内 Slash 变量选择器 |
| `src/components/NodeDetailView.tsx` | NDV：输入/参数/输出三栏 + pin + 试运行 |
| `src/components/RunPanel.tsx` | 底部运行面板：触发表单、历史、分步时间线 |

## 接后端时要改的地方

SQL、HTTP 调用和企微通知节点已经走完这条路了（`src/lib/client.ts` + `server/`），
没有在后端 manifest 中声明 `runtime` 的节点仍走 mock。
照着 SQL 节点接下一个时：

1. ~~`src/registry.ts` → `GET /registry/nodes`~~ **已完成**：后端上报的 manifest
   会覆盖同名本地 mock，`MOCK_OPTIONS` 退化成后端拉不到时的兜底
2. ~~`store.probeNode()` → `POST /nodes/{type}/probe`~~ **已完成**：后端在线时
   真跑一行拿 schema，下游变量提示里就是真实列名
3. `toDefinition()` 的结果 → `PUT /flows/{id}`；运行 → `POST /flows/{id}/runs`
4. `src/lib/engine.ts` 的编排部分 → 换成订阅后端 run 的事件流（SSE/WS），
   `FlowRun`/`StepRun` 的形状就是后端要吐的事件格式。
   节点执行部分（`runLiveNode`）已经是真的，可以直接搬到后端引擎
5. 引擎侧记得实现：pinned 只在手动运行生效、pinned 跳过参数校验、
   生产触发忽略 pinData —— 这些语义前端已按 n8n 对齐，
   `ExecuteOptions.mode` 就是留给这条的接口
6. 静态校验目前在前端做了一遍，**后端保存时必须再做一遍**（前端校验只是体验，不是防线）

## 还没做

定时/webhook 触发配置、子流程、版本发布与回滚、权限、
NDV 的 Schema 视图（n8n 有 Table/JSON/Schema 三种）、拖字段生成表达式。

## HTTP 调用节点（真实请求）

请求由后端节点服务发起，不受浏览器 CORS 限制。JSON 响应会解析后放在
`output.body`，非 JSON 响应保留为文本；HTTP 4xx/5xx 的状态码和响应体也会原样返回，
便于下游节点自行分支。单次响应体上限 5 MiB，超时最长 120 秒，响应中的 `Set-Cookie`
不会写入运行记录。

## 企微通知节点（真实发送）

填群机器人的 webhook 地址，直接推。三种消息类型的能力**不一样**，按
[官方文档](https://developer.work.weixin.qq.com/document/path/99110) 实测：

| msgtype | 上限 | 表格/列表 | @成员 | 字体颜色 |
|---|---|---|---|---|
| `text` | 2048 字节 | ✗ | ✓ | ✗ |
| `markdown` | 4096 字节 | **✗** | ✓ | ✓ |
| `markdown_v2` | 4096 字节 | **✓** | ✗ | ✗ |

**要发查询结果表格就得用 `markdown_v2`，但那样 @不到人** —— 这是企微的限制，
不是这里的取舍。要两者都要，就发两条。

限制在服务端先挡掉，不等企微拒绝：字节数（按 **UTF-8 字节**不是字符数算，
中文一个字 3 字节）、20 条/分钟的限流、msgtype 与 @成员的兼容性。

**`dryRun` 默认开着** —— 调消息格式时先看渲染结果，别把群刷屏。确认好了再关掉。

webhook 等同凭证：拿到的人就能往群里发，而它随流程定义一起导出入库，
所以**流程 JSON 要当凭证管**。节点输出里的 key 会打码（`…key=abcd***kl`），
运行记录截图外传时不至于连 key 一起泄露。

## 模板格式化过滤器

查询结果直接塞进消息只会得到一坨 JSON。引用后面可以接过滤器：

```
{{ $.nodes.n2.output.rows | table(name, avg_dc) }}   markdown 表格（仅 markdown_v2 能渲染）
{{ $.nodes.n2.output.rows | list(uid, avg_dc) }}     一行一条：- uid=1，avg_dc=2
{{ $.nodes.n2.output.rows | lines(installid) }}      只出一列，一行一个值
{{ $.nodes.n2.output.rows | count }}                 条数
{{ $.nodes.n2.output.rows | json }}                  原样 JSON
```

聚合，四个都接受可选列名（对象数组和标量数组两种形状都能用）：

```
{{ rows | sum(dc) }}              求和；rows | column(dc) | sum 等价
{{ rows | unique }}               去重（按值比，不是按引用）
{{ rows | join('、', name) }}      连成一串，默认分隔符是顿号
{{ rows | sort(dc, desc) }}       排序，数字按数值比（否则 '10' 会排在 '9' 前）
```

筛选、截断、均值极值、数字格式（第二批）：

```
{{ rows | where(dc, gt, 5) | table(vid, dc) }}   只发 dc > 5 的行（find 只取第一个匹配，where 保留全部）
{{ rows | sort(dc, desc) | limit(10) | table() }} 前十名
{{ rows | avg(dc) | round(1) }}                  平均值保留一位小数；min / max 同形
{{ rows | avg(ratio) | percent }}                0.123 → 12.3%
```

比较方式：`eq / neq / contains / gt / gte / lt / lte`。`avg / min / max` 遇到空集返回缺值
（不是 0 —— 0 会把"没有数据"伪装成"平均值是 0"发进群里），要显示占位就接 `| default('—')`。

这些在取值面板里都有按钮：「按条件」勾上「保留全部匹配行」就是 `where`，「汇总」页签里是
求和 / 平均 / 最大 / 最小 / 去重个数 / 拼接 / 前 N 行 —— 不用手写。

**过滤器可以串起来**：

```
{{ rows | sort(dc, desc) | at(0, name) }}      跌得最狠的是谁
{{ rows | column(vid) | unique | count }}      去重后几个
```

以前只能接一个 —— 表达不出来就只能回去改 SQL，而改 SQL 意味着多跑一次
几分钟的 Hive 查询。`sort` 不会改上游数据（原地排序会让下一个引用它的地方
拿到排过序的结果，而且没有任何痕迹）。

不写列名就取全部列。空结果输出「（无数据）」而不是空白。

### 引用取不到值 = 报错，不是空字符串

```
{{ $.nodes.q1.output.summary.bad }}          → 报错，并告诉你怎么写 default
{{ $.nodes.q1.output.summary.bad | default('—') }}   → 渲染成 —
{{ rows | find(vid, eq, 999) | default('无') }}      → default 可以叠在别的过滤器后面
```

以前这里是 `JSON.stringify(v) ?? ''`：`JSON.stringify(undefined)` 返回的是
`undefined` 这个值（不是字符串），`?? ''` 于是把它变成空串。后果是
`今天异常 {{ ….summary.bad }} 条` 渲染成「今天异常  条」、**run 记 success**、
群里收到一句缺了数字的日报，全程没有任何报错。

而 `sql.query` 的输出结构本来就是 probe/run 学出来的 —— Hive 列名一变就命中
这条路径，编辑期的校验拦不住这种运行时漂移。引擎对裸标识符、写错的过滤器都
专门抛了错，唯独漏了这一种。

Airflow 的 `StrictUndefined`、Step Functions 的 `States.ParameterPathFailure`、
Argo 的 parameter-not-found、Camunda 的求值失败→incident —— 四个系统的一致选择
都是报错终止，确实允许缺值的场合用显式的 `default()` 开口子。

`0` / `false` / `''` / `null` 都**不算**缺值，只有路径解不出来才算。

编辑期的消息预览是例外：那时上游多半还没跑过，缺值是常态，所以渲染成显眼的
`〔未取到值〕`而不是报错 —— 但也不再是"那段悄悄消失"。

## 前端驱动轮询的局限

现在编排跑在浏览器里，轮询用的是 `setTimeout`。**标签页切到后台会被浏览器
节流**（Chrome 隐藏标签页降到每秒一次，久了降到每分钟一次），表现为：慢查询
仍会在平台上正常跑完，但 UI 上的进度和结果会滞后；关掉标签页则整条流程中断，
已提交的平台任务无人接管（不过引擎在中止路径上会调 cancel）。

这不是 bug，是"编排在前端"这个阶段的固有属性，也是把编排搬到后端的主要理由。
搬过去之后前端只订阅事件流，切后台/关页面都不影响流程本身。

## mock 引擎的已知边界

- **嵌套循环不支持**：循环体里再放一个 `flow.foreach` 会显式报错
  （而不是静默产出错误数据）；后端真实引擎实现后放开
- **循环项上限 1000 条**：超了是整个节点失败，不是截断 —— 截断会让"少跑了
  几百条"变成一次绿色的运行。以前这里硬编码 `slice(0, 3)`（mock 期的限制，
  但对真实节点也生效：循环体里的 SQL 是真跑的，配了 500 个 vid 只跑前 3 个，
  剩下 497 个静默消失）
- 循环体里的 `flow.if` 支持按迭代求值；`flow.merge` 在循环体里按普通节点处理
- 表达式只支持单个引用 / 字面量 / 二元比较，函数调用、算术运算不支持
  （正式版换 CEL / expr-lang，这里只是 mock）
