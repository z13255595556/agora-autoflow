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
  // 返回真的 Response 而不是 {ok, status, json} 三件套：client 读响应体的方式
  // （先 text 再 parse，为的是让非 JSON 的错误体也能说人话）是被测行为的一部分，
  // 手搓的替身缺哪个方法，测出来的就是替身而不是那条代码路径
  if (!route) {
    return new Response(JSON.stringify({ detail: `没有打桩 ${key}` }), {
      status: 404, headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(JSON.stringify(route.body ?? {}), {
    status: route.status ?? 200, headers: { 'content-type': 'application/json' },
  })
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

// ★★ getFlow 挡的是"读进来"那一侧，但编辑器的自动保存是另一条写入口：
// 管理员在别人的流程里拖一下节点，900ms 后 saveFlow 就把它落到本机 ——
// 首页上那张「只在本机」的卡片多半是这么来的。编辑器在 mine=false 的流程上
// 必须传 cacheLocal:false
test('★★ cacheLocal:false —— 别人的流程保存时只写服务端，本机一份不留', async () => {
  await mode(true)
  routes['PUT /api/flows/f1'] = { body: { id: 'f1' } }
  const r = await lib.saveFlow(DEF as never, undefined, { cacheLocal: false })
  assert.equal(r.ok, true)
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, '服务端照写 —— 管理员改别人的草稿是放行的')
  assert.equal(lib.listLocalFlows().length, 0, '★ 但 localStorage 一份不留')
})

test('★ cacheLocal:false 时服务端写失败就是失败 —— 没有"已存到本地"可言', async () => {
  await mode(true)
  routes['PUT /api/flows/f1'] = { status: 503, body: { detail: '数据库不可用' } }
  const r = await lib.saveFlow(DEF as never, undefined, { cacheLocal: false })
  assert.equal(r.ok, false, '★ 本地没写，服务端也没收到，这次保存就是丢了 —— 不能报成功')
  assert.match(r.error ?? '', /数据库不可用/)
  assert.equal(lib.listLocalFlows().length, 0)
})

// ★ 修 cacheLocal 之前误写进来的缓存要能自愈：靠用户在卡片上删是删不干净的 ——
// 再打开一次那条流程它就回来。和 listFlows 清归档缓存同一个思路：打开一次就清一次
test('★ 再打开别人的流程，顺手清掉以前误写进本机的那份缓存', async () => {
  await mode(false)
  await lib.saveFlow({ ...DEF, id: 'other1', name: '别人的日报' } as never) // 修之前留下的
  await mode(true)
  routes['GET /api/flows/other1'] = {
    body: { id: 'other1', name: '别人的日报', owner: 'someone@agora.io', mine: false,
            activeVersion: 1, updatedAt: null, archivedAt: null, nodeCount: 1,
            nodeTypes: [], triggerKind: 'schedule', hasUnpublishedChanges: false,
            draft: { ...DEF, id: 'other1' } },
  }
  const got = await lib.getFlow('other1')
  assert.equal(got?.mine, false, '编辑器靠它决定提示条和保存方式')
  assert.equal(got?.owner, 'someone@agora.io', '提示条要说清这是谁的')
  assert.equal(lib.listLocalFlows().find((f) => f.id === 'other1'), undefined, '★ 旧缓存被清掉')
})

// ★ 切版本是第三条写本机的路（getFlow / saveFlow 之外）。服务端的 activate
// 返回和单条读一样带 mine —— 不带的话这里判不出来
test('★ 给别人的流程切版本，切回来的那份也不落本机', async () => {
  await mode(true)
  routes['POST /api/flows/f1/versions/2/activate'] = {
    body: { id: 'f1', activeVersion: 2, updatedAt: null, owner: 'someone@agora.io', mine: false,
            draft: { ...DEF, id: 'f1', name: '第二版' } },
  }
  const r = await lib.rollbackFlow('f1', 2)
  assert.equal(r.ok, true)
  assert.equal(r.def?.name, '第二版', '画布照样要换成切回来的那版')
  assert.equal(lib.listLocalFlows().length, 0, '★ 但不写 localStorage')
})

// ---------------------------------------------------------------- 删掉的就该消失
//
// 服务端的"删除"是归档（运行记录要靠版本快照解释历史），**但归档的流程一条都
// 不该再出现在用户面前**。难点在于它仍然读得到：单条读不带归档过滤，
// 而前端会把读到的草稿写进本地缓存 —— 于是删掉的流程以「只在本机」的样子
// 回到首页，删一次、回来一次。线上真发生过（后退键、书签、另一个标签页刷新）

test('★★ 已归档 = 用户删过它：当作不存在，本地那份一并清掉', async () => {
  await mode(false)
  await lib.saveFlow({ ...DEF, id: 'gone1', name: '删掉的日报' } as never)
  await mode(true)
  routes['GET /api/flows/gone1'] = {
    body: { id: 'gone1', name: '删掉的日报', owner: null, mine: true, activeVersion: 1,
            updatedAt: null, archivedAt: '2026-08-20T00:00:00Z', nodeCount: 1,
            nodeTypes: [], triggerKind: 'manual', hasUnpublishedChanges: false,
            draft: { ...DEF, id: 'gone1' } },
  }
  assert.equal(await lib.getFlow('gone1'), null, '返回 null，编辑器据此退回首页')
  assert.equal(lib.listLocalFlows().length, 0, '★ 本地那份也没了 —— 否则下一秒它就在首页上')
})

test('★★ 首页列表：服务端说已归档的，本地缓存跟着清掉', async () => {
  await mode(false)
  await lib.saveFlow({ ...DEF, id: 'ghost', name: '删掉的日报' } as never)
  await mode(true)
  routes['GET /api/flows'] = {
    body: { flows: [{ id: 'ghost', name: '删掉的日报', activeVersion: 1, updatedAt: null,
      archivedAt: '2026-08-20T00:00:00Z', nodeCount: 1, nodeTypes: [], triggerKind: 'manual',
      hasUnpublishedChanges: false }] },
  }
  calls = []
  const list = await lib.listFlows()
  // 归档的要一起拉回来才知道"哪些是我删过的" —— 只有服务端知道这件事
  assert.ok(calls.some((c) => c.url.includes('includeArchived=true')))
  assert.equal(list.flows.length, 0, '归档的不进列表')
  assert.equal(list.localOnly.length, 0, '★ 也不算「只在本机」')
  assert.equal(lib.listLocalFlows().length, 0, '★ 自愈：修好之前留下的幽灵卡片，打开一次首页就没了')
})

test('★★ 保存撞上「已删除」：本地那份不留，也不报"已存到本地"', async () => {
  await mode(true)
  routes['PUT /api/flows/f1'] = {
    status: 409,
    body: { detail: { code: 'flow_archived', message: '流程 f1 已删除（已归档），不能保存' } },
  }
  const r = await lib.saveFlow(DEF as never)
  assert.equal(r.ok, false)
  // 按 code 分支：和"服务端暂时不可达"完全相反 —— 那种情况下本地那份是救命稻草
  assert.equal(r.code, 'flow_archived')
  assert.equal(lib.listLocalFlows().length, 0, '★ saveFlow 开头写的那份要被撤掉')
})

// ---------------------------------------------------------------- 版本

test('★ 发布把变更说明一起送上去', async () => {
  await mode(true)
  routes['POST /api/flows/f1/publish'] = { body: { id: 'f1', activeVersion: 4 } }
  calls = []
  const r = await lib.publishFlow('f1', '改成按天分区')
  assert.equal(r.ok, true)
  assert.equal(r.version, 4)
  assert.deepEqual(calls[0].body, { note: '改成按天分区' })
})

test('不填说明也能发 —— note 是 null，不是空串', async () => {
  await mode(true)
  routes['POST /api/flows/f1/publish'] = { body: { id: 'f1', activeVersion: 4 } }
  calls = []
  await lib.publishFlow('f1')
  assert.deepEqual(calls[0].body, { note: null })
})

// ★★ 只切线上不动草稿的话，编辑器里还是切换前那份 —— 下一次自动保存
// 就把刚切掉的东西原路写回服务端了。切回去必须连草稿一起换
test('★★ 切回历史版本：把那一版的草稿带回来，本地缓存也跟着换', async () => {
  await mode(true)
  routes['POST /api/flows/f1/versions/2/activate'] = {
    body: { id: 'f1', activeVersion: 2, updatedAt: null,
            draft: { ...DEF, id: 'f1', name: '第二版' } },
  }
  const r = await lib.rollbackFlow('f1', 2)
  assert.equal(r.ok, true)
  assert.equal(r.version, 2)
  assert.equal(r.def?.name, '第二版', '编辑器要拿它重画画布')
  assert.equal(lib.listLocalFlows()[0].name, '第二版', '本地缓存也是新的那份')
})

test('本地模式下切版本是拒绝的，且说清为什么', async () => {
  await mode(false)
  const r = await lib.rollbackFlow('f1', 2)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /DATABASE_URL/)
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

// 这把尺子只比逻辑不比布局（服务端的 _differs），前端再抄一份必漂 ——
// 漂的表现是：拖一下节点位置就点亮「发布 v4」，点下去服务端认定没有实际
// 改动、不生新版本，而按钮刚承诺过一个 v4
test('★ 存完之后"还有没有未发布的改动"以服务端为准', async () => {
  await mode(true)
  routes['PUT /api/flows/f1'] = { body: { id: 'f1', hasUnpublishedChanges: false } }
  const r = await lib.saveFlow(DEF as never)
  assert.equal(r.ok, true)
  assert.equal(r.hasUnpublishedChanges, false)
})

test('服务端没答上来 → undefined，调用方按"可能有改动"处理', async () => {
  await mode(false)
  const r = await lib.saveFlow(DEF as never)
  assert.equal(r.hasUnpublishedChanges, undefined)
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
