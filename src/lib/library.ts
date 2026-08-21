import type { FlowDefinition } from '../types'
import { normalizeFlowDefinition } from './flowImport.ts'
import * as api from './client.ts'

/**
 * 流程库。**两个后端，本地永远写。**
 *
 * - 服务端可用（配了 DATABASE_URL）→ 列表和加载都以服务端为准
 * - 不可用 → 整套退回 localStorage，编辑器照常用
 *
 * 为什么本地那份永远写、哪怕服务端在：
 *
 * 1. `beforeunload` 只能同步保存。关标签页那一刻发一个 fetch 出去，浏览器
 *    没有义务等它完成 —— 而这恰好是最需要保住数据的时刻。localStorage 是同步的。
 * 2. 服务端挂了的时候不能连编辑器都打不开。这和"节点服务探不到就退回 mock"
 *    是同一条约定。
 *
 * 所以本地那份的角色从"唯一真相"变成了"写穿缓存 + 离线兜底"。
 */

const KEY = 'autoflow.flows.v1'
/** 只留最近这些条。流程定义可能很大，localStorage 总共就 5MB 左右 */
const MAX = 30

export interface SavedFlow {
  id: string
  name: string
  /** 毫秒时间戳 */
  updatedAt: number
  nodeCount: number
  def: FlowDefinition
  /** 已发布并生效的版本号。null = 从未发布，或者这条只存在本地 */
  activeVersion?: number | null
  /** 草稿和已发布那一版不一致 —— 定时/webhook 跑的是已发布那版 */
  hasUnpublishedChanges?: boolean
  /** 这条是从哪来的。'local' 表示服务端上没有它 */
  origin?: 'server' | 'local'
  /**
   * 归属（邮箱）。null = 还没有主，谁发布一次就归谁。
   *
   * scope='mine' 的列表里**不会**出现别人的流程 —— 服务端就没返回。
   * scope='all'（管理台）会，那时这个字段是分组的依据。
   *
   * 两种情况下都**不做前端过滤**：把权限判断放到前端等于没有权限判断。
   */
  owner?: string | null
  /**
   * 触发方式，服务端算好的。
   *
   * **不能从 def.trigger 读**：列表页拿到的 def 对于本地没缓存过的流程是个空壳
   * （见 listFlows），于是"这台浏览器没打开过"的定时流程会显示成手动触发 ——
   * 而这一栏的用途正是一眼扫出哪些流程会自己动。
   */
  triggerKind?: string
}

export type StorageMode = 'server' | 'local'

export function storageMode(): StorageMode {
  return api.hasRemoteStorage() ? 'server' : 'local'
}

// ---------------------------------------------------------------- 本地那一份

/**
 * 读本地库。localStorage 在隐私模式/配额满时会抛，存的内容也可能被别的版本
 * 写坏 —— 这两种情况都当"库是空的"，绝不能让首页白屏。
 */
export function listLocalFlows(): SavedFlow[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): SavedFlow[] => {
      if (!item || typeof item !== 'object') return []
      const candidate = item as Partial<SavedFlow>
      if (typeof candidate.id !== 'string' || !candidate.def) return []
      try {
        const def = normalizeFlowDefinition(candidate.def, candidate.id)
        return [{
          id: candidate.id,
          name: typeof candidate.name === 'string' ? candidate.name : def.name,
          updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
          nodeCount: def.nodes.length,
          def: { ...def, id: candidate.id },
          origin: 'local',
        }]
      } catch {
        return []
      }
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function write(list: SavedFlow[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
    return true
  } catch {
    // 配额满 / 隐私模式：不能让编辑器崩，但也不能向 UI 谎报已经保存。
    return false
  }
}

/**
 * 只写本地，同步返回。
 *
 * `beforeunload` 专用 —— 那个时机发不出可靠的异步请求。平时的保存走
 * saveFlow()，它会本地和服务端都写。
 */
export function saveFlowSync(def: FlowDefinition, at: number = Date.now()): boolean {
  const rest = listLocalFlows().filter((f) => f.id !== def.id)
  return write([
    { id: def.id, name: def.name, updatedAt: at, nodeCount: def.nodes.length, def },
    ...rest,
  ])
}

// ---------------------------------------------------------------- 合并视图

function fromRemote(r: api.RemoteFlow, def: FlowDefinition): SavedFlow {
  return {
    id: r.id,
    name: r.name,
    updatedAt: r.updatedAt ? Date.parse(r.updatedAt) : 0,
    nodeCount: r.nodeCount,
    def,
    activeVersion: r.activeVersion,
    hasUnpublishedChanges: r.hasUnpublishedChanges,
    triggerKind: r.triggerKind,
    origin: 'server',
    owner: r.owner,
  }
}

export interface FlowList {
  flows: SavedFlow[]
  mode: StorageMode
  /**
   * 服务端上没有、只存在这台浏览器里的流程。
   *
   * **不自动上传。** 这是用户的数据，往服务器上搬应该是一次明确的动作；
   * 但也绝不能让它们从列表里消失 —— "我的流程不见了"比"多一个按钮"糟糕得多。
   */
  localOnly: SavedFlow[]
  /** 服务端读失败时的原因，UI 要说出来而不是静默退回本地 */
  error?: string
}

export async function listFlows(scope: 'mine' | 'all' = 'mine'): Promise<FlowList> {
  const local = listLocalFlows()
  if (storageMode() === 'local') return { flows: local, mode: 'local', localOnly: [] }

  try {
    // **scope=mine 时连归档的一起要。** 不是为了显示它们 —— 而是"哪些是我删过的"
    // 只有服务端知道：服务端只归档不物理删（运行记录要靠版本快照解释历史），
    // 而本地缓存不跟着清的话，删掉的流程会以「只在本机」的样子回到列表里，
    // 删一次、回来一次。管理台那一屏不合并本地缓存，不需要这一步
    const remote = await api.listRemoteFlows(scope === 'mine', scope)
    const deleted = new Set(remote.filter((r) => r.archivedAt).map((r) => r.id))
    const live = remote.filter((r) => !r.archivedAt)
    const ids = new Set(live.map((r) => r.id))
    // 列表页不需要每条的完整定义，用本地那份或一个壳撑住 nodeCount 之外的字段
    const flows = live.map((r) => {
      const cached = local.find((f) => f.id === r.id)
      return fromRemote(r, cached?.def ?? ({ id: r.id, name: r.name, nodes: [], edges: [], layout: {} } as unknown as FlowDefinition))
    })
    // 服务端说已经删了的，本地那份跟着清掉。**这里是唯一会自愈的地方** ——
    // 修好之前留下的那些幽灵卡片，打开一次首页就没了，不用用户自己再删一遍
    if (local.some((f) => deleted.has(f.id))) void write(local.filter((f) => !deleted.has(f.id)))
    // 管理台不提示"只存在本地"：那是当前这台浏览器的事，混进全局视图只会让人
    // 以为服务器上少了东西
    const localOnly = scope === 'all'
      ? []
      : local.filter((f) => !ids.has(f.id) && !deleted.has(f.id))
    return { flows, mode: 'server', localOnly }
  } catch (err) {
    // 退回本地可以，但必须说出来 —— 静默退回会让用户以为服务端上就是这些
    return {
      flows: local,
      mode: 'local',
      localOnly: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function getFlow(id: string): Promise<SavedFlow | null> {
  if (storageMode() === 'server') {
    try {
      const r = await api.getRemoteFlow(id)
      // 已归档 = 用户删过它。**当作不存在** —— 读得到不等于该出现在界面上：
      // 归档的流程不在任何列表里，缓存下来就是一张删了又回来的「只在本机」。
      // 后退键、书签、另一个标签页刷新，走的都是这条路。
      // 本地那份也一并清掉，然后返回 null，让编辑器退回首页
      if (r.archivedAt) {
        forgetLocal(id)
        return null
      }
      if (r.draft) {
        const def = normalizeFlowDefinition(r.draft, id)
        // 服务端那份也写进本地：下次服务端挂了还打得开。
        //
        // **但只缓存"我的工作台"里的那些。** 管理员从管理台点开别人的流程时
        // 读得到它，可首页列表用的是 scope=mine，那条永远不会出现在里面 ——
        // 缓存下来就是一张「只在本机」的卡片：删掉、再打开一次、它又回来了。
        // 老服务端不返回 mine，按 true 处理，行为和以前一致
        if (r.mine !== false) saveFlowSync(def, r.updatedAt ? Date.parse(r.updatedAt) : Date.now())
        return fromRemote(r, def)
      }
    } catch {
      // 落到本地兜底。单条读失败不值得打断用户，列表页已经报过服务端状态
    }
  }
  return listLocalFlows().find((f) => f.id === id) ?? null
}

export interface SaveResult {
  ok: boolean
  mode: StorageMode
  /** 服务端拒绝或不可达的原因。本地写成功时它只是降级提示，不是失败 */
  error?: string
  /**
   * 服务端给的错误码。目前只关心 `flow_archived` —— 这条已经被删了，
   * 和"服务端暂时不可达"是完全相反的两件事：一个不该重试也不该留本地缓存，
   * 另一个正好相反。**按 code 分支，不要按文案。**
   */
  code?: string
  /**
   * 存完之后，草稿和已发布那一版还有没有差别。**服务端算的**。
   *
   * 前端自己推不出来：这把尺子只比逻辑不比布局（拖一下节点位置不算改动），
   * 前端再抄一份必漂。服务端没答上来（本地兜底、写失败）时是 undefined，
   * 调用方按"可能有改动"处理 —— 少提示一次比谎报"已经是最新"强。
   */
  hasUnpublishedChanges?: boolean
}

/**
 * 服务端**真的**拿到这次保存了吗。
 *
 * `ok` 的含义是"数据没丢"—— 服务端写失败但本地写成功时它仍然是 true，
 * 这对自动保存是对的（服务端挂了不该把人锁在编辑器里），但对
 * **发布**和**调试运行**是错的：那两件事读的是服务端上那份草稿，
 * 服务端还是旧的时候，发出去的 / 跑起来的都不是眼前这一份，
 * 而这件事本身没有任何迹象。
 */
export const didSyncToServer = (r: SaveResult): boolean =>
  r.ok && r.mode === 'server' && !r.error

/**
 * 保存。**先写本地，再写服务端。**
 *
 * 顺序是有意的：本地写是同步且几乎不会失败的，先落地保证任何情况下都不丢；
 * 服务端写失败时用户至少还能继续编辑，下次保存会再试。
 */
export async function saveFlow(def: FlowDefinition, at: number = Date.now()): Promise<SaveResult> {
  const localOk = saveFlowSync(def, at)
  if (storageMode() === 'local') {
    return localOk
      ? { ok: true, mode: 'local' }
      : { ok: false, mode: 'local', error: '浏览器本地存储写入失败，请检查存储空间或隐私设置' }
  }
  try {
    const saved = await api.saveRemoteFlow(def.id, def)
    return { ok: true, mode: 'server', hasUnpublishedChanges: saved.hasUnpublishedChanges }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 服务端说这条已经被删了（多半是另一个标签页删的，而这一页还开着编辑器）。
    // **本地那份必须跟着清掉** —— 上面第一行刚写过它，留着就是下一张
    // 「只在本机」的卡片，回首页又要重新解释一遍"这是什么、要不要传"。
    // 和"服务端暂时不可达"相反：那种情况下本地那份正是唯一的救命稻草
    if ((err as { code?: string }).code === 'flow_archived') {
      forgetLocal(def.id)
      return { ok: false, mode: 'server', code: 'flow_archived', error: msg }
    }
    // 404 = 服务端还没有这条，补建一次。编辑器里新建流程走的就是这条路
    if (msg.includes('不存在')) {
      try {
        const made = await api.createRemoteFlow(def.id, def)
        return { ok: true, mode: 'server', hasUnpublishedChanges: made.hasUnpublishedChanges }
      } catch (err2) {
        return { ok: localOk, mode: 'server', error: err2 instanceof Error ? err2.message : String(err2) }
      }
    }
    return { ok: localOk, mode: 'server', error: msg }
  }
}

export async function createFlow(def: FlowDefinition): Promise<SaveResult> {
  const localOk = saveFlowSync(def)
  if (storageMode() === 'local') {
    return localOk ? { ok: true, mode: 'local' } : { ok: false, mode: 'local', error: '浏览器本地存储写入失败' }
  }
  try {
    await api.createRemoteFlow(def.id, def)
    return { ok: true, mode: 'server' }
  } catch (err) {
    return { ok: localOk, mode: 'server', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 删除。
 *
 * `localOnly` = 这条在服务端的列表里根本没出现过。**这时绝不能碰服务端。**
 *
 * 同一个 id 在服务端上可能是**别人的**流程（无主流程谁发布一次就归谁，
 * 而你本地还留着以前打开时写下的那份缓存）。普通用户去归档它会被可见性挡成
 * 404，看不出问题；但管理员的 viewer 是 ANY —— 归档会**成功**。
 * 于是"清掉我本机这份没用的缓存"会静默归档掉别人正在线上跑的流程，
 * 而确认框上写的是"它只存在这台机器上"。
 */
export async function deleteFlow(id: string, localOnly = false): Promise<void> {
  void write(listLocalFlows().filter((f) => f.id !== id))
  if (storageMode() === 'server' && !localOnly) {
    // 服务端是归档不是物理删 —— 运行记录要靠版本快照解释历史
    try {
      await api.archiveRemoteFlow(id)
    } catch {
      /* 本地已经删了，服务端下次列表刷新会体现 */
    }
  }
}

/**
 * 发布：草稿 → 新版本 → 设为生效。只有服务端模式下有意义。
 *
 * `note` 是这一版的变更说明，选填。**草稿和线上那一版一样时服务端不生新版本**
 * —— 那时返回的还是原来那个号，说明也无处可记（没有新版本）。
 */
export async function publishFlow(
  id: string,
  note?: string,
): Promise<{ ok: boolean; version?: number; error?: string }> {
  if (storageMode() !== 'server') {
    return { ok: false, error: '未连接流程存储，发布需要服务端（配置 DATABASE_URL）' }
  }
  try {
    const r = await api.publishRemoteFlow(id, note)
    return { ok: true, version: r.activeVersion ?? undefined }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface RollbackResult {
  ok: boolean
  version?: number
  /** 切过去之后的草稿。编辑器要用它重画画布，否则屏幕上还是切换前那份 */
  def?: FlowDefinition
  error?: string
}

/**
 * 切回某一个历史版本。
 *
 * **两个后果，调用方必须先跟用户说清**：线上（定时/webhook）下一次触发就跑
 * 这一版；编辑器里的草稿也会被它覆盖 —— 只切线上不动草稿的话，下一次发布
 * 就把刚切掉的东西原路发回去了。
 *
 * 本地缓存跟着写：不写的话服务端挂了之后从本地打开的还是切换前那份。
 */
export async function rollbackFlow(id: string, version: number): Promise<RollbackResult> {
  if (storageMode() !== 'server') {
    return { ok: false, error: '未连接流程存储，版本切换需要服务端（配置 DATABASE_URL）' }
  }
  try {
    const r = await api.activateRemoteVersion(id, version)
    const def = r.draft ? normalizeFlowDefinition(r.draft, id) : undefined
    if (def) saveFlowSync(def, r.updatedAt ? Date.parse(r.updatedAt) : Date.now())
    return { ok: true, version: r.activeVersion ?? undefined, def }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface UploadResult {
  ok: boolean
  /**
   * 服务端给的错误码，目前只有 409 那几个：
   * `flow_exists_archived`（服务器上有，只是归档了）、
   * `flow_exists_other_owner`（id 被别人的流程占着）、`flow_exists`（列表旧了）。
   *
   * **按 code 分支，不要按文案** —— 出路完全不同：一个是恢复，一个是换 id。
   */
  code?: string
  error?: string
}

/**
 * 把一条只存在本地的流程搬到服务端。
 *
 * **一条一条来，不做批量。** localOnly 里的每一条失败原因可能不同，
 * 而每种原因要问用户的问题也不同（恢复归档？还是换个 id 建副本？），
 * 批量跑完再一次性弹一堆错的话，用户拿到的是一段没法操作的文本。
 */
export async function uploadOne(f: SavedFlow): Promise<UploadResult> {
  try {
    await api.createRemoteFlow(f.id, f.def)
    return { ok: true }
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code, error: msgOf(err) }
  }
}

/**
 * 恢复一条归档的流程，再用本机这份覆盖服务端的草稿。
 *
 * 顺序不能反：归档状态下 save_draft 会被服务端直接拒掉（409 flow_archived），
 * 而且前端拿到那个 code 会把本机这份也清掉 —— 先 restore 才有得写。
 */
export async function restoreAndUpload(f: SavedFlow): Promise<UploadResult> {
  try {
    await api.restoreRemoteFlow(f.id)
  } catch (err) {
    return { ok: false, error: msgOf(err) }
  }
  const saved = await saveFlow(f.def, f.updatedAt || Date.now())
  // 用 didSyncToServer 而不是 .ok：本地写成功也会返回 ok，
  // 而这里整件事的目的**就是**让服务端拿到它
  return didSyncToServer(saved) ? { ok: true } : { ok: false, error: saved.error ?? '写入服务端失败' }
}

/** 换一个 id 上传成副本。id 被别人占着时这是唯一的出路 */
export async function uploadAsCopy(f: SavedFlow, name: string): Promise<UploadResult> {
  const result = await createFlow({ ...f.def, id: newFlowId(), name })
  return didSyncToServer(result) ? { ok: true } : { ok: false, error: result.error ?? '写入服务端失败' }
}

/** 本地那份搬走之后就不该再留着，否则下次打开还会提示"只存在这台机器上" */
export function forgetLocal(id: string): void {
  void write(listLocalFlows().filter((f) => f.id !== id))
}

/** 每条流程一个新 id —— 不然新建出来的都叫 flow_draft，互相覆盖 */
export function newFlowId(): string {
  return `flow_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
}
