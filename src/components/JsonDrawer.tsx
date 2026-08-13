import { useState } from 'react'
import { useFlow } from '../store'
import type { FlowDefinition } from '../types'

export default function JsonDrawer({ onClose }: { onClose: () => void }) {
  const toDefinition = useFlow((s) => s.toDefinition)
  const loadDefinition = useFlow((s) => s.loadDefinition)
  const [tab, setTab] = useState<'export' | 'import'>('export')
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')

  const json = JSON.stringify(toDefinition(), null, 2)

  const doImport = () => {
    try {
      const parsed = JSON.parse(draft) as FlowDefinition
      if (!Array.isArray(parsed.nodes)) throw new Error('缺少 nodes 数组')
      loadDefinition(parsed)
      setErr('')
      onClose()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }

  return (
    <div className="drawer">
      <div className="drawer__head">
        <div className="drawer__tabs">
          <button className={tab === 'export' ? 'on' : ''} onClick={() => setTab('export')}>导出</button>
          <button className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')}>导入</button>
        </div>
        <div className="drawer__actions">
          {tab === 'export' && (
            <button className="btn" onClick={() => navigator.clipboard?.writeText(json)}>复制</button>
          )}
          {tab === 'import' && <button className="btn btn--primary" onClick={doImport}>载入</button>}
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>

      {tab === 'export' ? (
        <>
          <div className="drawer__note">
            逻辑（nodes / edges）与布局（layout）分开存，流程才能 diff、能 code review、能用 API 生成。
          </div>
          <pre className="drawer__code mono">{json}</pre>
        </>
      ) : (
        <>
          <div className="drawer__note">粘贴一份流程定义 JSON 覆盖当前画布。</div>
          {err && <div className="errors">{err}</div>}
          <textarea
            className="drawer__input mono"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='{ "id": "flow_x", "nodes": [...], "edges": [...], "layout": {...} }'
          />
        </>
      )}
    </div>
  )
}
