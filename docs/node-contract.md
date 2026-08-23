# 节点贡献契约

加一种节点只交一份 manifest，不要改前端特判。

1. 交 JSON：`type` / `typeVersion` / `name` / `category` / `input` / `output` / `runtime`
2. 动态列用 `x-dynamic: probe|run`，禁止 `if (typeId === ...)` 画 UI
3. 展示用 `x-ui` / `x-output-ui`；敏感字段 `secret`；配一次就不再动的字段 `x-ui.group: 'advanced'`
4. 自有 `{{name}}` 语法必须声明 `x-placeholders`
5. `sql.query` / `http.request` / `notify.wecom` 由后端整份覆盖前端 `registry.ts` 同名项。注解写在 `server/sql_service/` 对应 manifest
6. 卡片摘要优先走通用规则；不要在组件里按 typeId 开新表单
7. `npm run check:flows` 用后端注册表校验存量流程
8. 搜索别名与文档：`keywords`（用户会搜的动作词，如「发群」「查数」）、`docsUrl`（Inspector 的 `?` 链到这里）。没有 `keywords` 的节点只能按名字搜到
9. 凭证不进参数：需要密钥 / webhook 的字段声明 `x-ui: { widget: 'connection', connectionType: '<type>' }`，值是 `conn:<id>`，密文只在服务端解。不要新加 `secret: true` 的明文字段
10. 导入器声明化：`x-ui.importers: ['curl']` 让表单长出 cURL 导入，不要在组件里按 typeId 判断
11. 会真跑的节点（有 `runtime`）必须声明 `policy.retry`，这是 worker 重试的唯一出处；不声明 = 不重试。`isRetryable` 仍只放行基础设施类错误

设计依据见 `docs/node-usability-design.md`。
