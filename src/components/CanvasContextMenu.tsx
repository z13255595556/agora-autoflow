import { useEffect, useMemo, useRef } from 'react'
import { NODE_TYPE_MAP } from '../registry'
import { useFlow } from '../store'
import Icon from './Icon'

export type CanvasMenuRequest =
  | { kind: 'pane'; x: number; y: number }
  | { kind: 'node'; x: number; y: number; nodeId: string }
  | { kind: 'selection'; x: number; y: number; nodeIds: string[] }

export default function CanvasContextMenu({
  request,
  onClose,
  onAdd,
  onPaste,
}: {
  request: CanvasMenuRequest
  onClose: () => void
  onAdd: () => void
  onPaste: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const nodes = useFlow((s) => s.nodes)
  const hasClipboard = useFlow((s) => Boolean(s.clipboard?.nodes.length))
  const copyNodes = useFlow((s) => s.copyNodes)
  const duplicateNode = useFlow((s) => s.duplicateNode)
  const deleteNode = useFlow((s) => s.deleteNode)
  const deleteNodes = useFlow((s) => s.deleteNodes)
  const arrangeNodes = useFlow((s) => s.arrangeNodes)
  const openNdv = useFlow((s) => s.openNdv)

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const style = useMemo(() => {
    const width = request.kind === 'selection' ? 244 : 194
    const height = request.kind === 'selection' ? 304 : request.kind === 'node' ? 190 : 102
    return {
      left: Math.max(8, Math.min(request.x, window.innerWidth - width - 12)),
      top: Math.max(8, Math.min(request.y, window.innerHeight - height - 12)),
    }
  }, [request])
  const node = request.kind === 'node' ? nodes.find((item) => item.id === request.nodeId) : undefined
  const nodeType = node ? NODE_TYPE_MAP.get(node.data.typeId) : undefined
  const copyable = Boolean(nodeType && nodeType.hasInput !== false)
  const copyTarget = node?.selected ? undefined : request.kind === 'node' ? request.nodeId : undefined

  const run = (action: () => void) => {
    action()
    onClose()
  }

  return (
    <div className={`ctxmenu${request.kind === 'selection' ? ' ctxmenu--selection' : ''}`} ref={ref} style={style} role="menu">
      {request.kind === 'pane' ? (
        <>
          <button role="menuitem" disabled={!hasClipboard} onClick={() => run(onPaste)}>
            <Icon name="copy" size={14} />
            <span>粘贴节点</span>
            <kbd>⌘V</kbd>
          </button>
          <button role="menuitem" onClick={() => run(onAdd)}>
            <Icon name="plus" size={14} />
            <span>添加节点</span>
          </button>
        </>
      ) : request.kind === 'selection' ? (
        <>
          <div className="ctxmenu__label">已选择 {request.nodeIds.length} 个节点</div>
          <div className="ctxmenu__arrange">
            <span>水平对齐</span>
            <div>
              <button role="menuitem" title="左对齐" onClick={() => run(() => { arrangeNodes(request.nodeIds, 'left') })}>左</button>
              <button role="menuitem" title="水平居中" onClick={() => run(() => { arrangeNodes(request.nodeIds, 'center-x') })}>中</button>
              <button role="menuitem" title="右对齐" onClick={() => run(() => { arrangeNodes(request.nodeIds, 'right') })}>右</button>
              <button role="menuitem" title="水平均匀分布" disabled={request.nodeIds.length < 3} onClick={() => run(() => { arrangeNodes(request.nodeIds, 'distribute-x') })}>均匀</button>
            </div>
            <span>垂直对齐</span>
            <div>
              <button role="menuitem" title="上对齐" onClick={() => run(() => { arrangeNodes(request.nodeIds, 'top') })}>上</button>
              <button role="menuitem" title="垂直居中" onClick={() => run(() => { arrangeNodes(request.nodeIds, 'center-y') })}>中</button>
              <button role="menuitem" title="下对齐" onClick={() => run(() => { arrangeNodes(request.nodeIds, 'bottom') })}>下</button>
              <button role="menuitem" title="垂直均匀分布" disabled={request.nodeIds.length < 3} onClick={() => run(() => { arrangeNodes(request.nodeIds, 'distribute-y') })}>均匀</button>
            </div>
          </div>
          <i />
          <button role="menuitem" onClick={() => run(() => { copyNodes() })}>
            <Icon name="copy" size={14} />
            <span>复制所选</span>
            <kbd>⌘C</kbd>
          </button>
          <button role="menuitem" onClick={() => run(() => { duplicateNode() })}>
            <Icon name="copy" size={14} />
            <span>创建副本</span>
            <kbd>⌘D</kbd>
          </button>
          <i />
          <button className="is-danger" role="menuitem" onClick={() => run(() => { deleteNodes(request.nodeIds) })}>
            <Icon name="trash" size={14} />
            <span>删除所选</span>
            <kbd>⌫</kbd>
          </button>
        </>
      ) : (
        <>
          {!nodeType?.visualOnly && (
            <button role="menuitem" onClick={() => run(() => openNdv(request.nodeId))}>
              <Icon name="expand" size={14} />
              <span>查看详情</span>
            </button>
          )}
          {copyable && (
            <>
              <button role="menuitem" onClick={() => run(() => { copyNodes(copyTarget) })}>
                <Icon name="copy" size={14} />
                <span>复制</span>
                <kbd>⌘C</kbd>
              </button>
              <button role="menuitem" onClick={() => run(() => { duplicateNode(copyTarget) })}>
                <Icon name="copy" size={14} />
                <span>创建副本</span>
                <kbd>⌘D</kbd>
              </button>
            </>
          )}
          {copyable && (
            <>
              <i />
              <button className="is-danger" role="menuitem" onClick={() => run(() => deleteNode(request.nodeId))}>
                <Icon name="trash" size={14} />
                <span>删除</span>
                <kbd>⌫</kbd>
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
