import { useEffect, useMemo, useRef, useState } from 'react'
import { useFlow } from '../store'
import { validateNode } from '../lib/vars'
import { graphProblems } from '../lib/graph'
import { NODE_TYPE_MAP } from '../registry'
import { focusValidationField } from '../lib/validationFocus'
import { storageMode } from '../lib/library'
import Icon from './Icon'
import { PublishDialog, VersionHistory } from './Versions'

export type DockPanel = 'flow' | 'json' | null

/**
 * 编辑器顶栏。
 *
 * 原来是一排八个同样大小的灰按钮，主操作（运行）和「清空」长得一模一样，
 * 眼睛没有落点。现在按频率分三档：左边是身份（返回 / 流程名 / 保存状态），
 * 右边直接展示全部流程操作，不再用「更多」隐藏入口。
 */
export interface PublishState {
  /** 已发布并生效的版本号。null = 从未发布 */
  activeVersion: number | null
  hasUnpublishedChanges: boolean
}

export default function Toolbar({
  dock,
  onDock,
  onHome,
  onSave,
  dirty,
  saveError,
  publish,
  onPublish,
  onRollback,
}: {
  dock: DockPanel
  onDock: (p: DockPanel) => void
  onHome: () => void
  onSave: () => void
  /** 有持久化改动正在等待防抖自动保存。 */
  dirty: boolean
  saveError: string | null
  publish: PublishState
  /** 发布；返回错误信息表示失败，null 表示成功。note 是这一版的变更说明，选填 */
  onPublish: (note: string) => Promise<string | null>
  /** 切回某个历史版本；返回错误信息表示失败，null 表示成功 */
  onRollback: (version: number) => Promise<string | null>
}) {
  const flowName = useFlow((s) => s.flowName)
  const setFlowName = useFlow((s) => s.setFlowName)
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const clear = useFlow((s) => s.clear)
  const focusNode = useFlow((s) => s.focusNode)
  const canUndo = useFlow((s) => s.historyPast.length > 0)
  const canRedo = useFlow((s) => s.historyFuture.length > 0)
  const undo = useFlow((s) => s.undo)
  const redo = useFlow((s) => s.redo)

  const running = useFlow((s) => s.running)
  const setRunPanelOpen = useFlow((s) => s.setRunPanelOpen)
  const pinData = useFlow((s) => s.pinData)
  const backend = useFlow((s) => s.backend)
  const stopRun = useFlow((s) => s.stopRun)
  const canceling = useFlow((s) => s.canceling)
  useFlow((s) => s.registryVersion) // 注册表换了要重算问题数

  const [problemsOpen, setProblemsOpen] = useState(false)
  /** 发布弹窗开着没。**发布不再是"点一下就发出去"** —— 中间隔一个填变更说明的框 */
  const [publishOpen, setPublishOpen] = useState(false)
  /** 历史版本面板开着没 */
  const [historyOpen, setHistoryOpen] = useState(false)
  // 接了流程存储才有"版本"这个概念；本地模式下画一个点了会报错的按钮不如不画
  const canPublish = storageMode() === 'server'
  const flowId = useFlow((s) => s.flowId)
  // 从没发布过就是第一版
  const nextVersion = (publish.activeVersion ?? 0) + 1
  const problemsRef = useRef<HTMLDivElement>(null)

  // pinned 节点执行时跳过参数校验（n8n 语义），问题计数也不算它；
  // 暂停的节点同理 —— 暂停的本意就是"先别管它"，它缺个 webhook 不该拦住别人跑
  const problems = useMemo(
    () => [
      ...graphProblems(nodes, edges).map((problem) => ({
        id: problem.nodeId,
        name: '流程结构',
        e: problem.message,
      })),
      ...nodes
        .filter((n) => !Object.prototype.hasOwnProperty.call(pinData, n.id) && !n.data.disabled)
        .flatMap((n) => validateNode(n, nodes, edges, flowInputs).map((e) => ({ id: n.id, name: n.data.label, e }))),
    ],
    [nodes, edges, flowInputs, pinData],
  )

  useEffect(() => {
    if (!problemsOpen) return
    const close = (event: MouseEvent) => {
      if (!problemsRef.current?.contains(event.target as Node)) setProblemsOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProblemsOpen(false)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [problemsOpen])

  useEffect(() => {
    if (problems.length === 0) setProblemsOpen(false)
  }, [problems.length])

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
          <span className={`savestate${saveError ? ' savestate--error' : dirty ? ' savestate--dirty' : ''}`}>
            {saveError ? '保存失败' : dirty ? '保存中…' : '已保存'}
          </span>
        </div>
      </div>

      <div className="topbar__right">
        <span
          className={`conn conn--${backend ? (backend.ok ? 'ok' : 'warn') : 'off'}`}
          title={
            !backend
              ? '节点服务未连接，全部节点走本地 mock；启动 server 后刷新'
              : backend.ok
                ? `节点服务已连接 · ${backend.endpoint}`
                : `节点服务在，但缺凭证：${backend.missingCredentials.join('、')}`
          }
        >
          <i />
          {!backend ? 'mock' : backend.ok ? '已连接' : '缺凭证'}
        </span>

        <div className="problemmenu" ref={problemsRef}>
          <button
            className={`chip${problems.length ? ' chip--warn' : ' chip--ok'}${problemsOpen ? ' is-open' : ''}`}
            onClick={() => {
              if (!problems.length) return
              setProblemsOpen((open) => !open)
            }}
            title={problems.length ? '查看全部校验问题' : '静态校验通过'}
            aria-expanded={problemsOpen}
            aria-haspopup={problems.length ? 'menu' : undefined}
          >
            <i />
            {problems.length ? `${problems.length} 处待补` : '校验通过'}
          </button>
          {problemsOpen && (
            <div className="problemmenu__pop" role="menu" aria-label="校验问题">
              <div className="problemmenu__head">
                <b>校验问题</b>
                <span>{problems.length}</span>
              </div>
              <div className="problemmenu__list">
                {problems.map((problem, index) => (
                  <button
                    key={`${problem.id ?? 'flow'}:${problem.e}:${index}`}
                    className="problemitem"
                    role="menuitem"
                    disabled={!problem.id}
                    onClick={() => {
                      if (!problem.id) return
                      setProblemsOpen(false)
                      onDock(null)
                      focusNode(problem.id)
                      const node = nodes.find((item) => item.id === problem.id)
                      const schema = node ? NODE_TYPE_MAP.get(node.data.typeId)?.input : undefined
                      if (schema) window.setTimeout(() => focusValidationField(problem.e, schema), 120)
                    }}
                  >
                    <i>!</i>
                    <span>
                      <b>{problem.name}</b>
                      <em>{problem.e}</em>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <i className="topbar__sep" />

        <div className="topbar__tools" aria-label="流程工具">
          <button
            className={`topbar__tool topbar__tool--text${dock === 'flow' ? ' is-active' : ''}`}
            onClick={() => {
              onDock(dock === 'flow' ? null : 'flow')
            }}
            title="流程设置：名称 / 入参"
          >
            <Icon name="settings" size={13} />
            <span>流程设置</span>
          </button>

          <button
            className="topbar__tool"
            disabled={running || !canUndo}
            onClick={undo}
            title="撤销（⌘Z）"
            aria-label="撤销"
          >
            <Icon name="undo" size={14} />
          </button>
          <button
            className="topbar__tool"
            disabled={running || !canRedo}
            onClick={redo}
            title="重做（⇧⌘Z）"
            aria-label="重做"
          >
            <Icon name="redo" size={14} />
          </button>

          <button
            className={`topbar__tool topbar__tool--text${dock === 'json' ? ' is-active' : ''}`}
            onClick={() => onDock(dock === 'json' ? null : 'json')}
            title="流程 JSON：导入 / 导出"
          >
            <Icon name="vars" size={13} />
            <span>流程 JSON</span>
          </button>

          {/* 发过版才有历史可看。本地模式下没有"版本"这个概念，
              和发布按钮同一条判据 */}
          {canPublish && (
            <button
              className="topbar__tool topbar__tool--text"
              onClick={() => setHistoryOpen(true)}
              title="历史版本：说明 / 回滚"
            >
              <span>历史版本</span>
            </button>
          )}

          <button
            className="topbar__tool topbar__tool--danger"
            onClick={() => {
              if (confirm('清空画布？节点、连线和入参都会删除。')) clear()
            }}
            title="清空画布"
            aria-label="清空画布"
          >
            <Icon name="trash" size={14} />
          </button>
        </div>

        {(dirty || saveError) && (
          <button
            className={`btn${saveError ? ' btn--error' : ' btn--dirty'}`}
            onClick={onSave}
            title={saveError ?? '立即保存（⌘S / Ctrl+S）'}
          >
            {saveError ? '重试保存' : '保存'}
          </button>
        )}

        {/* 发布只在接了流程存储时出现。本地模式下没有"版本"这个概念，
            画一个点了会报错的按钮不如不画 */}
        {canPublish && (
          <button
            className={`btn${publish.hasUnpublishedChanges ? ' btn--dirty' : ''}`}
            onClick={() => setPublishOpen(true)}
            // 没有改动就点不动。**版本号是"线上跑的是哪一份"，不是点击计数** ——
            // 再点一下只会多一个内容完全相同的 v4，之后版本列表和运行记录里的
            // 版本号就再也不说明任何事情了。真正的闸在服务端（publish 判定没有
            // 实际改动就不生版本），这里只是别让人白点。
            //
            // **dirty 要放行**：防抖还没落地时 hasUnpublishedChanges 还是上一次
            // 保存时的答案，刚敲完就点发布会撞上一个点不动的按钮。onPublish
            // 自己会先存一次，存完服务端说没改动的话它照样不生版本
            disabled={running
              || (publish.activeVersion !== null && !publish.hasUnpublishedChanges && !dirty)}
            title={
              publish.activeVersion === null
                ? '发布后才有第一个版本；定时 / Webhook 触发已发布版本'
                : publish.hasUnpublishedChanges
                  ? `生效中 v${publish.activeVersion}，草稿有未发布改动；定时 / Webhook 仍跑 v${publish.activeVersion}`
                  : `已发布 v${publish.activeVersion}，草稿与它一致，没有需要发布的改动（只挪动节点位置不算）`
            }
          >
            {publish.activeVersion === null
              ? '发布'
              : publish.hasUnpublishedChanges
                ? `发布 v${publish.activeVersion + 1}`
                : `v${publish.activeVersion}`}
          </button>
        )}

        {running ? (
          // 取消是发给 worker 的请求，不是一个瞬间（runstore.request_cancel）。
          // 这段时间按钮必须改口 —— 停在「停止」上不动，用户的结论是「按钮坏了」
          <button
            className="btn btn--stop"
            disabled={canceling}
            onClick={stopRun}
            title={canceling
              ? '取消请求已发出，等 worker 收尾。worker 没在跑的话它不会自己结束'
              : '中止运行，并取消平台上还在跑的任务'}
          >
            <Icon name="stop" size={12} /> {canceling ? '取消中…' : '停止'}
          </button>
        ) : (
          <button
            className="btn btn--primary"
            onClick={() => {
              // **只打开面板，不执行**。真正的运行入口只有面板里那一颗 ——
              // 这一颗按下去就跑的时候，跑的是一份用户没看过的入参：表单在
              // 面板里，而面板此刻还没打开。和节点编辑页那条运行条同一个理由
              setRunPanelOpen(true)
              window.dispatchEvent(new Event('autoflow-run-panel-focus'))
            }}
            title={
              backend?.ok
                ? '打开下方运行面板：填运行入参，再手动运行。点它不会直接执行'
                : '打开下方运行面板（mock 模式）：填运行入参，再手动运行。点它不会直接执行'
            }
          >
            <Icon name="play" size={12} /> 运行
          </button>
        )}
      </div>

      {/* 两个弹窗挂在 header 下面。发布走弹窗而不是直接发出去 ——
          变更说明只有这一个时机能填：发完就固化在那一版上了 */}
      {publishOpen && (
        <PublishDialog
          nextVersion={nextVersion}
          onCancel={() => setPublishOpen(false)}
          onPublish={onPublish}
        />
      )}
      {historyOpen && (
        <VersionHistory
          flowId={flowId}
          activeVersion={publish.activeVersion}
          onClose={() => setHistoryOpen(false)}
          onRollback={onRollback}
        />
      )}
    </header>
  )
}
