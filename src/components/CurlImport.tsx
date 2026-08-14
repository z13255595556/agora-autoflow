import { useState } from 'react'
import { parseCurl } from '../lib/curlImport'
import Icon from './Icon'

export default function CurlImport({
  onChange,
  variant = 'inline',
}: {
  onChange: (key: string, value: unknown) => void
  variant?: 'inline' | 'modal'
}) {
  const [open, setOpen] = useState(false)
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')

  const apply = () => {
    try {
      const result = parseCurl(command)
      for (const [key, value] of Object.entries(result)) onChange(key, value)
      setError('')
      setOpen(false)
      setCommand('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={`curlimport curlimport--${variant}`}>
      <button className="curlimport__toggle" onClick={() => setOpen((value) => !value)}>
        <Icon name="import" size={13} />
        导入 cURL
      </button>
      {open && (
        <div className={variant === 'modal' ? 'httpform__backdrop' : undefined} onClick={() => variant === 'modal' && setOpen(false)}>
          <div className="curlimport__panel" role={variant === 'modal' ? 'dialog' : undefined} aria-modal={variant === 'modal' || undefined} onClick={(event) => event.stopPropagation()}>
            {variant === 'modal' && (
              <div className="httpform__modalhead">
                <strong>导入 cURL</strong>
                <button className="iconbtn" title="关闭" onClick={() => setOpen(false)}><Icon name="close" /></button>
              </div>
            )}
            <textarea
              className="mono"
              rows={7}
              autoFocus
              spellCheck={false}
              value={command}
              placeholder="curl -X POST https://api.example.com/..."
              onChange={(event) => { setCommand(event.target.value); setError('') }}
            />
            {error && <div className="field__errors" role="alert">{error}</div>}
            <div className="httpform__modalfoot">
              <button className="btn" onClick={() => setOpen(false)}>取消</button>
              <button className="btn btn--primary" disabled={!command.trim()} onClick={apply}>导入配置</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
