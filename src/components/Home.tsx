import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createFlow, deleteFlow, forgetLocal, listFlows, newFlowId,
  restoreAndUpload, uploadAsCopy, uploadOne,
  type FlowList, type SavedFlow,
} from '../lib/library'
import { whoami } from '../lib/client'
import { TEMPLATES, type Template } from '../lib/templates'
import { formatDate } from '../lib/datefn'
import type { FlowDefinition } from '../types'
import Icon from './Icon'
import RunHistory from './RunHistory'
import UsageDashboard from './UsageDashboard'
import NotifySettingsDialog from './NotifySettingsDialog'
import { normalizeFlowDefinition } from '../lib/flowImport'
import { isSchedulerAlive, SCHEDULER_OFF_DETAIL } from '../lib/scheduler'
import { flowCardMeta } from '../lib/flowCardMeta'
import { describeNextFire } from '../lib/schedule'
import { filterFlows, type FlowListFilter } from '../lib/flowListFilter'
import { pushToast } from '../lib/toast'

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
  openRun,
  onOpenTemplate,
  onOpenSaved,
  onImport,
}: {
  /** 深链：打开就直接弹某条流程的运行记录（失败告警里的链接） */
  openRun?: { flowId: string; runId?: string }
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
  const [filter, setFilter] = useState<FlowListFilter>('all')
  const [creating, setCreating] = useState(false)
  /** 正在看谁的运行记录。null = 没打开 */
  const [history, setHistory] = useState<SavedFlow | null>(null)
  /** 深链只消费一次：列表刷新不该把已经关掉的运行记录再弹出来 */
  const openedRun = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [list, setList] = useState<FlowList>({ flows: [], mode: 'local', localOnly: [] })
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  /** 我是谁。服务端从登录 cookie 解出来的邮箱，认不出就是 null */
  const [me, setMe] = useState<string | null>(null)
  /**
   * 是不是管理员。**只决定界面显不显示，不是权限本身** ——
   * 服务端每个接口自己再判一次（identity.is_admin 读的是 athena 校验过的
   * /api/me）。前端能改的东西不能当权限用。
   */
  const [admin, setAdmin] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  /**
   * 看哪一屏。**默认永远是「我的」** —— 管理员身份不该悄悄把他自己的工作台
   * 换成全公司的流程：那样他每天真正在用的那一屏就再也回不去了。
   * 管理台是**另开的一个标签**，进去才看得到别人的。
   */
  const [tab, setTab] = useState<'mine' | 'all'>('mine')

  useEffect(() => {
    if (!ready) return
    // 认不出身份不是错误（本地开发就没有 cookie），静默就好 —— 该说的话
    // 由「无主」标签和 /whoami 去说
    void whoami()
      .then((who) => { setMe(who.creator); setAdmin(Boolean(who.isAdmin)) })
      .catch(() => { setMe(null); setAdmin(false) })
  }, [ready])

  // 权限被撤掉时别把人卡在一个只会 403 的标签上
  useEffect(() => { if (!admin) setTab('mine') }, [admin])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setLoading(true)
    void listFlows(tab).then((got) => {
      if (cancelled) return
      setList(got)
      setLoading(false)
      // 深链 `/?flow=…&run=…`：列表到了就直接弹那条流程的运行记录。只做一次
      if (openRun && !openedRun.current) {
        openedRun.current = true
        const target = got.flows.find((f) => f.id === openRun.flowId)
        if (target) setHistory(target)
        else pushToast({ tone: 'warn', text: '链接里的流程不在你的列表里：可能已归档，或不属于你' })
        // 消费掉 query，刷新页面不再重复弹
        window.history.replaceState({}, '', window.location.pathname)
      }
    })
    return () => { cancelled = true }
  }, [tick, ready, tab, openRun])

  /**
   * 首页显示的流程。**服务端模式下把「只在本机」那些也并进来。**
   *
   * 以前它们只在顶部那句提示里露一个名字 —— 打不开、导不出、也删不掉，
   * 唯一的动作是「上传到服务器」。上传不成（id 被别人占了），或者你根本
   * 不想传，就彻底没有出路了，那句提示会永远挂在那儿。
   *
   * 并进列表之后它们是正常的卡片，只是标着「只在本机」—— 想留就留，
   * 想清掉就用卡片自己的删除。这也才对得上代码里那句
   * 「只存在本地的流程绝不能从列表里消失」：以前它们确实是消失的。
   */
  const saved = useMemo(() => {
    if (tab !== 'mine' || list.localOnly.length === 0) return list.flows
    return [...list.flows, ...list.localOnly].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [list, tab])

  const shown = useMemo(() => filterFlows(saved, q, filter), [saved, q, filter])

  /**
   * 管理台的分组。**我自己那组排在最前**，其余按流程数从多到少 ——
   * 管理员进这一屏最常做的是"找某个人的"，而找自己是最高频的那次。
   * 无主的排最后：它们是历史遗留，不是某个人的工作。
   */
  const grouped = useMemo(() => {
    const by = new Map<string | null, SavedFlow[]>()
    for (const f of shown) {
      const key = f.owner ?? null
      const got = by.get(key)
      if (got) got.push(f)
      else by.set(key, [f])
    }
    // ★ 必须先判 me 非空：认不出身份时 me 是 null，而"无主"那一组的键也是
    //   null —— 不挡的话无主会被当成"我的"排到最前、还挂上"我的"标签
    return [...by.entries()].sort(([a, xs], [b, ys]) => {
      if (me && a === me) return -1
      if (me && b === me) return 1
      if (a === null) return 1
      if (b === null) return -1
      return ys.length - xs.length
    })
  }, [shown, me])

  const cardProps = (f: SavedFlow) => ({
    onOpen: () => onOpenSaved(f),
    onDuplicate: () => duplicate(f),
    onExport: () => exportJson(f),
    onDelete: () => remove(f),
    onHistory: () => setHistory(f),
  })

  const remove = async (f: SavedFlow) => {
    // 服务端上没有的那些，删掉就是真没了 —— 不能套用"服务端会归档"那句话
    const warn = f.origin === 'local' && list.mode === 'server'
      ? `删除「${f.name}」？只存在本机，服务端无备份，删除不可恢复。\n需留底请先「导出 JSON」。`
      : list.mode === 'server'
      ? `删除「${f.name}」？服务端归档（运行历史仍可查），本地副本直接删除。`
      : `删除「${f.name}」？不可恢复，本地存储没有回收站。`
    if (!confirm(warn)) return
    // ★ origin==='local' 必须传下去：服务端上同 id 那条可能是**别人的**流程，
    //   而管理员的 viewer 是 ANY，去归档它会成功
    await deleteFlow(f.id, f.origin === 'local')
    setTick((t) => t + 1)
  }

  const duplicate = async (f: SavedFlow) => {
    // 换个 id 再存，否则会覆盖原来那条
    const result = await createFlow({ ...f.def, id: newFlowId(), name: `${f.name} 副本` })
    if (!result.ok) pushToast({ tone: 'error', text: result.error ?? '复制失败' })
    else pushToast({ tone: 'ok', text: `已创建「${f.name} 副本」` })
    setTick((t) => t + 1)
  }

  /**
   * 把只存在本地的流程搬到服务端。
   *
   * **"服务器上没有"这句话是推断出来的，而且经常是错的** —— localOnly 是拿本地
   * 列表减去服务端列表算的，而服务端那份列表**是过滤过的**：归档的不在里面，
   * 归属别人的也不在里面。于是"服务器上没有"和"已存在"会同时成立，
   * 用户拿到一个 409 就走不下去了。这里按服务端给的 code 分出真正的出路。
   */
  const upload = async () => {
    setUploading(true)
    try {
      for (const f of list.localOnly) {
        const r = await uploadOne(f)
        if (r.ok) continue

        if (r.code === 'flow_exists_archived') {
          const go = confirm(
            `「${f.name}」在服务器上是已归档，不是不存在。\n\n` +
            '恢复它，并用本机这份覆盖服务器上的草稿？\n' +
            '注意：配了定时触发的话，恢复后定时会重新开始跑。',
          )
          if (!go) continue
          const done = await restoreAndUpload(f)
          if (!done.ok) pushToast({ tone: 'error', text: `「${f.name}」恢复失败：${done.error}` })
          continue
        }

        if (r.code === 'flow_exists_other_owner') {
          const name = `${f.name} 副本`
          const go = confirm(
            `「${f.name}」的 id 被服务器上另一个人的流程占用，且要不回来。\n\n` +
            `上传成一条新流程「${name}」（换一个 id），并清掉本机这条旧记录？`,
          )
          if (!go) continue
          const done = await uploadAsCopy(f, name)
          // 本机那条旧记录不清掉的话，它的 id 永远撞、永远提示"只存在这台机器上"
          if (done.ok) forgetLocal(f.id)
          else pushToast({ tone: 'error', text: `「${f.name}」上传副本失败：${done.error}` })
          continue
        }

        if (r.code === 'flow_exists') {
          pushToast({ tone: 'warn', text: `「${f.name}」服务器上已存在，本机列表是旧的，刷新即可看到。` })
          continue
        }

        pushToast({ tone: 'error', text: `「${f.name}」上传失败：${r.error}` })
      }
    } finally {
      setUploading(false)
      setTick((t) => t + 1)
    }
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
      pushToast({ tone: 'error', text: `导入失败：${e instanceof Error ? e.message : String(e)}` })
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
        <div className="hfilters" role="group" aria-label="筛选">
          {([['all', '全部'], ['schedule', '定时'], ['webhook', 'Webhook'], ['local', '只在本机']] as const).map(([key, label]) => (
            <button
              key={key}
              className={`hfilters__t${filter === key ? ' on' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {admin && (
          <button className="btn btn--admin" onClick={() => setUsageOpen(true)} title="全部用户的运行统计">
            用量看板
          </button>
        )}
        {/* 失败通知是**服务端模式且认得出你是谁**才有意义的：本地模式没有 worker、
            也就没有告警；认不出身份的话这份设置无处可存（见 /api/me/notify 的 403）。
            和「流程设置」里那块同一个理由 —— 不画一个存不了的输入框。 */}
        {list.mode === 'server' && me && (
          <button className="btn" onClick={() => setNotifyOpen(true)} title="我的流程失败时通知我">
            失败通知
          </button>
        )}
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
          {/* 管理台是**另一个标签**，不是把别人的流程堆进首页。
              两屏的语义完全不同：一个是"我每天在用的东西"，一个是"我在管的东西" */}
          {admin && (
            <div className="htabs">
              <button className={`htabs__t${tab === 'mine' ? ' on' : ''}`} onClick={() => setTab('mine')}>
                我的流程
              </button>
              <button className={`htabs__t${tab === 'all' ? ' on' : ''}`} onClick={() => setTab('all')}>
                全部用户
              </button>
            </div>
          )}

          <div className="home__head">
            <h1 className="home__title">{tab === 'all' ? '全部用户的流程' : '我的流程'}</h1>
            {saved.length > 0 && (
              <button className="btn btn--ghost" onClick={() => setCreating(true)}>从模板新建</button>
            )}
            <p className="home__sub">
              {tab === 'all'
                ? '按归属分组。可查看和修改所有人的流程，改动他人流程前请先确认。'
                : '把 SQL、通知这些现成服务当积木搭起来。'}
              {saved.length > 0 && (
                <em>
                  {' '}共 {saved.length} 条 ·{' '}
                  {list.mode === 'server' ? '存在服务器上' : '存在这台机器的浏览器里'}
                  {tab === 'mine' && list.localOnly.length > 0
                    && `，其中 ${list.localOnly.length} 条只在本机`}
                </em>
              )}
              {/* 列表只有自己的流程。不说出来的话，"我的流程怎么少了"
                  会先变成一张工单，再变成"这系统把我数据搞丢了" */}
              {tab === 'mine' && list.mode === 'server' && me && <em> · 当前是 {me} 的工作台</em>}
            </p>
          </div>

          {/* 服务端读失败时静默退回本地会让用户以为服务器上就是这些 */}
          {list.error && (
            <div className="home__notice home__notice--warn">
              读不到服务端的流程库，当前显示的是本机缓存：{list.error}
              <button className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>重试</button>
            </div>
          )}

          {/* 只存在本地的流程绝不能从列表里消失，但也不自动上传 ——
              往服务器上搬数据应该是一次明确的动作。

              文案**不能写死"服务器上没有"**：这一栏是拿本地列表减去服务端列表
              算出来的，而服务端那份是过滤过的（归属别人的不在里面）。
              说满了的话，用户点下去撞上"已存在"就再也解释不通了。

              归档的**不在这一栏里** —— 归档就是"用户删过它"，listFlows 会把
              本机那份一起清掉。删了的东西不该再回到这一屏上问一次要不要上传。

              这条提示只是个汇总 + 批量上传。真正的出路在卡片上：它们现在就在
              下面的列表里，标着「只在本机」，不想传的直接删掉就行 */}
          {tab === 'mine' && list.localOnly.length > 0 && (
            <div className="home__notice">
              {list.localOnly.length} 条只在本机。不需要的在卡片上删除。
              <button className="btn btn--sm" disabled={uploading} onClick={() => void upload()}>
                {uploading ? '上传中…' : '全部上传到服务器'}
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
                选模板或触发器开始。
              </div>
              <div className="home__blankcards">
                {TEMPLATES.filter((t) => t.kind === 'recipe').map((t) => (
                  <button key={t.key} className="tplcard" onClick={() => onOpenTemplate(t)}>
                    <span className="tplcard__icon">{t.icon}</span>
                    <span className="tplcard__name">{t.name}</span>
                    <span className="tplcard__desc">{t.desc}</span>
                  </button>
                ))}
              </div>
              <div className="home__blankcards">
                {TEMPLATES.filter((t) => t.kind === 'blank').map((t) => (
                  <button key={t.key} className="tplcard" onClick={() => onOpenTemplate(t)}>
                    <span className="tplcard__icon">{t.icon}</span>
                    <span className="tplcard__name">{t.name}</span>
                    <span className="tplcard__desc">{t.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : shown.length === 0 ? (
            <div className="empty">{filter === 'all' ? `没有名字匹配「${q}」的流程。` : '这个筛选下没有流程。'}</div>
          ) : tab === 'mine' ? (
            <div className="grid">
              {shown.map((f) => (
                <FlowCard key={f.id} flow={f} {...cardProps(f)} />
              ))}
            </div>
          ) : (
            // 管理台按归属分组。一屏一百条别人的流程平铺着，
            // "这是谁的"要一张张卡去认 —— 分组之后这个问题在标题上就答完了
            <div className="ugroups">
              {grouped.map(([owner, flows]) => (
                <section className="ugroup" key={owner ?? '__none__'}>
                  <h2 className="ugroup__title">
                    {owner ?? '还没有归属'}
                    <em>{flows.length} 条</em>
                    {!!me && owner === me && <b className="ugroup__me">我的</b>}
                  </h2>
                  <div className="grid">
                    {flows.map((f) => (
                      <FlowCard key={f.id} flow={f} {...cardProps(f)} />
                    ))}
                  </div>
                </section>
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
            <section className="modal__group" aria-labelledby="create-from-scratch">
              <h2 className="modal__group-title" id="create-from-scratch">选一个触发器</h2>
              <div className="modal__cards">
                {TEMPLATES.filter((t) => t.kind === 'blank').map((t) => (
                  <button key={t.key} className="tplcard" onClick={() => onOpenTemplate(t)}>
                    <span className="tplcard__icon">{t.icon}</span>
                    <span className="tplcard__name">{t.name}</span>
                    <span className="tplcard__desc">{t.desc}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="modal__group" aria-labelledby="import-from-template">
              <h2 className="modal__group-title" id="import-from-template">用做好的模板</h2>
              <div className="modal__cards modal__cards--templates">
                {TEMPLATES.filter((t) => t.kind === 'recipe').map((t) => (
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

      {history && <RunHistory flow={history} initialRunId={openRun?.flowId === history.id ? openRun.runId : undefined} onClose={() => setHistory(null)} />}
      {usageOpen && <UsageDashboard onClose={() => setUsageOpen(false)} />}
      {notifyOpen && <NotifySettingsDialog onClose={() => setNotifyOpen(false)} />}
    </div>
  )
}

function FlowCard({
  flow,
  onOpen,
  onDuplicate,
  onExport,
  onDelete,
  onHistory,
}: {
  flow: SavedFlow
  onOpen: () => void
  onDuplicate: () => void
  onExport: () => void
  onDelete: () => void
  onHistory: () => void
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
  const hooked = kind === 'webhook'
  const meta = flowCardMeta(flow.def)
  // 「下次 明天 09:00」来自调度器（含 misfire / 重叠之后的实际值），不从草稿算：
  // 草稿和线上可能不是一份，而且壳定义里根本没有排程参数
  const nextFire = scheduled && isSchedulerAlive() ? describeNextFire(flow.nextFireAt, new Date()) : null
  const triggerLabel = scheduled
    ? (isSchedulerAlive() ? `${meta.scheduleText ?? '定时触发'}${nextFire ? ` · 下次 ${nextFire}` : ''}` : '定时触发 · 未生效')
    : hooked ? 'Webhook 触发' : '手动触发'
  return (
    // 菜单展开时把整张卡抬起来。.fcard:hover 的 transform 会造一个层叠上下文，
    // 把菜单的 z-index 关在卡片内部 —— 于是下一行的卡片会盖住菜单下半截。
    // 只提菜单自己的 z-index 没用，被困住的正是它
    <div className={`fcard${menu ? ' fcard--menu' : ''}`}>
      <button className="fcard__hit" onClick={onOpen} title={`打开「${flow.name}」`}>
        <span className={`fcard__icon${scheduled ? ' fcard__icon--sched' : ''}`}>{scheduled ? '⏰' : hooked ? '🔗' : '▶'}</span>
        <span className="fcard__name">{flow.name}</span>
        {/* 「定时触发」这个标签本身就在暗示它会自己跑。调度器没接上之前，
            纠正必须紧挨着它 —— 否则用户在列表页扫一眼就会相信它在跑 */}
        <span
          className={`fcard__tag${scheduled ? (isSchedulerAlive() ? ' fcard__tag--sched' : ' fcard__tag--sched-off') : ''}`}
          title={scheduled && !isSchedulerAlive() ? SCHEDULER_OFF_DETAIL : undefined}
        >
          {triggerLabel}
        </span>
        <span className="fcard__foot">
          {flow.origin === 'local' && <b className="fcard__local">只在本机</b>}
          {flow.origin === 'server' && flow.owner === null && '还没有归属 · '}
          {meta.nodeLabels.length > 0 && `${meta.nodeLabels.join(' · ')} · `}
          {flow.hasUnpublishedChanges && '草稿未发布 · '}
          {flow.nodeCount} 个节点 · 更新于 {formatDate(new Date(flow.updatedAt), 'yyyy-MM-dd HH:mm')}
        </span>
      </button>

      <div className="menu fcard__menu" ref={ref}>
        <button className="fcard__more" onClick={() => setMenu((v) => !v)} title="更多操作">
          <Icon name="more" />
        </button>
        {menu && (
          <div className="menu__pop menu__pop--right">
            {/* 运行记录排第一：查「昨天为什么失败」比复制一份流程常用得多，
                而在此之前它根本没有入口 —— 只能连库或者手搓 curl */}
            <button className="menu__item" onClick={() => { setMenu(false); onHistory() }}>
              运行记录
            </button>
            <i className="menu__sep" />
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
