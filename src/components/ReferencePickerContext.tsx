import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { JsonType } from '../lib/outputShape'
import DataReferenceDrawer from './DataReferenceDrawer'

export interface ReferenceTarget {
  nodeId: string
  query: string
  mixed: boolean
  expectedType?: JsonType
  initialExpression?: string
  replace: (snippet: string) => void
}

interface PickerApi {
  request: ReferenceTarget | null
  open: (target: ReferenceTarget) => void
  close: () => void
}

const ReferencePickerContext = createContext<PickerApi | null>(null)

export function ReferencePickerProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ReferenceTarget | null>(null)
  const open = useCallback((target: ReferenceTarget) => setRequest(target), [])
  const close = useCallback(() => setRequest(null), [])
  const api = useMemo(() => ({ request, open, close }), [request, open, close])

  return (
    <ReferencePickerContext.Provider value={api}>
      {children}
      <DataReferenceDrawer request={request} onClose={close} />
    </ReferencePickerContext.Provider>
  )
}

export function useReferencePicker(): PickerApi | null {
  return useContext(ReferencePickerContext)
}
