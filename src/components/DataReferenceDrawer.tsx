import { useEffect, useMemo, useState } from 'react'
import { useFlow } from '../store'
import { availableVars, upstreamNodes } from '../lib/vars'
import {
  describeOutput, flattenShape, type JsonType, type OutputShape, type RegionDesc,
} from '../lib/outputShape'
import {
  compileReferenceSelection, selectionDisplayLabel,
  type MatchOperator, type ReferenceSelection,
} from '../lib/referenceSelection'
import { previewText } from '../lib/refLabel'
import type { ReferenceTarget } from './ReferencePickerContext'
import Icon from './Icon'

interface Props {
  request: ReferenceTarget | null
  onClose: () => void
}

type Candidate = { selection: ReferenceSelection; sample?: unknown; known: boolean; stale?: boolean }

const TYPE_LABEL: Record<JsonType, string> = {
  string: '文本', integer: '整数', number: '数字', boolean: '是/否', object: '对象', array: '列表', unknown: '未知',
}

const MATCH_LABEL: Record<MatchOperator, string> = {
  eq: '等于', neq: '不等于', contains: '包含', gt: '大于', lt: '小于',
}

export default function DataReferenceDrawer({ request, onClose }: Props) {
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const pinData = useFlow((s) => s.pinData)
  const dirtyNodes = useFlow((s) => s.dirtyNodes)
  const running = useFlow((s) => s.running)
  const backend = useFlow((s) => s.backend)
  const testStep = useFlow((s) => s.testStep)
  useFlow((s) => s.registryVersion)

  const [sourceId, setSourceId] = useState<string | null>(null)
  const [regionPath, setRegionPath] = useState('')
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [query, setQuery] = useState('')
  const [testError, setTestError] = useState<string | null>(null)

  const run = runs.find((item) => item.id === activeRunId) ?? runs[0] ?? null
  const sources = useMemo(() => {
    if (!request) return []
    return upstreamNodes(request.nodeId, nodes, edges)
      .map((node) => ({
        node,
        shape: describeOutput(node, { run, pinData, nodes, edges }),
      }))
      .filter(({ shape }) => !shape.hidden)
  }, [request, nodes, edges, run, pinData])

  const quickVars = useMemo(() => {
    if (!request) return []
    return availableVars(request.nodeId, nodes, edges, flowInputs)
      .filter((item) => !item.path.startsWith('$.nodes.'))
  }, [request, nodes, edges, flowInputs])

  useEffect(() => {
    if (!request) return
    setQuery(request.query)
    const existing = request.initialExpression?.match(/\$\.nodes\.([^.]+)\.output(?:\.([^\s|}]+))?/)
    setSourceId(existing?.[1] ?? null)
    const path = existing?.[2] ?? ''
    setRegionPath(path.includes('[') ? path.slice(0, path.indexOf('[')) : parentPath(path))
    setCandidate(null)
    setTestError(null)
  }, [request?.nodeId, request?.initialExpression]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (request) setQuery(request.query)
  }, [request?.query]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = sources.find((item) => item.node.id === sourceId) ?? null
  const region = selected ? findRegion(selected.shape.root, regionPath) : null
  const keyword = query.trim().toLowerCase()
  const hits = keyword
    ? sources.flatMap(({ shape }) => flattenShape(shape)
        .filter((item) => `${shape.nodeLabel} ${item.label} ${item.fullLabel} ${item.path}`.toLowerCase().includes(keyword))
        .map((item) => ({ shape, item, stale: Boolean(dirtyNodes[shape.nodeId]) })))
    : []
  const quickHits = keyword
    ? quickVars.filter((item) => `${item.label} ${item.group} ${item.path}`.toLowerCase().includes(keyword))
    : quickVars

  const requestHasMatches = !keyword || quickHits.length > 0 || hits.length > 0
  useEffect(() => {
    if (request && request.query.trim() && !requestHasMatches) onClose()
  }, [request, requestHasMatches, onClose])

  if (!request) return null

  const choose = (next: Candidate) => setCandidate(next)
  const insert = () => {
    if (!candidate || incompatible(request, candidate.selection.valueType)) return
    request.replace(compileReferenceSelection(candidate.selection))
    onClose()
  }

  const runSource = async (shape: OutputShape) => {
    const source = sources.find((item) => item.shape.nodeId === shape.nodeId)?.node
    if (!source) return
    if (source.data.typeId === 'http.request') {
      const method = String(source.data.params.method ?? 'GET').toUpperCase()
      const url = String(source.data.params.url ?? '')
      if (method !== 'GET' && !window.confirm(`将真实发送 ${method} 请求：\n${url}\n\n该请求可能写入数据或触发通知，确认继续？`)) return
    }
    setTestError(null)
    await testStep(source.id)
    const latest = useFlow.getState().runs.find((item) => item.id === useFlow.getState().activeRunId) ?? useFlow.getState().runs[0]
    const step = latest?.steps[source.id]?.at(-1)
    if (step?.status === 'error') setTestError(step.error ?? '试运行失败')
  }

  return (
    <aside className="dataref" aria-label="选择数据">
      <header className="dataref__head">
        <div>
          <strong>选择数据</strong>
          <span>{sourceId ? selected?.shape.nodeLabel : '从上游节点中取值'}</span>
        </div>
        <button className="iconbtn" title="关闭" onClick={onClose}><Icon name="close" /></button>
      </header>

      <div className="dataref__search">
        <input value={query} onChange={(event) => {
          const next = event.target.value
          setQuery(next)
          const kw = next.trim().toLowerCase()
          if (!kw) return
          const hasQuick = quickVars.some((item) => `${item.label} ${item.group} ${item.path}`.toLowerCase().includes(kw))
          const hasField = sources.some(({ shape }) => flattenShape(shape).some((item) => `${shape.nodeLabel} ${item.label} ${item.fullLabel} ${item.path}`.toLowerCase().includes(kw)))
          if (!hasQuick && !hasField) onClose()
        }} placeholder="搜索节点或字段" />
      </div>

      <div className="dataref__body">
        {keyword ? (
          <SearchResults
            hits={hits}
            quick={quickHits}
            onChoose={choose}
            onQuick={(path, label, type) => choose({
              selection: { sourceNodeId: '', sourceLabel: '', path, mode: 'field', valueType: type, label },
              known: false,
            })}
          />
        ) : selected && region ? (
          <RegionView
            shape={selected.shape}
            region={region}
            dirty={Boolean(dirtyNodes[selected.node.id])}
            running={running}
            backendOnline={Boolean(backend?.ok)}
            onBack={() => {
              if (!region.path) setSourceId(null)
              else setRegionPath(parentPath(region.path))
              setCandidate(null)
            }}
            onRegion={(path) => { setRegionPath(path); setCandidate(null) }}
            onChoose={(next) => choose(dirtyNodes[selected.node.id]
              ? { ...next, known: false, stale: true }
              : next)}
            onRun={() => void runSource(selected.shape)}
            testError={testError}
          />
        ) : (
          <SourceList
            sources={sources}
            quick={quickHits}
            dirtyNodes={dirtyNodes}
            onSource={(id) => { setSourceId(id); setRegionPath(''); setCandidate(null) }}
            onQuick={(path, label, type) => choose({
              selection: { sourceNodeId: '', sourceLabel: '', path, mode: 'field', valueType: type, label },
              known: false,
            })}
          />
        )}
      </div>

      {candidate && (
        <footer className="dataref__preview">
          <div className="dataref__preview-main">
            <span>将插入</span>
            <strong>{selectionDisplayLabel(candidate.selection) || candidate.selection.label}</strong>
            <em>{candidate.stale ? '样例已过期' : candidate.known ? previewText(candidate.sample) : '暂无真实样例'}</em>
          </div>
          {incompatible(request, candidate.selection.valueType) && (
            <div className="dataref__compat">对象或列表不能直接混在文字中，请改选具体字段或格式化结果。</div>
          )}
          <button className="btn btn--primary" disabled={incompatible(request, candidate.selection.valueType)} onClick={insert}>
            插入变量
          </button>
        </footer>
      )}
    </aside>
  )
}

function SourceList({ sources, quick, dirtyNodes, onSource, onQuick }: {
  sources: Array<{ node: { id: string; data: { label: string; typeId: string } }; shape: OutputShape }>
  quick: Array<{ path: string; label: string; type: string; group: string }>
  dirtyNodes: Record<string, true>
  onSource: (id: string) => void
  onQuick: (path: string, label: string, type: JsonType) => void
}) {
  const [datesOpen, setDatesOpen] = useState(false)
  const regularQuick = quick.filter((item) => item.group !== '日期函数')
  const dateQuick = quick.filter((item) => item.group === '日期函数')
  const quickRow = (item: typeof quick[number]) => (
    <button className="dataref__row" key={item.path} onClick={() => onQuick(item.path, item.label, asJsonType(item.type))}>
      <span><strong>{item.label}</strong><small>{item.group}</small></span><em>{item.type}</em>
    </button>
  )
  return (
    <>
      {quick.length > 0 && (
        <section className="dataref__section">
          <h3>流程数据</h3>
          {regularQuick.map(quickRow)}
          {dateQuick.length > 0 && (
            <>
              <button className="dataref__fold" aria-expanded={datesOpen} onClick={() => setDatesOpen((open) => !open)}>
                <span><strong>时间函数</strong><small>{dateQuick.length} 个可用值</small></span>
                <b>{datesOpen ? '−' : '+'}</b>
              </button>
              {datesOpen && dateQuick.map(quickRow)}
            </>
          )}
        </section>
      )}
      <section className="dataref__section">
        <h3>上游节点</h3>
        {sources.map(({ node, shape }) => (
          <button className="dataref__source" key={node.id} onClick={() => onSource(node.id)}>
            <span className="dataref__source-icon">{node.data.typeId === 'sql.query' ? 'SQL' : node.data.typeId === 'http.request' ? 'HTTP' : 'OUT'}</span>
            <span><strong>{node.data.label}</strong><small>{sourceCaption(shape, Boolean(dirtyNodes[node.id]))}</small></span>
            <b>›</b>
          </button>
        ))}
        {sources.length === 0 && <div className="dataref__empty">当前节点还没有可引用的上游数据</div>}
      </section>
    </>
  )
}

function SearchResults({ hits, quick, onChoose, onQuick }: {
  hits: Array<{ shape: OutputShape; item: ReturnType<typeof flattenShape>[number]; stale: boolean }>
  quick: Array<{ path: string; label: string; type: string; group: string }>
  onChoose: (candidate: Candidate) => void
  onQuick: (path: string, label: string, type: JsonType) => void
}) {
  return (
    <section className="dataref__section">
      <h3>搜索结果</h3>
      {quick.map((item) => (
        <button className="dataref__row" key={item.path} onClick={() => onQuick(item.path, item.label, asJsonType(item.type))}>
          <span><strong>{item.label}</strong><small>{item.group}</small></span><em>{item.type}</em>
        </button>
      ))}
      {hits.map(({ shape, item, stale }) => (
        <button className="dataref__row" key={`${shape.nodeId}:${item.path}`} onClick={() => onChoose({
          selection: {
            sourceNodeId: shape.nodeId, sourceLabel: shape.nodeLabel, path: item.path,
            mode: 'field', valueType: item.valueType, label: item.fullLabel,
          },
          sample: stale ? undefined : item.sample, known: item.known && !stale, stale,
        })}>
          <span><strong>{item.label}</strong><small>{shape.nodeLabel} · {item.fullLabel}</small></span>
          <em>{stale ? '已过期' : item.known ? previewText(item.sample) : TYPE_LABEL[item.valueType]}</em>
        </button>
      ))}
      {quick.length === 0 && hits.length === 0 && <div className="dataref__empty">没有匹配的数据</div>}
    </section>
  )
}

function RegionView({ shape, region, dirty, running, backendOnline, onBack, onRegion, onChoose, onRun, testError }: {
  shape: OutputShape
  region: RegionDesc
  dirty: boolean
  running: boolean
  backendOnline: boolean
  onBack: () => void
  onRegion: (path: string) => void
  onChoose: (candidate: Candidate) => void
  onRun: () => void
  testError: string | null
}) {
  return (
    <>
      <button className="dataref__back" onClick={onBack}>‹ {region.path ? '返回上一层' : '返回节点列表'}</button>
      <div className="dataref__crumb">{shape.nodeLabel}{region.path ? ` / ${region.label}` : ''}</div>
      {(shape.unknown || shape.source === 'schema' || dirty) && (
        <div className="dataref__runbox">
          <strong>{dirty ? '参数已修改，预览已过期' : '还没有真实运行结果'}</strong>
          <span>{shape.unknown ? '试运行后才能看到实际字段和值。' : '当前只能看到声明或已学习的字段结构。'}</span>
          {(shape.typeId === 'sql.query' || shape.typeId === 'http.request') && (
            <button className="btn btn--primary" disabled={running || !backendOnline} onClick={onRun}>{running ? '运行中…' : backendOnline ? '试运行并获取数据' : '节点服务未连接'}</button>
          )}
          {testError && <div className="dataref__error">{testError}</div>}
        </div>
      )}
      {shape.source === 'run' && !dirty && <div className={`dataref__fresh${shape.live === false ? ' is-mock' : ''}`}>{shape.live === false ? '模拟结果' : '实际结果'} · {shape.at ? new Date(shape.at).toLocaleTimeString() : '刚刚'}</div>}

      {region.table ? (
        <TableRegion shape={shape} region={region} onChoose={onChoose} />
      ) : (
        <section className="dataref__section">
          {region.fields.filter((field) => !field.sensitive).map((field) => (
            <button className="dataref__row" key={field.path} onClick={() => {
              if (field.regionPath) onRegion(field.regionPath)
              else onChoose({
                selection: {
                  sourceNodeId: shape.nodeId, sourceLabel: shape.nodeLabel, path: field.path,
                  mode: 'field', valueType: field.valueType, label: field.fullLabel,
                }, sample: field.sample, known: field.known,
              })
            }}>
              <span><strong>{field.label}</strong><small>{TYPE_LABEL[field.valueType]}</small></span>
              <em>{field.known ? previewText(field.sample) : field.regionPath ? '展开 ›' : '暂无样例'}</em>
            </button>
          ))}
          {region.regions.filter((child) => !region.fields.some((field) => field.regionPath === child.path)).map((child) => (
            <button className="dataref__row" key={child.path} onClick={() => onRegion(child.path)}>
              <span><strong>{child.label}</strong><small>{child.kind === 'table' ? '表格' : child.kind === 'array' ? '列表' : '对象'}</small></span><em>展开 ›</em>
            </button>
          ))}
          {region.array && <ArrayRegion shape={shape} region={region} onChoose={onChoose} />}
        </section>
      )}
    </>
  )
}

function TableRegion({ shape, region, onChoose }: { shape: OutputShape; region: RegionDesc; onChoose: (candidate: Candidate) => void }) {
  const table = region.table!
  const [mode, setMode] = useState<'cell' | 'row' | 'column' | 'table' | 'find'>('cell')
  const [rowNumber, setRowNumber] = useState(1)
  const [tableCols, setTableCols] = useState(() => table.columns.slice(0, 8).map((column) => column.name))
  const [matchColumn, setMatchColumn] = useState(table.columns[0]?.name ?? '')
  const [operator, setOperator] = useState<MatchOperator>('eq')
  const [matchValue, setMatchValue] = useState('')
  const [resultColumn, setResultColumn] = useState(table.columns[0]?.name ?? '')
  const base = { sourceNodeId: shape.nodeId, sourceLabel: shape.nodeLabel, path: table.container }
  const chooseCell = (row: number, column: string, sample: unknown) => onChoose({
    selection: { ...base, mode: 'at', index: row, column, valueType: table.columns.find((item) => item.name === column)?.type ?? 'unknown', label: `${column} · 第 ${row + 1} 行` },
    sample, known: table.sampleRows.length > row,
  })

  return (
    <div className="dataref__tablearea">
      <div className="dataref__modes">
        {([['cell', '单个值'], ['row', '整行'], ['column', '整列'], ['table', '表格'], ['find', '按条件']] as const).map(([id, label]) => (
          <button className={mode === id ? 'is-on' : ''} key={id} onClick={() => setMode(id)}>{label}</button>
        ))}
      </div>

      {(mode === 'cell' || mode === 'row') && (
        <div className="dataref__nth">
          <label>指定行 <input type="number" min={1} max={table.rowCount || undefined} value={rowNumber} onChange={(e) => setRowNumber(Math.max(1, Number(e.target.value) || 1))} /></label>
          {mode === 'cell' ? <span>点击下方单元格或列名</span> : (
            <button className="btn btn--sm" onClick={() => onChoose({
              selection: { ...base, mode: 'at', index: rowNumber - 1, valueType: 'object', label: `第 ${rowNumber} 行` },
              sample: table.sampleRows[rowNumber - 1], known: table.sampleRows.length >= rowNumber,
            })}>选择第 {rowNumber} 行</button>
          )}
        </div>
      )}
      {mode === 'find' && (
        <div className="dataref__find">
          <select value={matchColumn} onChange={(e) => setMatchColumn(e.target.value)}>{table.columns.map((c) => <option key={c.name}>{c.name}</option>)}</select>
          <select value={operator} onChange={(e) => setOperator(e.target.value as MatchOperator)}>
            {(operatorsFor(table.columns.find((c) => c.name === matchColumn)?.type ?? 'string')).map((op) => <option key={op} value={op}>{MATCH_LABEL[op]}</option>)}
          </select>
          <input value={matchValue} onChange={(e) => setMatchValue(e.target.value)} placeholder="匹配值" />
          <select value={resultColumn} onChange={(e) => setResultColumn(e.target.value)}><option value="">返回整行</option>{table.columns.map((c) => <option key={c.name}>{c.name}</option>)}</select>
          <button className="btn btn--primary btn--sm" disabled={!matchColumn || !matchValue} onClick={() => {
            const typed = typedValue(matchValue, table.columns.find((c) => c.name === matchColumn)?.type ?? 'string')
            const row = table.sampleRows.find((item) => match(item?.[matchColumn], operator, typed))
            onChoose({
              selection: { ...base, mode: 'find', matchColumn, operator, matchValue: typed, resultColumn: resultColumn || undefined, valueType: resultColumn ? (table.columns.find((c) => c.name === resultColumn)?.type ?? 'unknown') : 'object', label: `${resultColumn || '整行'} · ${matchColumn}${MATCH_LABEL[operator]}${matchValue}` },
              sample: resultColumn ? row?.[resultColumn] : row, known: Boolean(row),
            })
          }}>预览匹配</button>
        </div>
      )}
      {table.orderUnstable && (mode === 'cell' || mode === 'row') && <div className="dataref__warning">SQL 没有 ORDER BY，按行号取值的结果顺序可能变化。</div>}
      {table.truncated && mode === 'row' && <div className="dataref__warning">结果已截断，“最后一行”只是已取回结果的最后一行。</div>}

      <div className="dataref__tablewrap">
        <table className="dataref__table">
          <thead><tr><th>#</th>{table.columns.map((column) => (
            <th key={column.name}>
              {mode === 'table' && <input type="checkbox" checked={tableCols.includes(column.name)} onChange={() => setTableCols((cols) => cols.includes(column.name) ? cols.filter((c) => c !== column.name) : [...cols, column.name])} />}
              <button onClick={() => {
                if (mode === 'column') onChoose({ selection: { ...base, mode: 'column', column: column.name, valueType: 'array', label: `${column.name} · 整列` }, sample: table.sampleRows.map((row) => row[column.name]), known: table.sampleRows.length > 0 })
                else if (mode === 'cell') chooseCell(rowNumber - 1, column.name, table.sampleRows[rowNumber - 1]?.[column.name])
              }}>{column.label}</button>
            </th>
          ))}</tr></thead>
          <tbody>{table.sampleRows.map((row, index) => (
            <tr key={index}><th><button onClick={() => mode === 'row' && onChoose({ selection: { ...base, mode: 'at', index, valueType: 'object', label: `第 ${index + 1} 行` }, sample: row, known: true })}>{index + 1}</button></th>{table.columns.map((column) => (
              <td key={column.name}><button onClick={() => chooseCell(index, column.name, row[column.name])}>{previewText(row[column.name])}</button></td>
            ))}</tr>
          ))}</tbody>
        </table>
        {table.sampleRows.length === 0 && <div className="dataref__empty">已经识别字段，但还没有真实样例行</div>}
      </div>

      <div className="dataref__tableactions">
        {mode === 'row' && <><button onClick={() => onChoose({ selection: { ...base, mode: 'first', valueType: 'object', label: '第一行' }, sample: table.sampleRows[0], known: table.sampleRows.length > 0 })}>第一行</button><button onClick={() => onChoose({ selection: { ...base, mode: 'last', valueType: 'object', label: '最后一行' }, sample: table.sampleRows.at(-1), known: table.sampleRows.length > 0 })}>最后一行</button></>}
        {mode === 'table' && <button className="btn btn--primary btn--sm" disabled={!tableCols.length} onClick={() => onChoose({ selection: { ...base, mode: 'table', columns: tableCols, valueType: 'string', label: `表格 · ${tableCols.length} 列` }, sample: `${table.sampleRows.length} 行`, known: table.sampleRows.length > 0 })}>使用所选列</button>}
        <button onClick={() => onChoose({ selection: { ...base, mode: 'all', valueType: 'array', label: '完整结果' }, sample: table.sampleRows, known: table.sampleRows.length > 0 })}>完整结果</button>
        <button onClick={() => onChoose({ selection: { ...base, mode: 'count', valueType: 'integer', label: '结果数量' }, sample: table.rowCount, known: table.rowCount !== undefined })}>结果数量</button>
      </div>
    </div>
  )
}

function ArrayRegion({ shape, region, onChoose }: { shape: OutputShape; region: RegionDesc; onChoose: (candidate: Candidate) => void }) {
  const array = region.array!
  const base = { sourceNodeId: shape.nodeId, sourceLabel: shape.nodeLabel, path: region.path }
  return (
    <div className="dataref__array">
      {array.sampleItems.map((item, index) => <button key={index} onClick={() => onChoose({ selection: { ...base, mode: 'at', index, valueType: array.itemType, label: `第 ${index + 1} 项` }, sample: item, known: true })}><b>{index + 1}</b><span>{previewText(item)}</span></button>)}
      <div className="dataref__tableactions"><button onClick={() => onChoose({ selection: { ...base, mode: 'all', valueType: 'array', label: '完整列表' }, sample: array.sampleItems, known: array.length !== undefined })}>完整列表</button><button onClick={() => onChoose({ selection: { ...base, mode: 'count', valueType: 'integer', label: '列表数量' }, sample: array.length, known: array.length !== undefined })}>列表数量</button></div>
    </div>
  )
}

function findRegion(root: RegionDesc, path: string): RegionDesc {
  if (!path || root.path === path) return root
  for (const child of root.regions) {
    const found = findRegionOrNull(child, path)
    if (found) return found
  }
  return root
}

function findRegionOrNull(region: RegionDesc, path: string): RegionDesc | null {
  if (region.path === path) return region
  for (const child of region.regions) {
    const found = findRegionOrNull(child, path)
    if (found) return found
  }
  return null
}

const parentPath = (path: string) => path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : ''
const incompatible = (target: ReferenceTarget, type: JsonType) => target.mixed && (type === 'array' || type === 'object')
const asJsonType = (type: string): JsonType => type.endsWith('[]') ? 'array' : ['string', 'integer', 'number', 'boolean', 'object', 'array'].includes(type) ? type as JsonType : 'unknown'
const sourceCaption = (shape: OutputShape, dirty = false) => dirty ? '字段结构可用 · 样例已过期' : shape.source === 'run' ? (shape.live === false ? '已有模拟结果' : '已有真实运行结果') : shape.source === 'pin' ? '使用固定输出' : shape.unknown ? '需要试运行获取数据' : '已有字段结构'
const operatorsFor = (type: JsonType): MatchOperator[] => type === 'integer' || type === 'number' ? ['eq', 'neq', 'gt', 'lt'] : type === 'boolean' ? ['eq'] : ['eq', 'neq', 'contains']
const typedValue = (value: string, type: JsonType): string | number | boolean => type === 'integer' || type === 'number' ? Number(value) : type === 'boolean' ? value === 'true' : value
const match = (actual: unknown, op: MatchOperator, expected: unknown) => op === 'eq' ? actual === expected || String(actual) === String(expected) : op === 'neq' ? !(actual === expected || String(actual) === String(expected)) : op === 'contains' ? String(actual ?? '').includes(String(expected ?? '')) : op === 'gt' ? Number(actual) > Number(expected) : Number(actual) < Number(expected)
