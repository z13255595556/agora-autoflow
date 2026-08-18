import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createFlow, deleteFlow, listFlows, newFlowId, uploadLocalOnly,
  type FlowList, type SavedFlow,
} from '../lib/library'
import { whoami } from '../lib/client'
import { TEMPLATES, type Template } from '../lib/templates'
import { formatDate } from '../lib/datefn'
import { NODE_TYPE_MAP, CATEGORY_COLOR } from '../registry'
import type { FlowDefinition } from '../types'
import Icon from './Icon'
import { normalizeFlowDefinition } from '../lib/flowImport'
import { isSchedulerAlive, SCHEDULER_OFF_DETAIL } from '../lib/scheduler'

/**
 * 首页 = 流程列表。
 *
 * 之前这里是一段说明文字加三张模板卡，保存过的流程排在下面一行一条 ——
 * 主角（我编过的流程）不应被当成附注、让模板占满首屏。这一版按实际使用频率
 * 应用列表来：流程是卡片网格的主体，新建收进顶部一个按钮，列表有搜索、
 * 有排序、每张卡能直接复制/导出/删除。
 */
export default function Home({
  ready,
  onOpenTemplate,
  onOpenSaved,
  onImport,
}: {
  /**
   * health 探完了没。**列表必须等它** —— storageMode() 是同步读的，
   * 探测没回来时它一律是 'local'，于是首页会拿本地那份当全部内容显示出来，
   * 而服务端上的流程一条都不出现。这个错法很隐蔽：界面看着完全正常。
   */
  ready: boolean
  onOpenTemplate: (t: Template) => void
  onOpenSaved: (f: SavedFlow) => void
  onImport: (def: FlowDefinition) => void
}) {
  // 删除/复制后要重新读，用一个计数器触发
  const [tick, setTick] = useState(0)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [list, setList] = useState<FlowList>({ flows: [], mode: 'local', localOnly: [] })
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  /** 我是谁。服务端从登录 cookie 解出来的邮箱，认不出就是 null */
  const [me, setMe] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    // 认不出身份不是错误（本地开发就没有 cookie），静默就好 —— 该说的话
    // 由「无主」标签和 /whoami 去说
    void whoami().then((who) => setMe(who.creator)).catch(() => setMe(null))
  }, [ready])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setLoading(true)
    void listFlows().then((got) => {
      if (cancelled) return
      setList(got)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [tick, ready])

  const saved = list.flows
  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return kw ? saved.filter((f) => f.name.toLowerCase().includes(kw)) : saved
  }, [saved, q])

  const remove = async (f: SavedFlow) => {
    const warn = list.mode === 'server'
      ? `删除「${f.name}」？服务端会归档（运行历史还查得到），本地那份直接删掉。`
      : `删除「${f.name}」？删了就没了，本地存的没有回收站。`
    if (!confirm(warn)) return
    await deleteFlow(f.id)
    setTick((t) => t + 1)
  }

  const duplicate = async (f: SavedFlow) => {
    // 换个 id 再存，否则会覆盖原来那条
    const result = await createFlow({ ...f.def, id: newFlowId(), name: `${f.name} 副本` })
    if (!result.ok) alert(result.error ?? '复制失败')
    setTick((t) => t + 1)
  }

  const upload = async () => {
    setUploading(true)
    const { moved, errors } = await uploadLocalOnly(list.localOnly)
    setUploading(false)
    if (errors.length) alert(`上传了 ${moved} 条，${errors.length} 条失败：\n${errors.join('\n')}`)
    setTick((t) => t + 1)
  }

  const exportJson = (f: SavedFlow) => {
    const blob = new Blob([JSON.stringify(f.def, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${f.name || 'flow'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importFile = async (file: File) => {
    try {
      const id = newFlowId()
      const def = normalizeFlowDefinition(JSON.parse(await file.text()), id)
      // 首页导入始终是一条新流程，不覆盖库里同 id 的记录。
      onImport({ ...def, id })
    } catch (e) {
      alert(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="home">
      <header className="home__bar">
        <div className="home__brand">
          <span className="home__logo">◆</span>
          AutoFlow Studio
        </div>
        <div className="home__spacer" />
        <input
          className="home__search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索流程…"
        />
        <button className="btn" onClick={() => fileRef.current?.click()}>
          导入 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="home__file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void importFile(f)
            e.target.value = ''
          }}
        />
        <button className="btn btn--primary" onClick={() => setCreating(true)}>
          + 新建流程
        </button>
      </header>

      <div className="home__body">
        <div className="home__inner">
          <div className="home__head">
            <h1 className="home__title">我的流程</h1>
            <p className="home__sub">
              把 SQL、通知这些现成服务当积木搭起来。
              {saved.length > 0 && (
                <em>
                  {' '}共 {saved.length} 条 ·{' '}
                  {list.mode === 'server' ? '存在服务器上' : '存在这台机器的浏览器里'}
                </em>
              )}
              {/* 列表只有自己的流程。不说出来的话，"我的流程怎么少了"
                  会先变成一张工单，再变成"这系统把我数据搞丢了" */}
              {list.mode === 'server' && me && <em> · 当前是 {me} 的工作台</em>}
            </p>
          </div>

          {/* 服务端读失败时静默退回本地会让用户以为服务器上就是这些 */}
          {list.error && (
            <div className="home__notice home__notice--warn">
              读不到服务端的流程库，当前显示的是本机缓存：{list.error}
            </div>
          )}

          {/* 只存在本地的流程绝不能从列表里消失，但也不自动上传 ——
              往服务器上搬数据应该是一次明确的动作 */}
          {list.localOnly.length > 0 && (
            <div className="home__notice">
              还有 {list.localOnly.length} 条流程只存在这台机器上（
              {list.localOnly.slice(0, 3).map((f) => f.name).join('、')}
              {list.localOnly.length > 3 ? ' 等' : ''}），服务器上没有。
              <button className="btn btn--sm" disabled={uploading} onClick={() => void upload()}>
                {uploading ? '上传中…' : '上传到服务器'}
              </button>
            </div>
          )}

          {loading ? (
            <div className="empty">正在读取流程库…</div>
          ) : saved.length === 0 ? (
            <div className="home__blank">
              <div className="home__blankicon">◆</div>
              <div className="home__blanktitle">还没有流程</div>
              <div className="home__blanktext">
                从一个模板开始最快 —— 节点已经连好，填上 SQL 和群机器人地址就能跑。
              </div>
              <div className="home__blankcards">
                {TEMPLATES.map((t) => (
                  <button key={t.key} className="tplcard" onClick={() => onOpenTemplate(t)}>
                    <span className="tplcard__icon">{t.icon}</span>
                    <span className="tplcard__name">{t.name}</span>
                    <span className="tplcard__desc">{t.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : shown.length === 0 ? (
            <div className="empty">没有名字匹配「{q}」的流程。</div>
          ) : (
            <div className="grid">
              {shown.map((f) => (
                <FlowCard
                  key={f.id}
                  flow={f}
                  onOpen={() => onOpenSaved(f)}
                  onDuplicate={() => duplicate(f)}
                  onExport={() => exportJson(f)}
                  onDelete={() => remove(f)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {creating && (
        <div className="modal__mask" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <span className="modal__title">新建流程</span>
              <button className="modal__x" onClick={() => setCreating(false)}>
                <Icon name="close" />
              </button>
            </div>
            <div className="modal__note">选择触发方式从零开始，或直接导入常用流程模板。</div>
            <section className="modal__group" aria-labelledby="create-from-scratch">
              <h2 className="modal__group-title" id="create-from-scratch">从零开始创建</h2>
              <div className="modal__cards">
                {TEMPLATES.filter((t) => t.key !== 'scheduled-sql').map((t) => (
                  <button key={t.key} className="tplcard" onClick={() => onOpenTemplate(t)}>
                    <span className="tplcard__icon">{t.icon}</span>
                    <span className="tplcard__name">{t.name}</span>
                    <span className="tplcard__desc">{t.desc}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="modal__group" aria-labelledby="import-from-template">
              <h2 className="modal__group-title" id="import-from-template">从模板导入</h2>
              <div className="modal__cards modal__cards--templates">
                {TEMPLATES.filter((t) => t.key === 'scheduled-sql').map((t) => (
                  <button key={t.key} className="tplcard" onClick={() => onOpenTemplate(t)}>
                    <span className="tplcard__icon">{t.icon}</span>
                    <span className="tplcard__name">{t.name}</span>
                    <span className="tplcard__desc">{t.desc}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  )
}

function FlowCard({
  flow,
  onOpen,
  onDuplicate,
  onExport,
  onDelete,
}: {
  flow: SavedFlow
  onOpen: () => void
  onDuplicate: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  // 服务端算好的那个优先。def.trigger 对本地没缓存过的流程是空壳 ——
  // 只读它的话，"这台浏览器没打开过"的定时流程会显示成手动触发
  const kind = flow.triggerKind ?? flow.def.trigger?.kind
  const scheduled = kind === 'schedule'
  // webhook 流程以前也显示成「手动触发」—— 明明外部系统随时能打进来，
  // 列表页却说它只能手点。这一栏的用途正是一眼扫出哪些流程会自己动
  const hooked = kind === 'webhook'
  // 卡片上标出用到了哪些节点 —— 一眼能认出"这条是发企微的"，比只写节点数有用
  const kinds = useMemo(() => {
    const seen = new Map<string, { icon: string; name: string; color: string }>()
    for (const n of flow.def.nodes ?? []) {
      const t = NODE_TYPE_MAP.get(n.type)
      if (!t || t.category === '触发器' || seen.has(t.type)) continue
      seen.set(t.type, { icon: t.icon, name: t.name, color: CATEGORY_COLOR[t.category] ?? '#64748b' })
    }
    return [...seen.values()].slice(0, 4)
  }, [flow])

  return (
    <div className="fcard">
      <button className="fcard__hit" onClick={onOpen} title={`打开「${flow.name}」`}>
        <span className={`fcard__icon${scheduled ? ' fcard__icon--sched' : ''}`}>{scheduled ? '⏰' : hooked ? '🔗' : '▶'}</span>
        <span className="fcard__name">{flow.name}</span>
        {/* 「定时触发」这个标签本身就在暗示它会自己跑。调度器没接上之前，
            纠正必须紧挨着它 —— 否则用户在列表页扫一眼就会相信它在跑 */}
        <span
          className={`fcard__tag${scheduled ? (isSchedulerAlive() ? ' fcard__tag--sched' : ' fcard__tag--sched-off') : ''}`}
          title={scheduled && !isSchedulerAlive() ? SCHEDULER_OFF_DETAIL : undefined}
        >
          {scheduled
            ? (isSchedulerAlive() ? '定时触发' : '定时触发 · 未生效')
            : hooked ? 'Webhook 触发' : '手动触发'}
        </span>
        <span className="fcard__kinds">
          {/* 归属功能上线之前建的流程还没有主，所有人都看得见。要说清楚怎么认领，
              否则用户只会疑惑"这条为什么别人那儿也有" */}
          {flow.origin === 'server' && flow.owner === null && (
            <span className="fcard__kind fcard__kind--orphan" title="这条流程建于归属功能上线之前，还没有主。发布一次就归你，之后只有你看得到">
              还没有归属
            </span>
          )}
          {kinds.map((k) => (
            <span className="fcard__kind" key={k.name} style={{ '--accent': k.color } as React.CSSProperties}>
              {k.icon} {k.name}
            </span>
          ))}
          {kinds.length === 0 && <span className="fcard__kind fcard__kind--none">只有触发器</span>}
        </span>
        <span className="fcard__foot">
          {flow.nodeCount} 个节点 · 更新于 {formatDate(new Date(flow.updatedAt), 'yyyy-MM-dd HH:mm')}
        </span>
      </button>

      <div className="menu fcard__menu" ref={ref}>
        <button className="fcard__more" onClick={() => setMenu((v) => !v)} title="更多操作">
          <Icon name="more" />
        </button>
        {menu && (
          <div className="menu__pop menu__pop--right">
            <button className="menu__item" onClick={() => { setMenu(false); onDuplicate() }}>
              创建副本
            </button>
            <button className="menu__item" onClick={() => { setMenu(false); onExport() }}>
              导出 JSON
            </button>
            <i className="menu__sep" />
            <button className="menu__item menu__item--danger" onClick={() => { setMenu(false); onDelete() }}>
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
