import { useEffect } from 'react'
import { groupedShortcuts } from '../lib/shortcuts'
import Icon from './Icon'

/**
 * 快捷键表。按 ? 打开（非输入态），Esc 或点遮罩关闭。
 * 内容来自 lib/shortcuts.ts 那一张表 —— 这里不写死任何按键。
 */
export default function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet__mask" onClick={onClose} role="dialog" aria-label="快捷键">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <b>快捷键</b>
          <button className="iconbtn" onClick={onClose} title="关闭（Esc）"><Icon name="close" /></button>
        </div>
        <div className="sheet__cols">
          {groupedShortcuts().map((g) => (
            <section key={g.scope}>
              <h4>{g.scope}</h4>
              {g.items.map((s) => (
                <div className="sheet__row" key={s.label}>
                  <span className="sheet__keys">{s.keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>
                  <span>{s.label}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
