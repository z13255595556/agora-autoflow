/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 节点服务地址，缺省 http://localhost:8787 */
  readonly VITE_SQL_SERVICE?: string
  readonly VITE_PUBLIC_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.json' {
  const value: {
    year: number
    papers?: string[]
    days: Array<{ date: string; name?: string; isOffDay: boolean }>
  }
  export default value
}
