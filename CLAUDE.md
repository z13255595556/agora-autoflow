# AutoFlow Studio

浏览器里搭流程（SQL 查询 → 企微通知 → HTTP 调用），服务端跑。
前端 React + Vite，后端 FastAPI，worker 是 Node，库是 Postgres。

完整说明在 [README.md](README.md)（555 行）。这份只写**动手前必须知道、
而且看代码看不出来**的那些。

---

## 起服务

```bash
npm run dev      # 一条命令拉起后端(:8791) + 前端(:5273)，退出时一起收
```

后端带 `--reload`，改 `server/sql_service/` 下的 Python 会自动重起。
改**迁移文件**要重启（迁移只在建连接池时跑一次）。

## 跑测试

```bash
npm run check                                    # tsc + 前端全部测试
DATABASE_URL=postgresql://$USER@127.0.0.1:5432/workflow \
  node --test --experimental-strip-types test/*.test.ts   # 含要库的那些
cd server && DATABASE_URL=... .venv/bin/python test_service.py   # 后端逐个文件跑
```

**没有 `DATABASE_URL` 时要库的测试会静默跳过。** 看到「跳过」不等于「过了」——
改了 worker/alerts.ts、flowstore.py、迁移，必须带库跑一遍。
本机有现成的 `workflow` 库可以直接用。

后端测试文件：`server/test_*.py`，各自 `python test_xxx.py` 跑，
末行打「N 通过, M 失败」。

---

## 三条最容易踩的

### 1. 节点定义前后端必须逐字段一致

`server/sql_service/manifest.py` 是**正本**，`src/registry.ts` 是离线兜底。
后端在线时 `applyBackendNodes` **整份覆盖**前端那份 —— 前端多写的注解一上线就没了，
**而且只在线上没，本地永远测不出来**。

`test/manifestParity.test.ts` 是这条的门禁（除 `runtime` 外全比）。
**改任何一边都要同步另一边**，然后跑这个测试。

### 2. `run_status` 和 `step_status` 是两个枚举，失败的写法不一样

| 表 | 枚举 | 失败叫什么 |
|---|---|---|
| `runs` | `run_status` | **`error`** |
| `steps` | `step_status` | **`failed`** |

写混了 Postgres 直接拒（`invalid input value for enum`）。

### 3. `runs` 对 `flow_versions` 有复合外键

`(flow_id, flow_version)`。测试里造 run 之前，`flows` 和 `flow_versions` 两张都要有行。

---

## 身份与权限

一切按**邮箱**，从 Athena 的 `HCIAuthToken` cookie 解出来（`identity.creator_for`）。
`flows.owner`、查数权限、审计、失败通知全共用这一个身份 —— 分叉了会静默对不上。

- `_actor()` = 谁在操作（审计和归属记的是这个）
- `_viewer()` = 用谁的视角看（管理员是 `ANY`）—— **两个不能合并**
- 越权一律按「不存在」处理（404 不是 403）：403 等于承认「这条在，只是不给你」

**本地没有 cookie**，所以认得出用户才出现的界面本地看不见。
在 `server/.env` 里配 `DEV_IDENTITY_EMAIL=you@agora.io` 打开本地假身份
（细节见 `server/.env.example`；三道闸缺一不认，生产开不了）。

---

## 告警是运行的旁路，不是 DAG 里的一个节点

`worker/alerts.ts`。三条硬规则，改之前先读那个文件开头：

1. run 进终态时写一行，由同一个 worker tick 投递并重试
2. **发送失败只记 error，绝不改 run 状态**
3. 同一原因 10 分钟内只发一条 —— 没有抑制的话群会被刷爆，然后所有人设免打扰，
   **告警系统失效的标准路径**

地址两层：`flows.notify_config`（单条流程）覆盖 `user_notify_settings`（个人默认）。
合并只在 `recordRunAlert` 取地址那一句做。

---

## 写代码的调子

这个仓库的注释密度高，而且**写「为什么」不写「是什么」**。特别是：

- 每个反直觉的决定都要留下理由，尤其是「为什么不那样做」
- 症状是**静默**的坑要显式点出来（「而且本地永远测不出来」「而且看不出任何异常」）
- 迁移文件开头必须讲清楚这张表/这列为什么存在（对照 `008_flow_owner.sql`、`013_version_note.sql`）
- 被钉住的行为写明「钉住它，不要顺手改好」

**别为了简洁把这些注释删掉。** 它们是这个仓库主要的知识载体。

## Commit

- **不开分支，直接提到 main**
- 中文；标题写**症状**不写方案（`fix: SQL 节点报 Unexpected token 'I' —— 平台挂了，用户看到的是一句 JSON 解析错`）
- 正文写长一点，讲清楚为什么这么改
