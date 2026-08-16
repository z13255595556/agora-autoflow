import { useCallback, useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import Toolbar, { type DockPanel } from './components/Toolbar'
import Canvas from './components/Canvas'
import Inspector, { FlowInspector } from './components/Inspector'
import JsonDrawer from './components/JsonDrawer'
import RunPanel from './components/RunPanel'
import NodeDetailView from './components/NodeDetailView'
import Home from './components/Home'
import { createFlow, getFlow, publishFlow, saveFlow, saveFlowSync } from './lib/library'
import type { Template } from './lib/templates'
import type { FlowDefinition } from './types'
import { useFlow } from './store'
import { NODE_TYPE_MAP } from './registry'
import { ReferencePickerProvider } from './components/ReferencePickerContext'

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

  /** health 探完了没。**流程加载必须等它** —— 探完才知道该读服务端还是 localStorage */
  const [backendProbed, setBackendProbed] = useState(false)
  /** 服务端上这条流程的发布状态。本地模式下恒为 null */
  const [flowMeta, setFlowMeta] = useState<{ activeVersion: number | null; hasUnpublishedChanges: boolean }>({
    activeVersion: null,
    hasUnpublishedChanges: false,
  })

  // 探后端 + 拉节点注册表。探不到就整站留在 mock 模式，编辑器照样能用
  useEffect(() => {
    void loadRegistry().finally(() => setBackendProbed(true))
  }, [loadRegistry])

  // 编辑页是独立 URL。每次整页进入都按路径里的 flowId 重新加载，刷新不会丢流程。
  useEffect(() => {
    if (route.kind === 'home') return
    if (route.kind === 'invalid') {
      window.location.replace('/')
      return
    }
    // 服务端存储在的话优先读它 —— 但要等 loadRegistry 探完 health 才知道在不在，
    // 所以这里依赖 backendProbed，不能一进来就读
    if (!backendProbed) return
    let cancelled = false
    void (async () => {
      const saved = await getFlow(route.flowId)
      if (cancelled) return
      if (!saved) {
        window.location.replace('/')
        return
      }
      useFlow.getState().loadDefinition(saved.def)
      // loadDefinition 之后才探：probeWebhook 要看画布上有没有 webhook 节点。
      // 不 await —— 它只喂画布上一行提示，不该拖慢流程打开
      void useFlow.getState().probeWebhook()
      setFlowMeta({ activeVersion: saved.activeVersion ?? null, hasUnpublishedChanges: !!saved.hasUnpublishedChanges })
      setDirty(false)
      setSaveError(null)
      setDock(null)
      setEditorReady(true)
    })()
    return () => { cancelled = true }
  }, [route.kind, editorFlowId, backendProbed])

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

  const save = useCallback(async () => {
    const result = await saveFlow(useFlow.getState().toDefinition())
    if (result.ok) {
      setDirty(false)
      // 服务端写失败但本地写成功：数据没丢，但必须说出来 ——
      // 用户以为存到服务器了，实际只在这台机器上
      setSaveError(result.error ? `已存到本地，但同步到服务端失败：${result.error}` : null)
      // 存了草稿就意味着和已发布那版可能不一致了
      setFlowMeta((m) => (m.activeVersion === null ? m : { ...m, hasUnpublishedChanges: true }))
    } else {
      setSaveError(result.error ?? '保存失败')
    }
    return result.ok
  }, [])

  // 每次真实流程改动后重新计时；连续输入只在停下 900ms 后写一次。
  useEffect(() => {
    if (route.kind !== 'editor' || !editorReady || !dirty) return
    const timer = window.setTimeout(() => { void save() }, 900)
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
        void save()
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

  // 标签页关闭时定时器可能来不及触发，最后再落一次。
  //
  // **只写本地**：这个时机发不出可靠的异步请求，浏览器没有义务等一个 fetch 完成。
  // 服务端那份靠防抖自动保存和离开编辑器时的 goHome 兜住；真在这里丢了同步，
  // 下次打开这条流程会从本地读到较新的那份（getFlow 服务端读失败也回落本地）。
  useEffect(() => {
    if (!dirty) return
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!saveFlowSync(useFlow.getState().toDefinition())) event.preventDefault()
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  /**
   * 发布：草稿 → 新版本 → 设为生效。
   *
   * 发布前先把草稿存下去 —— 否则发布出去的是服务端上那份**旧草稿**，
   * 而用户以为发的是眼前看到的内容。这是最容易被漏掉的一步。
   */
  const doPublish = useCallback(async (): Promise<string | null> => {
    if (dirty && !(await save())) return '草稿没保存成功，先解决保存问题再发布'
    const flowId = useFlow.getState().flowId
    const result = await publishFlow(flowId)
    if (!result.ok) return result.error ?? '发布失败'
    setFlowMeta({ activeVersion: result.version ?? null, hasUnpublishedChanges: false })
    return null
  }, [dirty, save])

  const openFlowPage = (flowId: string) => {
    window.location.assign(`/workflows/${encodeURIComponent(flowId)}`)
  }

  const createAndOpen = async (def: FlowDefinition) => {
    const result = await createFlow(def)
    if (!result.ok) {
      window.alert(result.error ?? '保存失败')
      return
    }
    if (result.error) window.alert(`已存到本地，但同步到服务端失败：${result.error}`)
    openFlowPage(def.id)
  }

  const goHome = async () => {
    // 防抖还没到点时先保存；只有真的写失败才留在编辑器。
    if (dirty && !(await save())) return
    if (useFlow.getState().running) useFlow.getState().stopRun()
    window.location.assign('/')
  }

  if (route.kind === 'home') {
    return (
      <div className="app">
        <Home
          ready={backendProbed}
          onOpenTemplate={(t: Template) => void createAndOpen(t.build())}
          onOpenSaved={(flow) => openFlowPage(flow.id)}
          onImport={(def: FlowDefinition) => void createAndOpen(def)}
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
        onHome={() => void goHome()}
        onSave={() => void save()}
        dirty={dirty}
        saveError={saveError}
        publish={flowMeta}
        onPublish={doPublish}
      />
      <ReactFlowProvider>
        <ReferencePickerProvider>
        <div className="app__main">
          {/* 画布铺满，配置面板浮在它上面 —— 面板收起时画布就是整块的，
              不像固定栏那样永远切掉右边 348px */}
          <div className="app__stage">
            {/* reservedRight 刻意**不**看 ndvNodeId：画布在模态背后，跟着 NDV
                开关去改预留宽度只会让它每次都重新 fit 两趟 */}
            <Canvas reservedRight={dock || (selectedId && !selectedVisualOnly) ? 424 : 0} />
            {dock === 'json' ? (
              <JsonDrawer onClose={() => setDock(null)} />
            ) : dock === 'flow' ? (
              <aside className="dock">
                <FlowInspector onClose={() => setDock(null)} />
              </aside>
            ) : (
              // NDV 开着时不挂 Inspector。双击节点会同时置上 selectedId 和
              // ndvNodeId（Canvas 的 onNodeClick + onNodeDoubleClick 都会触发，
              // openNdv 也不清 selectedId），于是同一个节点存在**两棵**表单：
              // 两份 ref、两份 slash 状态，而 .varpicker 的 z-index 70 还盖在
              // .ndv__mask 的 60 上面 —— 侧栏的变量弹窗能飘到模态前面。
              // NDV 本来就全屏盖住侧栏，卸掉它视觉上没有任何变化。
              !ndvNodeId && selectedId && !selectedVisualOnly && <Inspector />
            )}
          </div>
          {runPanelOpen && <RunPanel />}
        </div>
        {/* key：切换节点时重挂载，iterIdx/editingPin 等内部状态不跨节点泄漏 */}
        {ndvNodeId && <NodeDetailView key={ndvNodeId} />}
        </ReferencePickerProvider>
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
