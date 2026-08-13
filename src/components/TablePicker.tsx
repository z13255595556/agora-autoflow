import { useEffect, useMemo, useState } from 'react'
import { upstreamColumns } from '../lib/vars'
import { useFlow } from '../store'

/**
 * 选列器：选上游节点 + 勾列，生成 {{ $.nodes.nX.output.rows | table(列…) }}。
 *
 * 结构照抄 PlaceholderEditor —— 行由数据推导，不让用户手敲。用户不需要知道
 * 节点 id 叫什么、路径怎么拼、过滤器叫什么，那些是手敲最容易错的地方
 * （敲错列名会静默渲染成空单元格，敲错过滤器名以前会让整条运行变僵尸）。
 *
 * 列名来自每次成功运行自动学到的真实列（store.withLearnedColumns），
 * 所以「先跑一次」是前提，空态里说清楚。
 */
export default function TablePicker({
  nodeId,
  msgtype,
  hasContent,
  onInsert,
}: {
  nodeId: string
  msgtype: string
  /** 内容框是不是已经写了东西。空的时候把入口做成醒目的召唤按钮 */
  hasContent: boolean
  onInsert: (snippet: string) => void
}) {
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const updateNodeParam = useFlow((s) => s.updateNodeParam)
  const probeNode = useFlow((s) => s.probeNode)
  const probing = useFlow((s) => s.probing)

  const [open, setOpen] = useState(false)
  const sources = useMemo(() => upstreamColumns(nodeId, nodes, edges), [nodeId, nodes, edges])
  const [sourceId, setSourceId] = useState<string>('')
  const [picked, setPicked] = useState<string[]>([])
  const [filter, setFilter] = useState('')

  const source = sources.find((s) => s.nodeId === sourceId) ?? sources[0] ?? null

  // 换数据源时的默认勾选。
  //
  // 列少就全选（多数人就是想把整张表发出去），列多就一个都不选 ——
  // SELECT * 一把能拿回一百多列，默认全选会生成一张没法看、必然超字节
  // 上限的表，用户还得一个个取消。
  const AUTO_SELECT_MAX = 8
  useEffect(() => {
    if (!source) return
    setSourceId(source.nodeId)
    setPicked(source.columns.length <= AUTO_SELECT_MAX ? source.columns.map((c) => c.name) : [])
    setFilter('')
  }, [source?.nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 没跑过的上游节点：给个能直接点的探测入口，不要只说"去跑一次"
  const probeable = useMemo(
    () =>
      nodes.filter(
        (n) =>
          n.id !== nodeId &&
          !sources.some((s) => s.nodeId === n.id) &&
          edges.some((e) => e.source === n.id),
      ),
    [nodes, edges, nodeId, sources],
  )

  if (!open) {
    // 内容还空着、上游又已经有列可选 —— 这时候"插入表格"几乎一定是用户
    // 想干的事，做成整条醒目的召唤按钮，而不是一个不起眼的小链接
    const isCallToAction = !hasContent && sources.length > 0
    return (
      <button
        className={`tpick__cta${isCallToAction ? ' tpick__cta--hero' : ''}`}
        onClick={() => setOpen(true)}
      >
        <span className="tpick__cta-icon">▦</span>
        <span className="tpick__cta-text">
          <b>插入表格</b>
          <em>
            {isCallToAction
              ? `把 ${sources[0].label} 的查询结果作为表格放进消息 —— 不用手写表达式`
              : '选上游节点和列，自动生成表格表达式'}
          </em>
        </span>
      </button>
    )
  }

  if (!source) {
    return (
      <div className="tpick">
        <div className="tpick__head">
          插入表格
          <button className="tpick__x" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="tpick__empty">
          还不知道上游有哪些列。<b>运行一次流程</b>就会自动学到真实列名，这里就能勾选了。
          {probeable.length > 0 && (
            <div className="tpick__probes">
              不想跑全量的话，也可以只跑一行探列名：
              {probeable.map((n) => (
                <button
                  key={n.id}
                  className="btn btn--sm"
                  disabled={probing === n.id}
                  onClick={() => void probeNode(n.id)}
                >
                  {probing === n.id ? '探测中…' : `探测 ${n.data.label}`}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const toggle = (name: string) =>
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]))

  const kw = filter.trim().toLowerCase()
  const shown = kw ? source.columns.filter((c) => c.name.toLowerCase().includes(kw)) : source.columns
  // 列的顺序按用户勾选的先后走 —— 勾选顺序就是表格里的列顺序，符合直觉
  const snippet = `{{ $.nodes.${source.nodeId}.output.${source.container} | table(${picked.join(', ')}) }}`

  return (
    <div className="tpick">
      <div className="tpick__head">
        插入表格
        <button className="tpick__x" onClick={() => setOpen(false)}>×</button>
      </div>

      {sources.length > 1 && (
        <label className="tpick__row">
          <span>数据来自</span>
          <select value={source.nodeId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.nodeId} value={s.nodeId}>
                {s.label} · {s.columns.length} 列
              </option>
            ))}
          </select>
        </label>
      )}

      {/* SELECT * 能拿回一百多列，没有搜索框就只能靠滚 */}
      {source.columns.length > AUTO_SELECT_MAX && (
        <input
          className="tpick__filter"
          value={filter}
          placeholder={`在 ${source.columns.length} 个列名里搜…`}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      <div className="tpick__cols">
        {shown.map((c) => (
          <label key={c.name} className={`tpick__col${picked.includes(c.name) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={picked.includes(c.name)} onChange={() => toggle(c.name)} />
            <code>{c.name}</code>
            {c.type && <em>{c.type}</em>}
          </label>
        ))}
        {shown.length === 0 && <div className="tpick__empty">没有匹配的列名</div>}
      </div>

      <div className="tpick__actions">
        <button className="btn btn--sm" onClick={() => setPicked(shown.map((c) => c.name))}>
          {filter ? `选中筛出的 ${shown.length} 个` : '全选'}
        </button>
        <button className="btn btn--sm" onClick={() => setPicked([])}>清空</button>
        <button
          className="btn btn--primary btn--sm"
          disabled={picked.length === 0}
          onClick={() => {
            onInsert(snippet)
            setOpen(false)
          }}
        >
          插入 {picked.length} 列
        </button>
      </div>

      {msgtype !== 'markdown_v2' && (
        <div className="tpick__warn">
          ⚠ 企微只有 <code>markdown_v2</code> 会把表格渲染成表格，当前是「{msgtype || '未选'}」。
          <button
            className="btn btn--sm"
            onClick={() => updateNodeParam(nodeId, 'msgtype', 'markdown_v2')}
          >
            改成 markdown_v2
          </button>
          {/* 只提示不自动改：markdown_v2 不支持 @成员，服务端会直接拒收，
              静默翻转会打断一个本来能用的 @人 配置 */}
          <div className="tpick__warnsub">注意：markdown_v2 不支持 @成员，已配的 @人会失效。</div>
        </div>
      )}

      <code className="tpick__snippet">{snippet}</code>
    </div>
  )
}
