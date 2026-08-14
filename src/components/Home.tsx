import { useEffect, useMemo, useRef, useState } from 'react'
import { deleteFlow, listFlows, newFlowId, saveFlow, type SavedFlow } from '../lib/library'
import { TEMPLATES, type Template } from '../lib/templates'
import { formatDate } from '../lib/datefn'
import { NODE_TYPE_MAP, CATEGORY_COLOR } from '../registry'
import type { FlowDefinition } from '../types'
import Icon from './Icon'
import { normalizeFlowDefinition } from '../lib/flowImport'

/**
 * 首页 = 流程列表。
 *
 * 之前这里是一段说明文字加三张模板卡，保存过的流程排在下面一行一条 ——
 * 主角（我编过的流程）不应被当成附注、让模板占满首屏。这一版按实际使用频率
 * 应用列表来：流程是卡片网格的主体，新建收进顶部一个按钮，列表有搜索、
 * 有排序、每张卡能直接复制/导出/删除。
 */
export default function Home({
  onOpenTemplate,
  onOpenSaved,
  onImport,
}: {
  onOpenTemplate: (t: Template) => void
  onOpenSaved: (f: SavedFlow) => void
  onImport: (def: FlowDefinition) => void
}) {
  // 删除/复制后要重新读，用一个计数器触发
  const [tick, setTick] = useState(0)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const saved = useMemo(() => listFlows(), [tick])
  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return kw ? saved.filter((f) => f.name.toLowerCase().includes(kw)) : saved
  }, [saved, q])

  const remove = (f: SavedFlow) => {
    if (!confirm(`删除「${f.name}」？删了就没了，本地存的没有回收站。`)) return
    deleteFlow(f.id)
    setTick((t) => t + 1)
  }

  const duplicate = (f: SavedFlow) => {
    // 换个 id 再存，否则会覆盖原来那条
    saveFlow({ ...f.def, id: newFlowId(), name: `${f.name} 副本` })
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
              把 SQL、通知这些现成服务当积木搭起来，定时自己跑。
              {saved.length > 0 && <em> 共 {saved.length} 条 · 存在这台机器的浏览器里</em>}
            </p>
          </div>

          {saved.length === 0 ? (
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
            <div className="modal__note">从模板开始，节点和连线都是搭好的；空白流程只给一个触发器。</div>
            <div className="modal__cards">
              {TEMPLATES.map((t) => (
                <button key={t.key} className="tplcard" onClick={() => onOpenTemplate(t)}>
                  <span className="tplcard__icon">{t.icon}</span>
                  <span className="tplcard__name">{t.name}</span>
                  <span className="tplcard__desc">{t.desc}</span>
                </button>
              ))}
            </div>
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

  const scheduled = flow.def.trigger?.kind === 'schedule'
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
        <span className={`fcard__icon${scheduled ? ' fcard__icon--sched' : ''}`}>{scheduled ? '⏰' : '▶'}</span>
        <span className="fcard__name">{flow.name}</span>
        <span className={`fcard__tag${scheduled ? ' fcard__tag--sched' : ''}`}>
          {scheduled ? '定时触发' : '手动触发'}
        </span>
        <span className="fcard__kinds">
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
