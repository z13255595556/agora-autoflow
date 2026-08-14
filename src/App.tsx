import { useCallback, useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import Toolbar, { type DockPanel } from './components/Toolbar'
import Canvas from './components/Canvas'
import Inspector, { FlowInspector } from './components/Inspector'
import JsonDrawer from './components/JsonDrawer'
import RunPanel from './components/RunPanel'
import NodeDetailView from './components/NodeDetailView'
import Home from './components/Home'
import { getFlow, saveFlow } from './lib/library'
import type { Template } from './lib/templates'
import type { FlowDefinition } from './types'
import { useFlow } from './store'
import { NODE_TYPE_MAP } from './registry'

export default function App() {
  const route = routeFromPath(window.location.pathname)
  const editorFlowId = route.kind === 'editor' ? route.flowId : null
  const [editorReady, setEditorReady] = useState(false)
  // 右侧停靠区一次只放一个：流程设置 / 流程 JSON / 选中节点的配置。
  // dock 有值时压过节点配置；dock 为 null 时选中谁就显示谁
  const [dock, setDock] = useState<DockPanel>(null)
  const runPanelOpen = useFlow((s) => s.runPanelOpen)
  const ndvNodeId = useFlow((s) => s.ndvNodeId)
  const selectedId = useFlow((s) => s.selectedId)
  const selectedVisualOnly = useFlow((s) => {
    const node = s.nodes.find((item) => item.id === s.selectedId)
    return Boolean(node && NODE_TYPE_MAP.get(node.data.typeId)?.visualOnly)
  })
  const loadRegistry = useFlow((s) => s.loadRegistry)

  // 探后端 + 拉节点注册表。探不到就整站留在 mock 模式，编辑器照样能用
  useEffect(() => {
    void loadRegistry()
  }, [loadRegistry])

  // 编辑页是独立 URL。每次整页进入都按路径里的 flowId 重新加载，刷新不会丢流程。
  useEffect(() => {
    if (route.kind === 'home') return
    if (route.kind === 'invalid') {
      window.location.replace('/')
      return
    }
    const saved = getFlow(route.flowId)
    if (!saved) {
      window.location.replace('/')
      return
    }
    useFlow.getState().loadDefinition(saved.def)
    setDirty(false)
    setSaveError(null)
    setDock(null)
    setEditorReady(true)
  }, [route.kind, editorFlowId])

  // dirty 表示还有等待自动保存的持久化改动；临时 UI 状态不进入这里。
  const [dirty, setDirty] = useState(false)
  const [editRevision, setEditRevision] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const markDirty = useCallback(() => {
    setDirty(true)
    setSaveError(null)
    setEditRevision((revision) => revision + 1)
  }, [])
  useDirtyWatch(route.kind === 'editor' && editorReady, markDirty)

  const save = useCallback(() => {
    const saved = saveFlow(useFlow.getState().toDefinition())
    if (saved) {
      setDirty(false)
      setSaveError(null)
    } else {
      setSaveError('浏览器本地存储写入失败，请检查存储空间或隐私设置')
    }
    return saved
  }, [])

  // 每次真实流程改动后重新计时；连续输入只在停下 900ms 后写一次。
  useEffect(() => {
    if (route.kind !== 'editor' || !editorReady || !dirty) return
    const timer = window.setTimeout(() => { save() }, 900)
    return () => window.clearTimeout(timer)
  }, [route.kind, editorReady, dirty, editRevision, save])

  // 保存 + 画布撤销/重做。输入控件保留浏览器自己的文本历史，
  // 只有焦点不在编辑器里时才接管 ⌘/Ctrl+Z。
  useEffect(() => {
    if (route.kind !== 'editor' || !editorReady) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 's') {
        e.preventDefault()
        save()
        return
      }
      if (!mod || isTextEditingTarget(e.target)) return
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        useFlow.getState().undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        useFlow.getState().redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [route.kind, editorReady, save])

  // 标签页关闭时定时器可能来不及触发；localStorage 是同步写，最后再落一次。
  useEffect(() => {
    if (!dirty) return
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!saveFlow(useFlow.getState().toDefinition())) event.preventDefault()
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  const openFlowPage = (flowId: string) => {
    window.location.assign(`/workflows/${encodeURIComponent(flowId)}`)
  }

  const createAndOpen = (def: FlowDefinition) => {
    if (!saveFlow(def)) {
      window.alert('浏览器本地存储写入失败，请检查存储空间或隐私设置')
      return
    }
    openFlowPage(def.id)
  }

  const goHome = () => {
    // 防抖还没到点时先同步保存；只有真的写失败才留在编辑器。
    if (dirty && !save()) return
    if (useFlow.getState().running) useFlow.getState().stopRun()
    window.location.assign('/')
  }

  if (route.kind === 'home') {
    return (
      <div className="app">
        <Home
          onOpenTemplate={(t: Template) => createAndOpen(t.build())}
          onOpenSaved={(flow) => openFlowPage(flow.id)}
          onImport={createAndOpen}
        />
      </div>
    )
  }

  if (route.kind !== 'editor' || !editorReady) {
    return <div className="app"><div className="empty">正在打开流程…</div></div>
  }

  return (
    <div className="app">
      <Toolbar
        dock={dock}
        onDock={setDock}
        onHome={goHome}
        onSave={save}
        dirty={dirty}
        saveError={saveError}
      />
      <ReactFlowProvider>
        <div className="app__main">
          {/* 画布铺满，配置面板浮在它上面 —— 面板收起时画布就是整块的，
              不像固定栏那样永远切掉右边 348px */}
          <div className="app__stage">
            <Canvas reservedRight={dock || (selectedId && !selectedVisualOnly) ? 424 : 0} />
            {dock === 'json' ? (
              <JsonDrawer onClose={() => setDock(null)} />
            ) : dock === 'flow' ? (
              <aside className="dock">
                <FlowInspector onClose={() => setDock(null)} />
              </aside>
            ) : (
              selectedId && !selectedVisualOnly && <Inspector />
            )}
          </div>
          {runPanelOpen && <RunPanel />}
        </div>
        {/* key：切换节点时重挂载，iterIdx/editingPin 等内部状态不跨节点泄漏 */}
        {ndvNodeId && <NodeDetailView key={ndvNodeId} />}
      </ReactFlowProvider>
    </div>
  )
}

type AppRoute =
  | { kind: 'home' }
  | { kind: 'editor'; flowId: string }
  | { kind: 'invalid' }

function routeFromPath(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '/index.html') return { kind: 'home' }
  const match = /^\/workflows\/([^/]+)\/?$/.exec(pathname)
  if (!match) return { kind: 'invalid' }
  try {
    const flowId = decodeURIComponent(match[1])
    return flowId ? { kind: 'editor', flowId } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/**
 * 用实际导出的流程定义做持久化指纹。它天然排除了 selected、measured、运行结果、
 * 探测列等临时状态，比数组引用比较准确；纯选择节点不会触发自动保存。
 */
function useDirtyWatch(active: boolean, onChange: () => void) {
  useEffect(() => {
    if (!active) return
    const fingerprint = () => JSON.stringify(useFlow.getState().toDefinition())
    let prev = fingerprint()
    return useFlow.subscribe(() => {
      const cur = fingerprint()
      if (cur === prev) return
      prev = cur
      onChange()
    })
  }, [active, onChange])
}
