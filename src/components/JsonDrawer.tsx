import { useState } from 'react'
import { useFlow } from '../store'
import Icon from './Icon'
import { normalizeFlowDefinition } from '../lib/flowImport'

export default function JsonDrawer({ onClose }: { onClose: () => void }) {
  const toDefinition = useFlow((s) => s.toDefinition)
  const loadDefinition = useFlow((s) => s.loadDefinition)
  const [tab, setTab] = useState<'export' | 'import'>('export')
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')

  const json = JSON.stringify(toDefinition(), null, 2)

  const doImport = () => {
    try {
      const currentId = toDefinition().id
      const parsed = normalizeFlowDefinition(JSON.parse(draft), currentId)
      // 这里是覆盖当前画布，不允许导入 JSON 的 id 覆盖流程库里的另一条记录。
      loadDefinition({ ...parsed, id: currentId })
      setErr('')
      onClose()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }

  return (
    <aside className="dock dock--wide">
      <div className="dock__head">
        <div className="tabs">
          <button className={tab === 'export' ? 'on' : ''} onClick={() => setTab('export')}>导出</button>
          <button className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')}>导入</button>
        </div>
        <i className="dock__sep" />
        {tab === 'export' && (
          <button className="btn btn--sm" onClick={() => navigator.clipboard?.writeText(json)}>复制</button>
        )}
        {tab === 'import' && <button className="btn btn--sm btn--primary" onClick={doImport}>载入</button>}
        <button className="iconbtn" onClick={onClose} title="收起面板"><Icon name="close" /></button>
      </div>

      {tab === 'export' ? (
        <>
          <div className="dock__note">
            逻辑（nodes / edges）与布局（layout）分开存，流程才能 diff、能 code review、能用 API 生成。
          </div>
          <pre className="drawer__code mono">{json}</pre>
        </>
      ) : (
        <>
          <div className="dock__note">粘贴一份流程定义 JSON 覆盖当前画布。</div>
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
    </aside>
  )
}
