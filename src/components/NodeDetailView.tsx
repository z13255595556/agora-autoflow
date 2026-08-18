import { useMemo, useState } from 'react'
import { useFlow } from '../store'
import { CATEGORY_COLOR, NODE_TYPE_MAP, portsOf } from '../registry'
import { availableVars } from '../lib/vars'
import { extractRows } from '../lib/output'
import { latestOutput, previewFromRun } from '../lib/engine'
import { redactOutput } from '../lib/secrets'
import SchemaForm from './SchemaForm'
import HttpRequestForm from './HttpRequestForm'
import WebhookPanel from './WebhookPanel'
import { formatDate } from '../lib/datefn'

/**
 * 节点详情视图（对齐 n8n NDV）：输入 | 参数 | 输出 三栏。
 * 输出栏带 表格/JSON 切换、循环多次执行的运行选择器、固定输出（pin）、单节点试运行。
 */
export default function NodeDetailView() {
  const ndvNodeId = useFlow((s) => s.ndvNodeId)
  const openNdv = useFlow((s) => s.openNdv)
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const running = useFlow((s) => s.running)
  const pinData = useFlow((s) => s.pinData)
  const pinNode = useFlow((s) => s.pinNode)
  const unpinNode = useFlow((s) => s.unpinNode)
  const testStep = useFlow((s) => s.testStep)
  const updateNodeParam = useFlow((s) => s.updateNodeParam)
  const dirtyNodes = useFlow((s) => s.dirtyNodes)

  const [outMode, setOutMode] = useState<'table' | 'json'>('table')
  const [iterIdx, setIterIdx] = useState<number | null>(null)
  const [editingPin, setEditingPin] = useState<string | null>(null)

  const node = nodes.find((n) => n.id === ndvNodeId)
  const t = node ? NODE_TYPE_MAP.get(node.data.typeId) : undefined
  const run = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null

  const vars = useMemo(
    () => (node ? availableVars(node.id, nodes, edges, flowInputs) : []),
    [node, nodes, edges, flowInputs],
  )

  if (!node || !t) return null

  const steps = run?.steps[node.id] ?? []
  const stepIdx = iterIdx !== null && iterIdx < steps.length ? iterIdx : steps.length - 1
  const step = steps[stepIdx]
  const isPinned = Object.prototype.hasOwnProperty.call(pinData, node.id)
  // n8n 语义：pinned 数据是输出栏的当前真相
  // 脱敏只作用于**看**：引用解析拿到的仍是真值，运行时该发什么还发什么。
  // 以前 HTTP 响应头里的 set-cookie / authorization 是明文摆在这一栏的。
  const shownOutput = redactOutput(node.data.typeId, isPinned ? pinData[node.id] : step?.output)
  const color = CATEGORY_COLOR[t.category] ?? '#64748b'
  // n8n canPinNode：恰好一个 main 输出才能 pin（If/Switch/foreach/终点节点都不行）
  const canPin = portsOf(t).length === 1
  const isDirty = Boolean(dirtyNodes[node.id])

  // n8n：对 pinned 节点执行 Test step 会覆盖固定数据 → 先弹确认（Unpin and test）
  const onTestStep = () => {
    if (isPinned) {
      if (!confirm('该节点输出已固定。试运行会取消固定并真正执行，继续？')) return
      unpinNode(node.id)
    }
    void testStep(node.id)
  }

  const upstream = edges
    .filter((e) => e.target === node.id)
    .map((e) => ({ edge: e, node: nodes.find((n) => n.id === e.source) }))
    .filter((x) => x.node)

  const startPinEdit = () =>
    setEditingPin(JSON.stringify(isPinned ? pinData[node.id] : (step?.output ?? {}), null, 2))

  const savePinEdit = () => {
    if (editingPin === null) return
    try {
      pinNode(node.id, JSON.parse(editingPin))
      setEditingPin(null)
    } catch {
      alert('不是合法的 JSON')
    }
  }

  return (
    <div className="ndv__mask" onClick={() => openNdv(null)}>
      <div className="ndv" onClick={(e) => e.stopPropagation()}>
        <div className="ndv__head">
          <span className="ins__icon" style={{ background: color }}>{t.icon}</span>
          <span className="ndv__title">{node.data.label}</span>
          <code className="ndv__type">{node.id} · {t.type}</code>
          {isPinned && <span className="pinbadge" title="输出已固定，运行时不会真正执行">📌 已固定</span>}
          <button
            className="btn"
            disabled={running}
            title="执行这个节点。上游数据用最近一次运行的输出（固定数据优先）"
            onClick={onTestStep}
          >
            {running ? '运行中…' : '▶ 试运行本节点'}
          </button>
          <button className="btn" onClick={() => openNdv(null)}>关闭</button>
        </div>

        <div className="ndv__cols">
          {/* -------- 输入 -------- */}
          <section className="ndv__col ndv__col--input">
            <div className="ndv__coltitle">输入</div>
            <div className="ndv__colbody">
              <div className="ndv__sec">解析后入参 <em>服务实际收到的</em></div>
              {step ? (
                <pre className="mono ndv__json">{JSON.stringify(step.input, null, 2)}</pre>
              ) : (
                <div className="empty">还没运行过。运行整条流程，或点上方「试运行本节点」。</div>
              )}
              <div className="ndv__sec">上游输出</div>
              {upstream.length === 0 && <div className="empty">没有上游节点</div>}
              {upstream.map(({ edge, node: up }) => {
                const upPinned = Object.prototype.hasOwnProperty.call(pinData, up!.id)
                const upOut = redactOutput(up!.data.typeId, latestOutput(run, pinData, up!.id))
                return (
                  <details key={edge.id} className="ndv__upstream">
                    <summary>
                      {up!.data.label} <code>{up!.id}</code>
                      {upPinned && ' 📌'}
                    </summary>
                    {/* 上游输出也按表格渲染 —— 用户正是在这里判断"我该引用什么" */}
                    {upOut !== undefined ? (
                      <OutputTable output={upOut} nodeId={up!.id} />
                    ) : (
                      <div className="empty">（无数据，上游还没跑过）</div>
                    )}
                  </details>
                )
              })}
            </div>
          </section>

          {/* -------- 参数 -------- */}
          <section className="ndv__col ndv__col--params">
            <div className="ndv__coltitle">参数</div>
            <div className="ndv__colbody">
              {t.type === 'trigger.webhook' && <WebhookPanel nodeParams={node.data.params} />}
              {t.type === 'http.request' ? (
                <HttpRequestForm
                  schema={t.input}
                  values={node.data.params}
                  required={t.input.required ?? []}
                  vars={vars}
                  onChange={(k, v) => updateNodeParam(node.id, k, v)}
                  previewRef={previewFromRun(run, pinData)}
                  nodeId={node.id}
                />
              ) : (
                <SchemaForm
                  schema={t.input}
                  values={node.data.params}
                  required={t.input.required ?? []}
                  vars={vars}
                  onChange={(k, v) => updateNodeParam(node.id, k, v)}
                  previewRef={previewFromRun(run, pinData)}
                  nodeId={node.id}
                />
              )}
            </div>
          </section>

          {/* -------- 输出 -------- */}
          <section className="ndv__col ndv__col--output">
            <div className="ndv__coltitle">
              输出
              {steps.length > 1 && (
                <select
                  className="ndv__runsel"
                  value={stepIdx}
                  onChange={(e) => setIterIdx(Number(e.target.value))}
                >
                  {steps.map((s, i) => (
                    <option key={i} value={i}>
                      第 {(s.iteration ?? i) + 1} 次{s.status === 'error' ? ' ✗' : ''}
                    </option>
                  ))}
                </select>
              )}
              <span className="ndv__tools">
                <button className={outMode === 'table' ? 'on' : ''} onClick={() => setOutMode('table')}>表格</button>
                <button className={outMode === 'json' ? 'on' : ''} onClick={() => setOutMode('json')}>JSON</button>
              </span>
            </div>
            <div className="ndv__colbody">
              {isPinned && (
                <div className="pinnote">
                  这份数据已固定，调试运行不会真正执行该节点。
                  <button onClick={() => unpinNode(node.id)}>取消固定</button>
                </div>
              )}
              {isDirty && !isPinned && (
                <div className="stalenote">参数改过了，下面的输出可能已过期 —— 重新试运行刷新。</div>
              )}
              {step?.status === 'error' && <div className="errors">✗ {step.error}</div>}

              {editingPin !== null ? (
                <div className="pinedit">
                  <textarea
                    className="mono"
                    rows={14}
                    value={editingPin}
                    onChange={(e) => setEditingPin(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="pinedit__actions">
                    <button className="btn btn--primary" onClick={savePinEdit}>保存为固定输出</button>
                    <button className="btn" onClick={() => setEditingPin(null)}>取消</button>
                  </div>
                </div>
              ) : shownOutput !== undefined && shownOutput !== null ? (
                outMode === 'table' ? (
                  <OutputTable output={shownOutput} nodeId={node.id} />
                ) : (
                  <pre className="mono ndv__json">{JSON.stringify(shownOutput, null, 2)}</pre>
                )
              ) : (
                <div className="empty">还没有输出数据</div>
              )}

              <div className="ndv__pinbar">
                {!canPin ? (
                  <span className="ndv__meta" title="对齐 n8n：只有恰好一个输出口的节点才能固定输出">
                    多出口/无出口节点不支持固定输出
                  </span>
                ) : isPinned ? (
                  <>
                    <button className="btn" onClick={startPinEdit}>编辑固定数据</button>
                    <button className="btn" onClick={() => unpinNode(node.id)}>取消固定</button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn"
                      title="固定后，调试运行直接用这份数据，不再真正执行该节点（生产触发不受影响）"
                      onClick={() => (step?.output !== undefined && step?.output !== null ? pinNode(node.id, step.output) : startPinEdit())}
                    >
                      📌 固定输出
                    </button>
                    <button className="btn" onClick={startPinEdit}>手写固定数据</button>
                  </>
                )}
                {step && (
                  <span className="ndv__meta">
                    {step.durationMs}ms · {formatDate(new Date(step.startedAt), 'time')}
                    {step.pinned && ' · 来自固定数据'}
                  </span>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

/** 单元格里塞不下的长文本：渲染后的 SQL、企微消息预览这类 */
const MAX_INLINE = 60
const isLongText = (v: unknown) => typeof v === 'string' && (v.length > MAX_INLINE || v.includes('\n'))

/** 表格视图：找到输出里第一批行渲染成表；否则渲染键值对 */
function OutputTable({ output, nodeId }: { output: unknown; nodeId: string }) {
  const found = extractRows(output)
  const o = output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>) : null

  if (!found) {
    if (o) return <Fields obj={o} />
    return <pre className="mono ndv__json">{JSON.stringify(output)}</pre>
  }

  // columns 已经由表头和「已学到的列」承载了，别再在其他字段里堆一坨 JSON
  const rest = o ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== found.key && k !== 'columns')) : {}

  return (
    <>
      <ResultBanner output={o} rows={found.rows} />
      <RowsTable rows={found.rows} nodeId={nodeId} container={found.key} />
      {Object.keys(rest).length > 0 && (
        <>
          <div className="ndv__sec">其他字段</div>
          <Fields obj={rest} />
        </>
      )}
    </>
  )
}

/**
 * 拿回来多少行、是不是被砍过。
 *
 * truncated 以前只是「其他字段」里一个匿名行，用户根本不知道结果被砍过 ——
 * 然后照着写 `共 {{ rowCount }} 条` 发进群，播出去一个错数。
 *
 * 平台侧是把 SQL 包一层 LIMIT 执行的，所以**真实匹配总数拿不到**，
 * 除非再发一个 COUNT 任务。这里只说实话，不编总数。
 */
function ResultBanner({ output, rows }: { output: Record<string, unknown> | null; rows: unknown[] }) {
  const rowCount = typeof output?.rowCount === 'number' ? output.rowCount : rows.length
  const truncated = output?.truncated === true
  if (!truncated) return <div className="ndv__sec">返回 {rowCount} 行</div>
  return (
    <div className="trunc">
      ⚠ 只取回前 <b>{rowCount}</b> 行 —— 已达「行数上限」，这不是全部匹配结果。
      下游节点和消息里拿到的就是这 {rowCount} 行；要全量请调大上限或收窄查询条件。
    </div>
  )
}

/** 一屏之内渲染得完的行数上限。真要看全量请用 JSON 视图或调小 limit。 */
const MAX_RENDER_ROWS = 200

/**
 * 结果表格。这里同时是**取值的入口**：表上的每一格、每个列名都能点，点了就
 * 得到能直接粘进任何字段的表达式。
 *
 * "我只想要这一列里的这一个值" 是最常见的诉求，也是最没法凭空写出来的 ——
 * 得同时知道节点 id、容器字段叫 rows、下标写在方括号里、外面还要包 {{ }}。
 * 这四件事没有一件能从界面上看出来。数据本来就已经画在屏幕上了，让用户
 * 指着它说"要这个"，比让他们把路径拼出来可靠得多。
 *
 * 复制之后把表达式**原文显示出来**，不只是提示"已复制" —— 看几次就学会了
 * 下标和过滤器的写法，下次可以直接手写。
 */
function RowsTable({ rows, nodeId, container }: { rows: unknown[]; nodeId: string; container: string }) {
  const [copied, setCopied] = useState<string | null>(null)
  const cols = [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))]
  if (!cols.length) return <pre className="mono ndv__json">{JSON.stringify(rows, null, 2)}</pre>

  // 不做定时消失：它不是"操作成功"的提示，是「你刚取的是这个」的常驻说明 ——
  // 用户点完这一格，视线要移到中间那栏去粘贴，回头往往还想再确认一眼。
  const copy = (text: string) => {
    // 剪贴板可能被浏览器策略拒（非安全上下文、无权限）——那也要照常显示下面
    // 那条表达式，用户至少能手抄。未捕获的 rejection 只会脏控制台。
    void navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(text)
  }
  const ref = `$.nodes.${nodeId}.output.${container || 'rows'}`
  const shown = rows.slice(0, MAX_RENDER_ROWS)
  // 整批行只有喂给 foreach / 过滤器时才有意义，单独一条路径粘进消息里是一坨
  // JSON。所以三个入口给的是三种**成品**，不是三段路径。
  const cellExpr = (i: number, c: string) => `{{ ${ref}[${i}].${c} }}`
  const colExpr = (c: string) => `{{ ${ref} | lines(${c}) }}`

  return (
    <>
      <div className="ndv__copybar">
        <button
          className="btn btn--sm"
          onClick={() => copy(`{{ ${ref} }}`)}
          title="整批行。适合喂给「循环」节点，或接 | table(列…) 变成表格"
        >
          复制整批行
        </button>
        <span className="ndv__meta">点单元格取这一个值 · 点列名取整列</span>
      </div>
      {copied && (
        <div className="ndv__copied">
          已复制 <code>{copied}</code> —— 粘到消息内容、SQL 或任何输入框里
        </div>
      )}
      <div className="ndv__tablewrap">
        <table className="ndv__table ndv__table--pick">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>
                  <button className="colcopy" onClick={() => copy(colExpr(c))} title={`复制整列：${colExpr(c)}`}>
                    {c}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => {
                  const v = (r as Record<string, unknown>)?.[c]
                  return (
                    <td key={c}>
                      <button
                        className={`cellcopy${copied === cellExpr(i, c) ? ' is-copied' : ''}`}
                        onClick={() => copy(cellExpr(i, c))}
                        title={`复制这一格：${cellExpr(i, c)}`}
                      >
                        {v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <div className="ndv__meta">
          只渲染了前 {shown.length} 行，还有 {rows.length - shown.length} 行未显示（数据本身是完整的，切到 JSON 视图可看全）
        </div>
      )}
    </>
  )
}

/**
 * 键值对，长文本单独展开。
 *
 * 表格单元格是 nowrap + max-width:220px + 省略号的，渲染后的 SQL 和企微
 * 消息预览落进去只剩一行省略号 —— 「看不到输出内容」有一半是这条 CSS 造成的。
 */
function Fields({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj)
  const short = entries.filter(([, v]) => !isLongText(v))
  const long = entries.filter(([, v]) => isLongText(v))
  return (
    <>
      {short.length > 0 && (
        <div className="ndv__tablewrap">
          <table className="ndv__table">
            <tbody>
              {short.map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {long.map(([k, v]) => (
        <details key={k} className="ndv__longtext" open={k === 'preview'}>
          <summary>{k}</summary>
          <pre className="mono prewrap">{String(v)}</pre>
        </details>
      ))}
    </>
  )
}
