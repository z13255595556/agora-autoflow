import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFlow } from '../store'
import { CATEGORY_COLOR, NODE_TYPE_MAP } from '../registry'
import { availableVars, validateNode } from '../lib/vars'
import { probedColumns, probedObjectFields } from '../lib/output'
import { previewFromRun } from '../lib/engine'
import { pausable } from '../lib/engine-core/decide'
import { normalizeRetryPolicy, resolveRetry } from '../lib/engine-core/errorCodes'
import SchemaForm from './SchemaForm'
import WebhookPanel from './WebhookPanel'
import FlowInputsEditor from './FlowInputsEditor'
import Icon from './Icon'
import { storageMode } from '../lib/library'
import { getFlowNotify, setFlowNotify } from '../lib/client'
import WecomWebhookField from './WecomWebhookField'
import DataReferenceDrawer from './DataReferenceDrawer'
import { useReferenceHost } from './ReferencePickerContext'
import { stepRunState } from '../lib/runLabel'

/**
 * 选中节点时浮在画布右侧的配置面板。
 *
 * 以前是常驻的一整栏，没选节点时显示流程设置 —— 于是画布永远少 348px，
 * 而那一栏八成时间在显示一段"点击画布上的节点来配置它"的提示。现在改成
 * 浮层：选中才出现，没选中画布就是整块的；流程设置移到顶栏的常驻工具组里。
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
  return <InspectorCard nodeId={node.id} vars={vars} />
}

/**
 * 卡片本身就是抽屉的外壳：右边固定 398 是参数栏，左边被拉出来的是取值栏。
 *
 * 卡片 `right` 钉在 12px 不动、只动 `width`，所以拉出的整个过程参数栏
 * **一个像素都不挪** —— 抽屉是从它左边拽出来的，不是它被挤走。
 */
function InspectorCard({ nodeId, vars }: { nodeId: string; vars: ReturnType<typeof availableVars> }) {
  const { request, close } = useReferenceHost(nodeId)
  // 收回的 180ms 里内容得留着，否则缩回去的是一条空灰条
  const last = useRef(request)
  if (request) last.current = request

  return (
    <aside className={`dock nx-drawer-host${request ? ' is-open' : ''}`} data-node-id={nodeId}>
      <div className="nx-drawer">
        <DataReferenceDrawer request={request ?? last.current} inert={!request} onClose={close} />
      </div>
      <div className="nx-col-params">
        <NodeInspector key={nodeId} vars={vars} />
      </div>
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
  const setNodeNote = useFlow((s) => s.setNodeNote)
  const setNodeDisabled = useFlow((s) => s.setNodeDisabled)
  const setNodeRetry = useFlow((s) => s.setNodeRetry)
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
  const paused = Boolean(node.data.disabled) && pausable(node)
  // 暂停的节点不跑，它的参数错不拦运行（和 Toolbar 同一把尺子）；面板里仍然照常标红，
  // 用户恢复它之前就能看到要补什么
  const errors = validateNode(node, nodes, edges, flowInputs)
  // 老版本服务端下发的是三要素的旧形状，normalize 一道，别让面板显示「最长 NaN 秒」
  const typeRetry = normalizeRetryPolicy(t.policy?.retry) ?? undefined
  const retrySpec = resolveRetry(typeRetry, node.data.retry)
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
      if (!confirm('该节点输出已固定。运行本节点将取消固定并真实执行，继续？')) return
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

  // 和节点编辑页的运行条共用一份文案（见 runLabel.stepRunState）
  const runState = stepRunState({ running, lastStep, dirty: isDirty })

  return (
    <>
      {/* 标题栏和元信息合成一块。以前是 48px 的标题栏下面再压一条 33px 的
          灰底元信息条 —— 133px 常驻 chrome，而那条灰底里三样东西（类型、
          版本、引用名）都是看一眼就够的，不值得占一整行还自带底色 */}
      <div className="dock__head dock__head--node">
        <span className="ins__icon" style={{ background: color }}>{t.icon}</span>
        <div className="ins__title">
          <input
            className="ins__name"
            value={node.data.label}
            onChange={(e) => renameNode(node.id, e.target.value)}
            title="点击重命名这个节点"
          />
          <div className="ins__meta">
            <span>{t.name}</span>
          </div>
        </div>
        {t.docsUrl && (
          <a className="iconbtn" href={t.docsUrl} target="_blank" rel="noreferrer" title="这个节点的说明文档">
            <Icon name="help" />
          </a>
        )}
        <button className="iconbtn" onClick={() => openNdv(node.id)} title="详情视图：输入 / 参数 / 输出（双击画布节点同效）">
          <Icon name="expand" />
        </button>
        {t.hasInput !== false && (
          <button className="iconbtn iconbtn--danger" onClick={() => deleteNode(node.id)} title="删除节点">
            <Icon name="trash" />
          </button>
        )}
        <button className="iconbtn" onClick={clearSelection} title="收起面板">
          <Icon name="close" />
        </button>
      </div>

      <div className="dock__body">
        {/* 地址放在参数**上面**：用户点开这个节点九成是来拿地址的，
            而认证方式那两个下拉是配置完就不再看的东西 */}
        {t.type === 'trigger.webhook' && <WebhookPanel nodeParams={node.data.params} />}

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

        <div className="section">
          <button className="section__head" aria-expanded={open} onClick={() => setShowOutput(!open)}>
            <i className="section__caret" /> 输出结构
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
                <div className="probe__text">成功运行一次后列出响应体字段，下游可从变量菜单选择。</div>
              )}
              {columns.length === 0 && responseFields.length === 0 && !dynamicMode && (
                <div className="probe__text">输出结构固定，下游输入 / 即可选择。</div>
              )}
            </div>
          )}
        </div>

        {/* 设置：参数之外、每种节点都有的那几项（n8n 的 Settings 标签）。
            以前只有「失败时」一项 —— 调 SQL 时想让企微节点先别发，只能把它删掉再加回来 */}
        <div className="section">
          <details className="section__details" open={paused || undefined}>
            <summary className="section__head section__head--static">
              设置
              {paused && <em className="section__flag">已暂停</em>}
              {node.data.retry === null && <em>不重试</em>}
            </summary>
            <div className="section__body">
              {pausable(node) && (
                <div className="field">
                  <label className="switch">
                    <input type="checkbox" checked={paused} onChange={(e) => setNodeDisabled(node.id, e.target.checked)} />
                    <span>{paused ? '已暂停：跳过不执行，下游照常往下走' : '暂停此节点'}</span>
                  </label>
                  {paused && <div className="field__desc">下游若引用本节点输出会校验失败</div>}
                </div>
              )}
              <div className="field">
                <label className="field__label">失败时</label>
                <select value={node.data.onError} onChange={(e) => setNodeOnError(node.id, e.target.value as 'fail' | 'continue')}>
                  <option value="fail">中断整条流程</option>
                  <option value="continue">记录错误并继续</option>
                </select>
              </div>
              {typeRetry ? (
                <div className="field">
                  <label className="field__label">失败后重试</label>
                  <select
                    value={node.data.retry === null ? 'off' : node.data.retry === undefined ? 'default' : 'custom'}
                    onChange={(e) => {
                      const v = e.target.value
                      setNodeRetry(node.id, v === 'off' ? null : v === 'default' ? undefined : { maxAttempts: typeRetry.maxAttempts, initialMs: typeRetry.initialMs })
                    }}
                  >
                    <option value="default">默认 · 最多 {typeRetry.maxAttempts} 次，首次间隔 {Math.round(typeRetry.initialMs / 1000)} 秒</option>
                    <option value="off">不重试</option>
                    <option value="custom">自定义</option>
                  </select>
                  {node.data.retry && retrySpec && (
                    <div className="retry__row">
                      <label>最多 <input type="number" min={1} max={10} value={retrySpec.maxAttempts} onChange={(e) => setNodeRetry(node.id, { ...node.data.retry, maxAttempts: Number(e.target.value) })} /> 次</label>
                      <label>首次间隔 <input type="number" min={0} max={typeRetry.maximumIntervalMs / 1000} value={Math.round(retrySpec.initialMs / 1000)} onChange={(e) => setNodeRetry(node.id, { ...node.data.retry, initialMs: Number(e.target.value) * 1000 })} /> 秒</label>
                    </div>
                  )}
                  <div className="field__desc">只重试抖动 / 限流 / 超时</div>
                </div>
              ) : null}
              <div className="field">
                <label className="field__label">备注</label>
                <textarea
                  rows={2}
                  value={node.data.note ?? ''}
                  placeholder="写给下一个打开它的人：这条 SQL 只看昨天、这个群是测试群……"
                  onChange={(e) => setNodeNote(node.id, e.target.value)}
                />
              </div>
            </div>
          </details>
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

        <NotifySettings />

        <div className="tip">
          定时 / Webhook 跑已发布版本，不是当前草稿。
        </div>
      </div>
    </>
  )
}

/**
 * 失败时通知到哪。
 *
 * 告警是运行的旁路（worker/alerts.ts）：整条运行失败才发、同一原因 10 分钟内只发一条、
 * 发不出去不影响运行状态。这些在后端一直都在 —— 只是 notify_config 这一列在此之前
 * 没有任何界面能写，告警链路是条修好了路没有入口的死路。
 *
 * 不跟着草稿自动保存走：它是运维设置，改一次记一次审计；所以这里有自己的「保存」。
 */
function NotifySettings() {
  const flowId = useFlow((s) => s.flowId)
  const serverMode = storageMode() === 'server'
  const [loaded, setLoaded] = useState<string | null>(null)   // 服务端当前的值（'' = 没配）
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!serverMode || !flowId) return
    let alive = true
    setError(null)
    getFlowNotify(flowId)
      .then((r) => { if (alive) setLoaded(r.notifyConfig?.webhook ?? '') })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { alive = false }
  }, [serverMode, flowId])

  // 本地模式没有 worker，也就没有告警 —— 不画一个存不了的输入框
  if (!serverMode) return null

  return (
    <div className="section">
      <div className="section__head section__head--static">
        失败时通知
        <em>{loaded ? '已开启' : loaded === null ? '读取中…' : '跟随个人设置'}</em>
      </div>
      <div className="section__body">
        {error && <div className="field__errors" role="alert">{error}</div>}
        <WecomWebhookField
          loaded={loaded}
          onSave={async (hook) => {
            const r = await setFlowNotify(flowId, hook)
            return r.notifyConfig?.webhook ?? ''
          }}
          onSaved={setLoaded}
          toastFor={(saved) => (saved ? '这条流程的失败通知已单独设置' : '已改回跟随个人设置')}
          desc="覆盖个人默认；留空=跟随。整条失败才发，10 分钟内不重复。"
        />
      </div>
    </div>
  )
}
