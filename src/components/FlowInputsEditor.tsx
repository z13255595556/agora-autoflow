import { useFlow } from '../store'
import type { FlowInputField } from '../types'

type FlowInputsEditorProps = {
  context?: 'flow' | 'webhook'
}

/** Edit the workflow's shared inputs wherever users encounter an input boundary. */
export default function FlowInputsEditor({ context = 'flow' }: FlowInputsEditorProps) {
  const flowInputs = useFlow((s) => s.flowInputs)
  const addFlowInput = useFlow((s) => s.addFlowInput)
  const updateFlowInput = useFlow((s) => s.updateFlowInput)
  const removeFlowInput = useFlow((s) => s.removeFlowInput)
  const setRunPanelOpen = useFlow((s) => s.setRunPanelOpen)
  const webhook = context === 'webhook'

  return (
    <>
      {flowInputs.map((field, index) => (
        <div className="inputrow" key={index}>
          <input
            className="mono"
            value={field.key}
            placeholder="参数名"
            aria-label={`第 ${index + 1} 个入参的参数名`}
            onChange={(event) => updateFlowInput(index, { key: event.target.value })}
          />
          <input
            value={field.title}
            placeholder="显示名"
            aria-label={`第 ${index + 1} 个入参的显示名`}
            onChange={(event) => updateFlowInput(index, { title: event.target.value })}
          />
          <select
            value={field.type}
            aria-label={`第 ${index + 1} 个入参的类型`}
            onChange={(event) => updateFlowInput(index, { type: event.target.value as FlowInputField['type'] })}
          >
            <option value="string">文本</option>
            <option value="integer">整数</option>
            <option value="boolean">布尔</option>
          </select>
          <label className="inputrow__req" title="必填">
            <input
              type="checkbox"
              checked={field.required}
              onChange={(event) => updateFlowInput(index, { required: event.target.checked })}
            />
            必填
          </label>
          <button onClick={() => removeFlowInput(index)} title="删除入参" aria-label={`删除第 ${index + 1} 个入参`}>×</button>
        </div>
      ))}

      {flowInputs.length === 0 && (
        <div className="empty">
          {webhook
            ? '还没有入参。添加后，POST body 顶层的同名字段会自动传入流程。'
            : '还没有入参。入参用于每次运行时传入不同的值；固定值可以直接写在节点配置里。'}
        </div>
      )}

      <button className="kv__add" onClick={addFlowInput}>+ 添加入参</button>

      {webhook ? (
        <div className="inputs__where">
          <b>从请求 body 取值</b>
          <span>POST body 顶层字段名需要和参数名一致；未声明的字段会忽略，缺少必填项或类型不符会返回 400。</span>
        </div>
      ) : flowInputs.length > 0 ? (
        <div className="inputs__where">
          <b>值不在这里填</b>
          <span>
            这里只定义「有哪些参数」。具体的值每次运行前在底部
            <button className="linkbtn" onClick={() => setRunPanelOpen(true)}>手动运行</button>
            表单里填。
          </span>
          <span className="inputs__where-sub">
            SQL 里写 {'{{'}{flowInputs[0].key}{'}}'} 或 :{flowInputs[0].key}，运行时会自动代入。
          </span>
        </div>
      ) : null}
    </>
  )
}
