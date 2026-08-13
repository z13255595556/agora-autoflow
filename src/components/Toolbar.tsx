import { useMemo } from 'react'
import { useFlow } from '../store'
import { validateNode } from '../lib/vars'

export default function Toolbar({ onToggleJson, jsonOpen }: { onToggleJson: () => void; jsonOpen: boolean }) {
  const flowName = useFlow((s) => s.flowName)
  const setFlowName = useFlow((s) => s.setFlowName)
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const clear = useFlow((s) => s.clear)
  const select = useFlow((s) => s.select)

  const running = useFlow((s) => s.running)
  const runPanelOpen = useFlow((s) => s.runPanelOpen)
  const setRunPanelOpen = useFlow((s) => s.setRunPanelOpen)
  const pinData = useFlow((s) => s.pinData)
  const backend = useFlow((s) => s.backend)
  const stopRun = useFlow((s) => s.stopRun)
  useFlow((s) => s.registryVersion) // 注册表换了要重算问题数

  // pinned 节点执行时跳过参数校验（n8n 语义），问题计数也不算它
  const problems = useMemo(
    () =>
      nodes
        .filter((n) => !Object.prototype.hasOwnProperty.call(pinData, n.id))
        .flatMap((n) => validateNode(n, nodes, edges, flowInputs).map((e) => ({ id: n.id, name: n.data.label, e }))),
    [nodes, edges, flowInputs, pinData],
  )

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__logo">◆</span>
        Workflow Studio
        <span className="toolbar__tag">空壳前端</span>
      </div>

      <input className="toolbar__name" value={flowName} onChange={(e) => setFlowName(e.target.value)} />

      <div className="toolbar__stats">
        {nodes.length} 节点 · {edges.length} 连线
      </div>

      <span
        className={`conn conn--${backend ? (backend.ok ? 'ok' : 'warn') : 'off'}`}
        title={
          !backend
            ? '节点服务未连接，所有节点走本地 mock。启动 server 后刷新即可'
            : backend.ok
              ? `节点服务已连接 · ${backend.endpoint}`
              : `节点服务在，但缺凭证：${backend.missingCredentials.join('、')}`
        }
      >
        <i />
        {!backend ? 'mock' : backend.ok ? '已连接' : '缺凭证'}
      </span>

      <div className="toolbar__actions">
        <button
          className={problems.length ? 'btn btn--warn' : 'btn btn--ok'}
          onClick={() => problems[0] && select(problems[0].id)}
          title={problems.map((p) => `${p.name}: ${p.e}`).join('\n') || '静态校验通过'}
        >
          {problems.length ? `${problems.length} 处问题` : '校验通过'}
        </button>
        <button className={`btn${jsonOpen ? ' btn--active' : ''}`} onClick={onToggleJson}>
          流程 JSON
        </button>
        <button className="btn" onClick={() => { if (confirm('清空画布？')) clear() }}>
          清空
        </button>
        {running ? (
          <button className="btn btn--warn" onClick={stopRun} title="中止运行，并取消平台上还在跑的任务">
            ■ 停止
          </button>
        ) : (
          <button
            className={`btn btn--primary${runPanelOpen ? ' btn--active' : ''}`}
            onClick={() => setRunPanelOpen(!runPanelOpen)}
            title={backend?.ok ? '打开运行面板（SQL 节点走真实执行）' : '打开运行面板（mock 执行）'}
          >
            ▶ 运行
          </button>
        )}
      </div>
    </header>
  )
}
