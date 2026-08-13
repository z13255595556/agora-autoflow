import { useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import Toolbar from './components/Toolbar'
import Palette from './components/Palette'
import Canvas from './components/Canvas'
import Inspector from './components/Inspector'
import JsonDrawer from './components/JsonDrawer'
import RunPanel from './components/RunPanel'
import NodeDetailView from './components/NodeDetailView'
import { useFlow } from './store'

export default function App() {
  const [jsonOpen, setJsonOpen] = useState(false)
  const runPanelOpen = useFlow((s) => s.runPanelOpen)
  const ndvNodeId = useFlow((s) => s.ndvNodeId)
  const loadRegistry = useFlow((s) => s.loadRegistry)

  // 探后端 + 拉节点注册表。探不到就整站留在 mock 模式，编辑器照样能用
  useEffect(() => {
    void loadRegistry()
  }, [loadRegistry])

  return (
    <div className="app">
      <Toolbar jsonOpen={jsonOpen} onToggleJson={() => setJsonOpen((v) => !v)} />
      <ReactFlowProvider>
        <div className="app__main">
          <Palette />
          <div className="app__center">
            <Canvas />
            {runPanelOpen && <RunPanel />}
          </div>
          {jsonOpen ? <JsonDrawer onClose={() => setJsonOpen(false)} /> : <Inspector />}
        </div>
        {/* key：切换节点时重挂载，iterIdx/editingPin 等内部状态不跨节点泄漏 */}
        {ndvNodeId && <NodeDetailView key={ndvNodeId} />}
      </ReactFlowProvider>
    </div>
  )
}
