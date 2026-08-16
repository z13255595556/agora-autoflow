import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFlow } from '../store'
import { CATEGORY_COLOR, NODE_TYPE_MAP } from '../registry'
import { availableVars, validateNode } from '../lib/vars'
import { probedColumns, probedObjectFields } from '../lib/output'
import { previewFromRun } from '../lib/engine'
import SchemaForm from './SchemaForm'
import HttpRequestForm from './HttpRequestForm'
import WebhookPanel from './WebhookPanel'
import FlowInputsEditor from './FlowInputsEditor'
import Icon from './Icon'

/**
 * 选中节点时浮在画布右侧的配置面板。
 *
 * 以前是常驻的一整栏，没选节点时显示流程设置 —— 于是画布永远少 348px，
 * 而那一栏八成时间在显示一段"点击画布上的节点来配置它"的提示。现在改成
 * 浮层：选中才出现，没选中画布就是整块的；流程设置移到顶栏的「更多」里。
 */
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

  if (!node || !t) return null
  return (
    <aside className="dock" data-node-id={node.id}>
      <NodeInspector key={node.id} vars={vars} />
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
  const openNdv = useFlow((s) => s.openNdv)
  const clearSelection = useFlow((s) => s.clearSelection)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const running = useFlow((s) => s.running)
  const testStep = useFlow((s) => s.testStep)
  const pinData = useFlow((s) => s.pinData)
  const unpinNode = useFlow((s) => s.unpinNode)
  const dirtyNodes = useFlow((s) => s.dirtyNodes)
  useFlow((s) => s.registryVersion) // 注册表换了要重渲染表单

  // null = 跟随默认（学到列名就展开）；用户点过之后以用户的为准
  const [showOutput, setShowOutput] = useState<boolean | null>(null)
  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null

  const node = nodes.find((n) => n.id === selectedId)!
  const t = NODE_TYPE_MAP.get(node.data.typeId)!
  const errors = validateNode(node, nodes, edges, flowInputs)
  const color = CATEGORY_COLOR[t.category] ?? '#64748b'
  const dynamicMode = t.output['x-dynamic']
  const columns = probedColumns(node.data.probedOutput)
  const responseFields = probedObjectFields(node.data.probedOutput)
  // 学到了真实结构就默认展开 —— 这一段以前默认折叠，用户根本发现不了
  const open = showOutput ?? columns.length + responseFields.length > 0
  const runWithStep = runs.find((run) => (run.steps[node.id]?.length ?? 0) > 0)
  const lastStep = runWithStep?.steps[node.id]?.at(-1)
  const isPinned = Object.prototype.hasOwnProperty.call(pinData, node.id)
  const isDirty = Boolean(dirtyNodes[node.id])

  const runStep = useCallback(() => {
    if (running || errors.length) return
    if (isPinned) {
      if (!confirm('该节点输出已固定。运行本节点会取消固定并真实执行，继续？')) return
      unpinNode(node.id)
    }
    void testStep(node.id)
  }, [running, errors.length, isPinned, unpinNode, node.id, testStep])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || event.shiftKey) return
      event.preventDefault()
      runStep()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runStep])

  const runState = running && lastStep?.status === 'running'
    ? { tone: 'running', text: '正在执行' }
    : isDirty && lastStep
      ? { tone: 'stale', text: '参数已修改，结果已过期' }
      : lastStep?.status === 'success'
        ? { tone: 'success', text: `上次成功 · ${lastStep.durationMs}ms` }
        : lastStep?.status === 'error'
          ? { tone: 'error', text: '上次执行失败' }
          : { tone: 'idle', text: '尚未运行' }

  return (
    <>
      <div className="dock__head">
        <span className="ins__icon" style={{ background: color }}>{t.icon}</span>
        <input
          className="ins__name"
          value={node.data.label}
          onChange={(e) => renameNode(node.id, e.target.value)}
          title="点击重命名这个节点"
        />
        <button className="iconbtn" onClick={() => openNdv(node.id)} title="详情视图：输入 / 参数 / 输出（双击画布节点同效）">
          <Icon name="expand" />
        </button>
        {t.hasInput !== false && (
          <button className="iconbtn iconbtn--danger" onClick={() => deleteNode(node.id)} title="删除节点">
            <Icon name="trash" />
          </button>
        )}
        <i className="dock__sep" />
        <button className="iconbtn" onClick={clearSelection} title="收起面板">
          <Icon name="close" />
        </button>
      </div>

      <div className="ins__sub">
        <code>{t.type}</code>
        <span className="ins__ver">v{t.typeVersion}</span>
        <span className="ins__nid">引用名 {node.id}</span>
      </div>

      <div className="dock__body">
        {/* 地址放在参数**上面**：用户点开这个节点九成是来拿地址的，
            而认证方式那两个下拉是配置完就不再看的东西 */}
        {t.type === 'trigger.webhook' && <WebhookPanel nodeParams={node.data.params} />}

        {t.type === 'http.request' ? (
          <HttpRequestForm
            schema={t.input}
            values={node.data.params}
            required={t.input.required ?? []}
            vars={vars}
            onChange={(k, v) => updateNodeParam(node.id, k, v)}
            previewRef={previewFromRun(activeRun, pinData)}
            nodeId={node.id}
            validationErrors={errors}
          />
        ) : (
          <SchemaForm
            schema={t.input}
            values={node.data.params}
            required={t.input.required ?? []}
            vars={vars}
            onChange={(k, v) => updateNodeParam(node.id, k, v)}
            previewRef={previewFromRun(activeRun, pinData)}
            nodeId={node.id}
            validationErrors={errors}
          />
        )}

        <div className="section">
          <button className="section__head" onClick={() => setShowOutput(!open)}>
            <span>{open ? '▾' : '▸'}</span> 输出结构
            {columns.length > 0 && <em>{columns.length} 列</em>}
            {responseFields.length > 0 && <em>{responseFields.length} 字段</em>}
            {columns.length === 0 && responseFields.length === 0 && dynamicMode && <em>动态</em>}
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
              {responseFields.length > 0 && (
                <>
                  <div className="probe__ok">已识别 {responseFields.length} 个真实响应字段</div>
                  <div className="cols">
                    {responseFields.map(({ path, schema }) => (
                      <code className="cols__chip" key={path} title={`可在下游引用 output.${path}`}>
                        {path}
                        {schema.type && <em>{schema.type}</em>}
                      </code>
                    ))}
                  </div>
                </>
              )}
              {dynamicMode === 'run' && responseFields.length === 0 && (
                <div className="probe__text">成功运行一次后，这里会列出响应体字段，下游可直接从变量菜单选择。</div>
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

      <div className="insrun">
        <span className={`insrun__state insrun__state--${runState.tone}`} title={lastStep?.error}>
          <i />{runState.text}
        </span>
        {lastStep && (
          <button className="btn btn--sm" onClick={() => openNdv(node.id)}>查看结果</button>
        )}
        <button
          className="btn btn--sm btn--primary"
          disabled={running || errors.length > 0}
          title={errors[0] ?? '运行本节点（⌘/Ctrl+Enter）'}
          onClick={runStep}
        >
          <Icon name="play" size={13} /> {running ? '执行中' : '运行本节点'}
        </button>
      </div>
    </>
  )
}

export function FlowInspector({ onClose }: { onClose: () => void }) {
  const flowName = useFlow((s) => s.flowName)
  const setFlowName = useFlow((s) => s.setFlowName)

  return (
    <>
      <div className="dock__head">
        <span className="dock__title">流程设置</span>
        <i className="dock__sep" />
        <button className="iconbtn" onClick={onClose} title="收起面板">
          <Icon name="close" />
        </button>
      </div>
      <div className="dock__body">
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
            <FlowInputsEditor />
          </div>
        </div>

        <div className="tip">
          加节点：点节点右侧的 <b>+</b>，或画布左上角的「添加节点」。<br />
          连线中间的 <b>+</b> 可以往两个节点之间插一步。
        </div>
      </div>
    </>
  )
}
