import { useEffect, useMemo, useRef, useState } from 'react'
import { useFlow } from '../store'
import { validateNode } from '../lib/vars'
import Icon from './Icon'

export type DockPanel = 'flow' | 'json' | null

/**
 * 编辑器顶栏。
 *
 * 原来是一排八个同样大小的灰按钮，主操作（运行）和「清空」长得一模一样，
 * 眼睛没有落点。现在按频率分三档：左边是身份（返回 / 流程名 / 保存状态），
 * 右边只留高频的三个（变量、保存、运行），其余收进「更多」。
 */
export default function Toolbar({
  dock,
  onDock,
  onToggleVars,
  varsOpen,
  onHome,
  onSave,
  dirty,
}: {
  dock: DockPanel
  onDock: (p: DockPanel) => void
  onToggleVars: () => void
  varsOpen: boolean
  onHome: () => void
  onSave: () => void
  /** 有改动还没保存。不自动保存，全靠这个按钮 */
  dirty: boolean
}) {
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

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  // pinned 节点执行时跳过参数校验（n8n 语义），问题计数也不算它
  const problems = useMemo(
    () =>
      nodes
        .filter((n) => !Object.prototype.hasOwnProperty.call(pinData, n.id))
        .flatMap((n) => validateNode(n, nodes, edges, flowInputs).map((e) => ({ id: n.id, name: n.data.label, e }))),
    [nodes, edges, flowInputs, pinData],
  )

  return (
    <header className="topbar">
      <button className="topbar__back" onClick={onHome} title="返回流程列表">
        <Icon name="back" />
      </button>

      <div className="topbar__id">
        <input
          className="topbar__name"
          value={flowName}
          onChange={(e) => setFlowName(e.target.value)}
          title="点击重命名"
        />
        <div className="topbar__meta">
          <span>
            {nodes.length} 节点 · {edges.length} 连线
          </span>
          <span className={`savestate${dirty ? ' savestate--dirty' : ''}`}>{dirty ? '未保存' : '已保存'}</span>
        </div>
      </div>

      <div className="topbar__right">
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

        <button
          className={`chip${problems.length ? ' chip--warn' : ' chip--ok'}`}
          onClick={() => problems[0] && select(problems[0].id)}
          title={problems.map((p) => `${p.name}: ${p.e}`).join('\n') || '静态校验通过'}
        >
          <i />
          {problems.length ? `${problems.length} 处待补` : '校验通过'}
        </button>

        <i className="topbar__sep" />

        <button
          className={`btn btn--icon${varsOpen ? ' btn--active' : ''}`}
          onClick={onToggleVars}
          title="所有能引用的变量和日期函数，点一条复制"
        >
          <Icon name="vars" size={14} /> 变量
        </button>

        <div className="menu" ref={menuRef}>
          <button className="btn btn--icon" onClick={() => setMenuOpen((v) => !v)} title="更多">
            <Icon name="more" size={14} />
          </button>
          {menuOpen && (
            <div className="menu__pop">
              <button
                className="menu__item"
                onClick={() => {
                  onDock(dock === 'flow' ? null : 'flow')
                  setMenuOpen(false)
                }}
              >
                流程设置<em>入参 / 名称</em>
              </button>
              {/* 「整理」不放这儿 —— 画布左下角的控制条里那个还会顺手把视野跟过去，
                  这里放一个不跟视野的同名项，只会让人以为两个功能不一样 */}
              <button
                className="menu__item"
                onClick={() => {
                  onDock(dock === 'json' ? null : 'json')
                  setMenuOpen(false)
                }}
              >
                流程 JSON<em>导入 / 导出</em>
              </button>
              <i className="menu__sep" />
              <button
                className="menu__item menu__item--danger"
                onClick={() => {
                  setMenuOpen(false)
                  if (confirm('清空画布？画布上的节点、连线和入参都会没掉。')) clear()
                }}
              >
                清空画布
              </button>
            </div>
          )}
        </div>

        <button
          className={`btn${dirty ? ' btn--dirty' : ''}`}
          onClick={onSave}
          disabled={!dirty}
          title={dirty ? '保存到流程库（⌘S / Ctrl+S）' : '没有未保存的改动'}
        >
          保存
        </button>

        {running ? (
          <button className="btn btn--stop" onClick={stopRun} title="中止运行，并取消平台上还在跑的任务">
            <Icon name="stop" size={12} /> 停止
          </button>
        ) : (
          <button
            className={`btn btn--primary${runPanelOpen ? ' btn--active' : ''}`}
            onClick={() => setRunPanelOpen(!runPanelOpen)}
            title={backend?.ok ? '打开运行面板（SQL 节点走真实执行）' : '打开运行面板（mock 执行）'}
          >
            <Icon name="play" size={12} /> 运行
          </button>
        )}
      </div>
    </header>
  )
}
