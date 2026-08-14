import { useCallback, useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import Toolbar, { type DockPanel } from './components/Toolbar'
import Canvas from './components/Canvas'
import Inspector, { FlowInspector } from './components/Inspector'
import JsonDrawer from './components/JsonDrawer'
import VarDrawer from './components/VarDrawer'
import RunPanel from './components/RunPanel'
import NodeDetailView from './components/NodeDetailView'
import Home from './components/Home'
import { saveFlow, type SavedFlow } from './lib/library'
import type { Template } from './lib/templates'
import type { FlowDefinition } from './types'
import { useFlow } from './store'

export default function App() {
  // 首页 / 编辑器。以前打开就直接是编辑器 —— 那其实是"新建流程"页
  const [view, setView] = useState<'home' | 'editor'>('home')
  // 右侧停靠区一次只放一个：流程设置 / 流程 JSON / 选中节点的配置。
  // dock 有值时压过节点配置；dock 为 null 时选中谁就显示谁
  const [dock, setDock] = useState<DockPanel>(null)
  // 变量表是**再加一栏**，配字段的时候要能一边抄一边看，所以不参与上面的互斥
  const [varsOpen, setVarsOpen] = useState(false)
  const runPanelOpen = useFlow((s) => s.runPanelOpen)
  const ndvNodeId = useFlow((s) => s.ndvNodeId)
  const selectedId = useFlow((s) => s.selectedId)
  const loadRegistry = useFlow((s) => s.loadRegistry)

  // 探后端 + 拉节点注册表。探不到就整站留在 mock 模式，编辑器照样能用
  useEffect(() => {
    void loadRegistry()
  }, [loadRegistry])

  // 有没有没存的改动。不自动保存，所以这个状态是用户唯一的提醒
  const [dirty, setDirty] = useState(false)
  const markDirty = useCallback(() => setDirty(true), [])
  useDirtyWatch(view === 'editor', markDirty)

  const save = useCallback(() => {
    saveFlow(useFlow.getState().toDefinition())
    setDirty(false)
  }, [])

  // ⌘S / Ctrl+S。手会自己按，按了什么都没发生最伤
  useEffect(() => {
    if (view !== 'editor') return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, save])

  // 关标签页/刷新前拦一下。没有自动保存兜底，这是最后一道
  useEffect(() => {
    if (!dirty) return
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  const enter = (def: FlowDefinition, isNew: boolean) => {
    useFlow.getState().loadDefinition(def)
    // 模板/导入的是还没落过盘的新流程，一进来就算"未保存"，保存按钮得是亮的；
    // 从库里打开的则是干净状态
    setDirty(isNew)
    setDock(null)
    setVarsOpen(false)
    setView('editor')
  }

  const goHome = () => {
    // 回首页会把画布整个卸载，没存的东西就真没了 —— 先问一句
    if (dirty && !confirm('这条流程有改动还没保存，离开就丢了。确定回首页？')) return
    if (useFlow.getState().running) useFlow.getState().stopRun()
    setView('home')
  }

  if (view === 'home') {
    return (
      <div className="app">
        <Home
          onOpenTemplate={(t: Template) => enter(t.build(), true)}
          onOpenSaved={(f: SavedFlow) => enter(f.def, false)}
          onImport={(def) => enter(def, true)}
        />
      </div>
    )
  }

  // 停靠区里到底有没有东西 —— 变量栏要靠它决定往左让多远
  const dockOpen = dock !== null || selectedId !== null

  return (
    <div className="app">
      <Toolbar
        dock={dock}
        onDock={setDock}
        varsOpen={varsOpen}
        onToggleVars={() => setVarsOpen((v) => !v)}
        onHome={goHome}
        onSave={save}
        dirty={dirty}
      />
      <ReactFlowProvider>
        <div className="app__main">
          {/* 画布铺满，配置面板浮在它上面（Dify 同款）—— 面板收起时画布就是整块的，
              不像固定栏那样永远切掉右边 348px */}
          <div className="app__stage">
            <Canvas />
            {dock === 'json' ? (
              <JsonDrawer onClose={() => setDock(null)} />
            ) : dock === 'flow' ? (
              <aside className="dock">
                <FlowInspector onClose={() => setDock(null)} />
              </aside>
            ) : (
              selectedId && <Inspector />
            )}
            {/* 常挂载：收放靠 CSS 过渡，和停靠区一起平移 */}
            <VarDrawer open={varsOpen} shifted={dockOpen} onClose={() => setVarsOpen(false)} />
          </div>
          {runPanelOpen && <RunPanel />}
        </div>
        {/* key：切换节点时重挂载，iterIdx/editingPin 等内部状态不跨节点泄漏 */}
        {ndvNodeId && <NodeDetailView key={ndvNodeId} />}
      </ReactFlowProvider>
    </div>
  )
}

/**
 * 盯着"流程本身"有没有被改过，改了就置脏。
 *
 * 只认节点/连线/名字/入参/固定数据 —— 选中哪个节点、跑了一次、开关面板都会
 * 触发 store 更新，把这些也算成改动的话，保存按钮会一直亮着，等于没有提醒。
 * 靠引用比较就够：store 里这几个字段每次变更都是新数组/新对象。
 */
function useDirtyWatch(active: boolean, onChange: () => void) {
  useEffect(() => {
    if (!active) return
    type Snapshot = ReturnType<typeof pick>
    const pick = (s: ReturnType<typeof useFlow.getState>) => ({
      nodes: s.nodes,
      edges: s.edges,
      flowName: s.flowName,
      flowInputs: s.flowInputs,
      pinData: s.pinData,
    })
    const same = (a: Snapshot, b: Snapshot) =>
      a.nodes === b.nodes && a.edges === b.edges && a.flowName === b.flowName &&
      a.flowInputs === b.flowInputs && a.pinData === b.pinData

    let prev = pick(useFlow.getState())
    return useFlow.subscribe((s) => {
      const cur = pick(s)
      if (same(cur, prev)) return
      prev = cur
      onChange()
    })
  }, [active, onChange])
}
