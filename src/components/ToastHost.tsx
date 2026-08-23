import { useEffect, useState } from 'react'
import { dismissToast, subscribeToasts, type Toast } from '../lib/toast'

export default function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => subscribeToasts(setToasts), [])
  if (toasts.length === 0) return null
  return (
    <div className="toasthost" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} className={`toast toast--${toast.tone}`} onClick={() => dismissToast(toast.id)}>
          {toast.text}
        </button>
      ))}
    </div>
  )
}
