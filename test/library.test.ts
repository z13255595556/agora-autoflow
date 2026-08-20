import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 流程库双后端的测试。
 *
 * 打桩 fetch 把整条链路跑起来（library → client → HTTP），这样能验到浏览器里
 * 验不到的那一半 —— 开发机上没有 Postgres，服务端模式的 UI 路径在浏览器里
 * 一次都走不到。
 *
 * 重点是三件容易出错的事：
 * 1. 模式判定（storage.ok 才算服务端可用，不是 backend.ok）
 * 2. 服务端读失败要**退回本地并说出来**，不能静默
 * 3. 本地写永远先做，且永远做 —— beforeunload 只能同步保存
 */

// ---------------------------------------------------------------- 环境垫片

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}

const storage = new MemoryStorage()
;(globalThis as Record<string, unknown>).localStorage = storage

type Route = { status?: number; body: unknown }
let routes: Record<string, Route> = {}
let calls: Array<{ method: string; url: string; body: unknown }> = []

;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  const path = String(url).replace('http://localhost:8791', '')
  calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
  const key = `${method} ${path.split('?')[0]}`
  const route = routes[key]
  if (!route) return { ok: false, status: 404, json: async () => ({ detail: `没有打桩 ${key}` }) }
  const status = route.status ?? 200
  return { ok: status < 400, status, json: async () => route.body }
}

const api = await import('../src/lib/client.ts')
const lib = await import('../src/lib/library.ts')

const DEF = {
  id: 'f1', version: 0, name: '日报',
  inputs: { type: 'object', properties: {} },
  trigger: { kind: 'manual' as const },
  nodes: [{ id: 'n1', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' as const }],
  edges: [],
  layout: { n1: { x: 0, y: 0 } },
}

async function mode(storageOk: boolean | undefined) {
  routes['GET /health'] = {
    body: {
      ok: true, endpoint: 'x', missingCredentials: [],
      ...(storageOk === undefined ? {} : { storage: { configured: true, ok: storageOk, detail: null } }),
    },
  }
  await api.health()
}

beforeEach(() => {
  storage.clear()
  routes = {}
  calls = []
})

// ---------------------------------------------------------------- 模式判定

test('storage.ok 为真才算服务端模式', async () => {
  await mode(true)
  assert.equal(lib.storageMode(), 'server')
})

test('节点服务在但没配数据库 → 本地模式', async () => {
  // 这是完全正常的一档状态：节点照跑，流程存浏览器本地。
  // 把它和"节点服务在不在"合成一个布尔会让两件无关的事互相牵连
  await mode(false)
  assert.equal(lib.storageMode(), 'local')
})

test('老版本服务端没有 storage 字段 → 本地模式', async () => {
  await mode(undefined)
  assert.equal(lib.storageMode(), 'local')
})

test('服务端整个探不到 → 本地模式', async () => {
  routes = {} // /health 也没打桩，等于连不上
  await api.health()
  assert.equal(lib.storageMode(), 'local')
})

// ---------------------------------------------------------------- 本地模式

test('本地模式：保存只写 localStorage，不发请求', async () => {
  await mode(false)
  calls = []
  const r = await lib.saveFlow(DEF as never)
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'local')
  assert.equal(calls.length, 0)
  assert.equal(lib.listLocalFlows().length, 1)
})

test('本地模式：列表来自 localStorage', async () => {
  await mode(false)
  await lib.saveFlow(DEF as never)
  const list = await lib.listFlows()
  assert.equal(list.mode, 'local')
  assert.equal(list.flows.length, 1)
  assert.equal(list.localOnly.length, 0)
})

test('本地模式：发布是拒绝的，且说清为什么', async () => {
  await mode(false)
  const r = await lib.publishFlow('f1')
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /DATABASE_URL/)
})

// ---------------------------------------------------------------- 服务端模式

test('服务端模式：列表来自服务端', async () => {
  await mode(true)
  routes['GET /api/flows'] = {
    body: { flows: [{ id: 'f1', name: '日报', activeVersion: 2, updatedAt: '2026-08-16T00:00:00Z',
      archivedAt: null, nodeCount: 3, nodeTypes: ['sql.query'], triggerKind: 'schedule', hasUnpublishedChanges: true }] },
  }
  const list = await lib.listFlows()
  assert.equal(list.mode, 'server')
  assert.equal(list.flows.length, 1)
  assert.equal(list.flows[0].activeVersion, 2)
  assert.equal(list.flows[0].hasUnpublishedChanges, true)
})

test('★ 只存在本地的流程要被标出来，而不是消失', async () => {
  await mode(false)
  await lib.saveFlow({ ...DEF, id: 'only_local', name: '只在本地' } as never)
  await mode(true)
  routes['GET /api/flows'] = { body: { flows: [] } }

  const list = await lib.listFlows()
  assert.equal(list.flows.length, 0)
  assert.equal(list.localOnly.length, 1)
  assert.equal(list.localOnly[0].name, '只在本地')
})

test('★ 不自动上传本地流程 —— 往服务器搬数据是一次明确的动作', async () => {
  await mode(false)
  await lib.saveFlow({ ...DEF, id: 'only_local' } as never)
  await mode(true)
  routes['GET /api/flows'] = { body: { flows: [] } }
  calls = []
  await lib.listFlows()
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
})

const localFlow = (id = 'f1', name = '日报') =>
  ({ id, name, updatedAt: 0, nodeCount: 1, def: { ...DEF, id } } as never)

test('显式上传才发 POST', async () => {
  await mode(true)
  routes['POST /api/flows'] = { body: { id: 'f1' } }
  const r = await lib.uploadOne(localFlow())
  assert.equal(r.ok, true)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
})

// "只存在这台机器上"是**推断**出来的：本地列表减去服务端列表，而服务端那份
// 是过滤过的（归档的、归属别人的都不在里面）。于是"服务器上没有"和"已存在"
// 会同时成立 —— 出路必须能从 code 分出来，光看文案分不出来
test('★ 上传撞上"已存在"时，要把服务端给的 code 带出来', async () => {
  await mode(true)
  routes['POST /api/flows'] = {
    status: 409,
    body: { detail: { code: 'flow_exists_archived', message: '流程 f1 在服务器上已归档（不是不存在），可以恢复' } },
  }
  const r = await lib.uploadOne(localFlow())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'flow_exists_archived')
  assert.match(r.error ?? '', /已归档/)
})

test('★ 恢复归档：先 restore 再写草稿 —— 顺序反了流程仍然看不见', async () => {
  await mode(true)
  routes['POST /api/flows/f1/restore'] = { body: { id: 'f1' } }
  routes['PUT /api/flows/f1'] = { body: { id: 'f1' } }
  calls = []
  const r = await lib.restoreAndUpload(localFlow())
  assert.equal(r.ok, true)
  const posts = calls.filter((c) => c.method === 'POST' || c.method === 'PUT')
  assert.equal(posts[0].url, '/api/flows/f1/restore')
  assert.equal(posts[1].url, '/api/flows/f1')
})

test('★ restore 成功但草稿只落到本地 → 算失败，不能报"上传好了"', async () => {
  await mode(true)
  routes['POST /api/flows/f1/restore'] = { body: { id: 'f1' } }
  routes['PUT /api/flows/f1'] = { status: 503, body: { detail: '数据库不可用' } }
  const r = await lib.restoreAndUpload(localFlow())
  // saveFlow 会返回 ok:true（本地写成功），但这件事的目的就是让服务端拿到它
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /数据库不可用/)
})

// ★★ 同一个 id 在服务端上可能是别人的流程。普通用户去归档会被可见性挡成 404，
// 看不出问题；管理员的 viewer 是 ANY，归档会**成功** —— 于是"清掉我本机这份
// 没用的缓存"会静默归档掉别人正在线上跑的流程
test('★★ 删只在本机的那份，绝不能顺手归档服务端同 id 的流程', async () => {
  await mode(true)
  await lib.saveFlow({ ...DEF, id: 'f1' } as never)
  calls = []
  await lib.deleteFlow('f1', true)
  assert.equal(lib.listLocalFlows().length, 0)
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0)
})

test('服务端上确实有的那条，删除仍然要归档', async () => {
  await mode(true)
  await lib.saveFlow({ ...DEF, id: 'f1' } as never)
  routes['DELETE /api/flows/f1'] = { body: { archived: true } }
  calls = []
  await lib.deleteFlow('f1')
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1)
})

test('★ id 被别人占着 → 换新 id 上传副本，原 id 一次都不许再碰', async () => {
  await mode(true)
  routes['POST /api/flows'] = { body: { id: 'new' } }
  calls = []
  const r = await lib.uploadAsCopy(localFlow(), '日报 副本')
  assert.equal(r.ok, true)
  const sent = calls[0].body as { id: string; definition: { name: string } }
  assert.notEqual(sent.id, 'f1')
  assert.equal(sent.definition.name, '日报 副本')
})

// ★★ 管理员从管理台点得开别人的流程，但那份**不能进本地缓存**：
// 首页列表用的是 scope=mine，里面永远没有它 —— 缓存下来就是一张删了又回来的
// 「只在本机」卡片（删掉 → 再打开一次 → 又写回去）。线上真发生过
test('★★ 不是我的流程，读得到但不写进本地缓存', async () => {
  await mode(true)
  routes['GET /api/flows/other1'] = {
    body: { id: 'other1', name: '别人的日报', owner: 'someone@agora.io', mine: false,
            activeVersion: 1, updatedAt: null, archivedAt: null, nodeCount: 1,
            nodeTypes: [], triggerKind: 'schedule', hasUnpublishedChanges: false,
            draft: { ...DEF, id: 'other1' } },
  }
  const got = await lib.getFlow('other1')
  assert.equal(got?.name, '别人的日报', '读得到 —— 管理台点进去要能打开')
  assert.equal(lib.listLocalFlows().find((f) => f.id === 'other1'), undefined, '★ 但没落到本地')
})

test('是我的流程照旧写穿缓存 —— 服务端挂了还打得开', async () => {
  await mode(true)
  routes['GET /api/flows/mine1'] = {
    body: { id: 'mine1', name: '我的日报', owner: null, mine: true,
            activeVersion: 1, updatedAt: null, archivedAt: null, nodeCount: 1,
            nodeTypes: [], triggerKind: 'manual', hasUnpublishedChanges: false,
            draft: { ...DEF, id: 'mine1' } },
  }
  await lib.getFlow('mine1')
  assert.ok(lib.listLocalFlows().some((f) => f.id === 'mine1'))
})

// 老服务端不返回 mine。按 true 处理，否则升级顺序一反（前端先上）
// 所有人的离线兜底都会静默失效
test('老服务端没有 mine 字段：当成我的，行为和以前一致', async () => {
  await mode(true)
  routes['GET /api/flows/legacy1'] = {
    body: { id: 'legacy1', name: '老服务端', owner: null,
            activeVersion: null, updatedAt: null, archivedAt: null, nodeCount: 1,
            nodeTypes: [], triggerKind: 'manual', hasUnpublishedChanges: false,
            draft: { ...DEF, id: 'legacy1' } },
  }
  await lib.getFlow('legacy1')
  assert.ok(lib.listLocalFlows().some((f) => f.id === 'legacy1'))
})

test('★ 服务端读失败 → 退回本地，但把原因带出来', async () => {
  await mode(false)
  await lib.saveFlow(DEF as never)
  await mode(true)
  routes['GET /api/flows'] = { status: 500, body: { detail: '数据库连接中断' } }

  const list = await lib.listFlows()
  // 静默退回会让用户以为服务器上就是这些
  assert.equal(list.mode, 'local')
  assert.equal(list.flows.length, 1)
  assert.match(list.error ?? '', /数据库连接中断/)
})

// ---------------------------------------------------------------- 保存的顺序

test('★ 服务端模式下本地也要写 —— beforeunload 只能同步保存', async () => {
  await mode(true)
  routes['PUT /api/flows/f1'] = { body: { id: 'f1' } }
  await lib.saveFlow(DEF as never)
  assert.equal(lib.listLocalFlows().length, 1)
})

test('★ 服务端写失败但本地成功：不算丢数据，但必须报出来', async () => {
  await mode(true)
  routes['PUT /api/flows/f1'] = { status: 503, body: { detail: '数据库不可用' } }
  const r = await lib.saveFlow(DEF as never)
  assert.equal(r.ok, true)              // 数据没丢
  assert.match(r.error ?? '', /数据库不可用/)   // 但用户以为存到服务器了
  assert.equal(lib.listLocalFlows().length, 1)
  // ★★ 而 ok 为真**不代表服务端拿到了**。发布和手动运行读的都是服务端上那份
  // 草稿，只看 ok 会让它们静默地发出去 / 跑起来一份旧定义
  assert.equal(lib.didSyncToServer(r), false, '★★ 服务端没收到就是没同步，哪怕数据没丢')
})

test('★ 同步判定：只有服务端真的写成功了才算', async () => {
  await mode(true)
  routes['PUT /api/flows/f1'] = { body: { id: 'f1' } }
  assert.equal(lib.didSyncToServer(await lib.saveFlow(DEF as never)), true)

  // 本地模式压根没有"服务端那份"，不能冒充同步过了
  await mode(false)
  assert.equal(lib.didSyncToServer(await lib.saveFlow(DEF as never)), false, '本地模式不算同步')
})

test('服务端上还没有这条时自动补建', async () => {
  await mode(true)
  routes['PUT /api/flows/f1'] = { status: 404, body: { detail: '流程 f1 不存在' } }
  routes['POST /api/flows'] = { body: { id: 'f1' } }
  const r = await lib.saveFlow(DEF as never)
  assert.equal(r.ok, true)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
})

test('saveFlowSync 永远只写本地', async () => {
  await mode(true)
  calls = []
  assert.equal(lib.saveFlowSync(DEF as never), true)
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------- 发布

test('发布返回新版本号', async () => {
  await mode(true)
  routes['POST /api/flows/f1/publish'] = { body: { id: 'f1', activeVersion: 3 } }
  const r = await lib.publishFlow('f1')
  assert.equal(r.ok, true)
  assert.equal(r.version, 3)
})

test('发布失败要带回服务端的原话', async () => {
  await mode(true)
  routes['POST /api/flows/f1/publish'] = { status: 409, body: { detail: '流程 f1 已归档，不能发布' } }
  const r = await lib.publishFlow('f1')
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /已归档/)
})

// ---------------------------------------------------------------- 删除

test('服务端模式下删除既清本地也归档服务端', async () => {
  await mode(false)
  await lib.saveFlow(DEF as never)
  await mode(true)
  routes['DELETE /api/flows/f1'] = { body: { archived: true } }
  calls = []
  await lib.deleteFlow('f1')
  assert.equal(lib.listLocalFlows().length, 0)
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1)
})
