import { useState } from 'react'
import type { JsonSchema } from '../types'
import CurlImport from './CurlImport'
import Icon from './Icon'
import SchemaForm, { type SchemaFormProps } from './SchemaForm'

const AUTH_KEYS = ['authType', 'bearerToken', 'basicUsername', 'basicPassword', 'authHeaderName', 'authHeaderValue']

function subsection(schema: JsonSchema, keys: string[]): JsonSchema {
  const allowed = new Set(keys)
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(schema.properties ?? {}).filter(([key]) => allowed.has(key)),
    ),
    required: (schema.required ?? []).filter((key) => allowed.has(key)),
  }
}

function SectionForm({ keys, className = '', ...props }: SchemaFormProps & { keys: string[]; className?: string }) {
  const schema = subsection(props.schema, keys)
  return (
    <div className={className}>
      <SchemaForm {...props} schema={schema} required={schema.required ?? []} showCurlImport={false} />
    </div>
  )
}

function valueOrDefault(props: SchemaFormProps, key: string): unknown {
  return props.values[key] ?? props.schema.properties?.[key]?.default
}

export default function HttpRequestForm(props: SchemaFormProps) {
  const [authOpen, setAuthOpen] = useState(false)
  const authType = String(valueOrDefault(props, 'authType') ?? 'none')
  const verifySsl = Boolean(valueOrDefault(props, 'verifySsl'))
  const allowHttpErrors = Boolean(valueOrDefault(props, 'allowHttpErrors'))
  const retryEnabled = Boolean(valueOrDefault(props, 'retryEnabled'))
  const timeoutMs = Number(valueOrDefault(props, 'timeoutMs') ?? 30000)
  const authLabel = authType === 'bearer'
    ? 'Bearer Token'
    : authType === 'basic'
      ? 'Basic Auth'
      : authType === 'header'
        ? '自定义请求头'
        : '无'

  return (
    <div className="httpform">
      <section className="httpform__section httpform__section--api">
        <div className="httpform__sectionhead">
          <span>API <b>*</b></span>
          <div className="httpform__ops">
            <button data-field-keys={AUTH_KEYS.join(' ')} onClick={() => setAuthOpen(true)}>
              <Icon name="settings" size={13} />认证 <strong>{authLabel}</strong>
            </button>
            <CurlImport variant="modal" onChange={props.onChange} />
          </div>
        </div>
        <SectionForm {...props} keys={['method', 'url']} className="httpform__api-fields" />
      </section>

      <section className="httpform__section httpform__section--flat">
        <div className="httpform__sectionhead"><span>请求头</span></div>
        <SectionForm {...props} keys={['headers']} />
      </section>

      <section className="httpform__section httpform__section--flat">
        <div className="httpform__sectionhead"><span>查询参数</span></div>
        <SectionForm {...props} keys={['query']} />
      </section>

      <section className="httpform__section httpform__section--flat httpform__section--body">
        <div className="httpform__sectionhead"><span>Body</span></div>
        <SectionForm {...props} keys={['bodyType', 'body', 'formBody']} />
      </section>

      <section className="httpform__toggleline">
        <div><strong>校验 SSL 证书</strong><small>关闭后允许调用使用自签名证书的服务</small></div>
        <label className="switch"><input type="checkbox" checked={verifySsl} onChange={(event) => props.onChange('verifySsl', event.target.checked)} /><span>{verifySsl ? '开' : '关'}</span></label>
      </section>

      <section className="httpform__toggleline">
        <div><strong>接受错误状态码</strong><small>4xx / 5xx 仍作为正常输出交给下游</small></div>
        <label className="switch"><input type="checkbox" checked={allowHttpErrors} onChange={(event) => props.onChange('allowHttpErrors', event.target.checked)} /><span>{allowHttpErrors ? '开' : '关'}</span></label>
      </section>

      <details className="httpform__advanced">
        <summary><span>超时设置</span><em>{Math.round(timeoutMs / 100) / 10}s</em></summary>
        <SectionForm {...props} keys={['timeoutMs', 'connectTimeoutMs', 'readTimeoutMs']} />
      </details>

      <details className="httpform__advanced">
        <summary><span>失败重试</span><em>{retryEnabled ? `开启 · ${Number(valueOrDefault(props, 'maxRetries') ?? 2)} 次` : '关闭'}</em></summary>
        <SectionForm {...props} keys={['retryEnabled', 'maxRetries', 'retryIntervalMs']} />
      </details>

      <section className="httpform__outputs">
        <div className="httpform__sectionhead"><span>输出变量</span></div>
        <div><code>body</code><span>响应体</span><em>any</em></div>
        <div><code>status</code><span>状态码</span><em>number</em></div>
        <div><code>headers</code><span>响应头</span><em>object</em></div>
        <div><code>url</code><span>最终 URL</span><em>string</em></div>
        <div><code>attempts</code><span>请求尝试次数</span><em>number</em></div>
      </section>

      {authOpen && (
        <div className="httpform__backdrop" onClick={() => setAuthOpen(false)}>
          <div className="httpform__modal" role="dialog" aria-modal="true" aria-label="HTTP 认证" onClick={(event) => event.stopPropagation()}>
            <div className="httpform__modalhead">
              <strong>认证</strong>
              <button className="iconbtn" title="关闭" onClick={() => setAuthOpen(false)}><Icon name="close" /></button>
            </div>
            <SectionForm {...props} keys={AUTH_KEYS} />
            <div className="httpform__modalfoot"><button className="btn btn--primary" onClick={() => setAuthOpen(false)}>完成</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
