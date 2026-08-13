import { useMemo, useState } from 'react'
import { useFlow } from '../store'
import { CATEGORY_COLOR, NODE_TYPE_MAP } from '../registry'
import { availableVars, validateNode } from '../lib/vars'
import { probedColumns } from '../lib/output'
import { previewFromRun } from '../lib/engine'
import type { FlowInputField } from '../types'
import SchemaForm from './SchemaForm'

export default function Inspector() {
  const selectedId = useFlow((s) => s.selectedId)
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)

  const node = nodes.find((n) => n.id === selectedId) ?? null
  const t = node ? NODE_TYPE_MAP.get(node.data.typeId) : null

  const vars = useMemo(
    () => availableVars(selectedId, nodes, edges, flowInputs),
    [selectedId, nodes, edges, flowInputs],
  )

  return (
    <aside className="panel panel--right">
      {node && t ? <NodeInspector key={node.id} vars={vars} /> : <FlowInspector />}
    </aside>
  )
}

function NodeInspector({ vars }: { vars: ReturnType<typeof availableVars> }) {
  const selectedId = useFlow((s) => s.selectedId)!
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const updateNodeParam = useFlow((s) => s.updateNodeParam)
  const renameNode = useFlow((s) => s.renameNode)
  const setNodeOnError = useFlow((s) => s.setNodeOnError)
  const deleteNode = useFlow((s) => s.deleteNode)
  const probeNode = useFlow((s) => s.probeNode)
  const openNdv = useFlow((s) => s.openNdv)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const backend = useFlow((s) => s.backend)
  const probing = useFlow((s) => s.probing)
  const probeError = useFlow((s) => s.probeError)
  useFlow((s) => s.registryVersion) // 注册表换了要重渲染表单

  // null = 跟随默认（学到列名就展开）；用户点过之后以用户的为准
  const [showOutput, setShowOutput] = useState<boolean | null>(null)
  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null

  const node = nodes.find((n) => n.id === selectedId)!
  const t = NODE_TYPE_MAP.get(node.data.typeId)!
  const errors = validateNode(node, nodes, edges, flowInputs)
  const color = CATEGORY_COLOR[t.category] ?? '#64748b'
  const probeable = t.output['x-dynamic'] === 'probe'
  const columns = probedColumns(node.data.probedOutput)
  // 学到了真实列名就默认展开 —— 这一段以前默认折叠，用户根本发现不了
  const open = showOutput ?? columns.length > 0

  return (
    <>
      <div className="panel__head">
        <span className="ins__icon" style={{ background: color }}>{t.icon}</span>
        <input
          className="ins__name"
          value={node.data.label}
          onChange={(e) => renameNode(node.id, e.target.value)}
        />
        <button className="ins__del" onClick={() => openNdv(node.id)} title="打开详情视图（输入/参数/输出），双击画布节点同效">
          详情
        </button>
        <button className="ins__del" onClick={() => deleteNode(node.id)} title="删除节点">
          删除
        </button>
      </div>

      <div className="ins__sub">
        <code>{t.type}</code>
        <span className="ins__ver">v{t.typeVersion}</span>
        <span className="ins__nid">引用名 {node.id}</span>
      </div>

      <div className="panel__body">
        {errors.length > 0 && (
          <div className="errors">
            {errors.map((e, i) => (
              <div key={i}>· {e}</div>
            ))}
          </div>
        )}

        <SchemaForm
          schema={t.input}
          values={node.data.params}
          required={t.input.required ?? []}
          vars={vars}
          onChange={(k, v) => updateNodeParam(node.id, k, v)}
          previewRef={previewFromRun(activeRun)}
          nodeId={node.id}
        />

        <div className="section">
          <button className="section__head" onClick={() => setShowOutput(!open)}>
            <span>{open ? '▾' : '▸'}</span> 输出结构
            {columns.length > 0 && <em>{columns.length} 列</em>}
            {columns.length === 0 && probeable && <em>动态</em>}
          </button>
          {open && (
            <div className="section__body">
              {columns.length > 0 && (
                <>
                  <div className="probe__ok">已学到 {columns.length} 个真实列名（跑一次就会自动更新）</div>
                  <div className="cols">
                    {columns.map((c) => (
                      <code className="cols__chip" key={c.name} title={c.type ? `类型 ${c.type}` : undefined}>
                        {c.name}
                        {c.type && <em>{c.type}</em>}
                      </code>
                    ))}
                  </div>
                </>
              )}
              {probeable && columns.length === 0 && (
                <div className="probe">
                  <div className="probe__text">
                    列名要运行时才知道。<b>跑一次这个节点就会自动学到</b> —— 下面这个按钮是给「还不想跑全量」
                    准备的：只跑一行把列名探回来。
                    {backend?.ok ? '会在平台上真跑一行。' : '（节点服务未连接，探测出的是假列）'}
                  </div>
                  <button disabled={probing === node.id} onClick={() => void probeNode(node.id)}>
                    {probing === node.id ? '探测中…' : '只跑一行探列名'}
                  </button>
                  {probeError && <div className="probe__err">{probeError}</div>}
                </div>
              )}
              <details className="outschema__decl">
                <summary>声明的输出结构</summary>
                <pre className="mono outschema">{JSON.stringify(t.output, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>

        <div className="section">
          <div className="section__head section__head--static">错误处理</div>
          <div className="section__body">
            <div className="field">
              <label className="field__label">失败时</label>
              <select value={node.data.onError} onChange={(e) => setNodeOnError(node.id, e.target.value as 'fail' | 'continue')}>
                <option value="fail">中断整条流程</option>
                <option value="continue">记录错误并继续</option>
              </select>
            </div>
            <div className="policy">
              幂等：<b>{t.policy?.idempotent ? '是 · 可自动重试' : '否 · 重试需带幂等键'}</b>
              {t.policy?.retry && (
                <>
                  <br />
                  重试：{t.policy.retry.maxAttempts} 次 / {t.policy.retry.backoff}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function FlowInspector() {
  const flowName = useFlow((s) => s.flowName)
  const setFlowName = useFlow((s) => s.setFlowName)
  const flowInputs = useFlow((s) => s.flowInputs)
  const addFlowInput = useFlow((s) => s.addFlowInput)
  const updateFlowInput = useFlow((s) => s.updateFlowInput)
  const removeFlowInput = useFlow((s) => s.removeFlowInput)
  const setRunPanelOpen = useFlow((s) => s.setRunPanelOpen)

  return (
    <>
      <div className="panel__head">
        <span className="panel__title">流程设置</span>
      </div>
      <div className="panel__body">
        <div className="field">
          <label className="field__label">流程名称</label>
          <input value={flowName} onChange={(e) => setFlowName(e.target.value)} />
        </div>

        <div className="section">
          <div className="section__head section__head--static">
            流程入参
            <em>只定义有哪些参数</em>
          </div>
          <div className="section__body">
            {flowInputs.map((f, i) => (
              <div className="inputrow" key={i}>
                <input
                  className="mono"
                  value={f.key}
                  placeholder="key"
                  onChange={(e) => updateFlowInput(i, { key: e.target.value })}
                />
                <input
                  value={f.title}
                  placeholder="显示名"
                  onChange={(e) => updateFlowInput(i, { title: e.target.value })}
                />
                <select
                  value={f.type}
                  onChange={(e) => updateFlowInput(i, { type: e.target.value as FlowInputField['type'] })}
                >
                  <option value="string">文本</option>
                  <option value="integer">整数</option>
                  <option value="boolean">布尔</option>
                </select>
                <label className="inputrow__req" title="必填">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => updateFlowInput(i, { required: e.target.checked })}
                  />
                  必填
                </label>
                <button onClick={() => removeFlowInput(i)} title="删除">×</button>
              </div>
            ))}
            {flowInputs.length === 0 && (
              <div className="empty">
                还没有入参。入参是「每次运行前现填的空格」——
                同一条流程换个值再跑一次，不用改 SQL。值固定不变的话直接写死在 SQL 里，不用做成入参。
              </div>
            )}
            <button className="kv__add" onClick={addFlowInput}>+ 添加入参</button>

            {/* 这一栏只定义参数，不填值 —— 而填值的运行面板默认是收起来的，
                用户声明完参数会发现"没地方填"。把去处直接指出来。 */}
            {flowInputs.length > 0 && (
              <div className="inputs__where">
                <b>值不在这里填</b>
                <span>
                  这里只定义「有哪些参数」。具体的值每次运行前在底部
                  <button className="linkbtn" onClick={() => setRunPanelOpen(true)}>手动运行</button>
                  表单里填 —— 同一条流程换个值再跑一次，就是靠它。
                </span>
                <span className="inputs__where-sub">
                  SQL 里写 {'{{'}
                  {flowInputs[0].key}
                  {'}}'} 或 :{flowInputs[0].key}，运行时会自动代入你填的值。
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="tip">
          点击画布上的节点来配置它。<br />
          从左侧拖节点进画布，拖动节点右侧圆点连线。
        </div>
      </div>
    </>
  )
}
