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
        <div className="inputdef" key={index}>
          <div className="inputrow">
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
              <option value="number">小数</option>
              <option value="boolean">是/否</option>
              <option value="date">日期</option>
              <option value="select">下拉</option>
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
          {/* 第二行：默认值 / 说明（/ 下拉选项）。默认值存原始文本，运行时按种类转换 */}
          <div className="inputrow inputrow--sub">
            {field.type === 'select' ? (
              <input
                value={(field.options ?? []).join(', ')}
                placeholder="选项，逗号分隔：hive, doris"
                aria-label={`第 ${index + 1} 个入参的选项`}
                onChange={(event) => updateFlowInput(index, { options: event.target.value.split(/[,，]/).map((o) => o.trim()).filter(Boolean) })}
              />
            ) : null}
            {field.type === 'boolean' ? (
              <select
                value={field.default ?? ''}
                aria-label={`第 ${index + 1} 个入参的默认值`}
                onChange={(event) => updateFlowInput(index, { default: event.target.value || undefined })}
              >
                <option value="">默认值：不填</option>
                <option value="true">默认值：是</option>
                <option value="false">默认值：否</option>
              </select>
            ) : field.type === 'select' ? (
              <select
                value={field.default ?? ''}
                aria-label={`第 ${index + 1} 个入参的默认值`}
                onChange={(event) => updateFlowInput(index, { default: event.target.value || undefined })}
              >
                <option value="">默认值：不填</option>
                {(field.options ?? []).map((o) => <option key={o} value={o}>默认值：{o}</option>)}
              </select>
            ) : (
              <input
                type={field.type === 'date' ? 'date' : field.type === 'integer' || field.type === 'number' ? 'number' : 'text'}
                step={field.type === 'number' ? 'any' : undefined}
                value={field.default ?? ''}
                placeholder="默认值"
                aria-label={`第 ${index + 1} 个入参的默认值`}
                onChange={(event) => updateFlowInput(index, { default: event.target.value || undefined })}
              />
            )}
            <input
              value={field.description ?? ''}
              placeholder="说明（填表单的人会看到）"
              aria-label={`第 ${index + 1} 个入参的说明`}
              onChange={(event) => updateFlowInput(index, { description: event.target.value || undefined })}
            />
          </div>
        </div>
      ))}

      {flowInputs.length === 0 && (
        <div className="empty">
          {webhook
            ? '添加后，POST body 同名字段自动传入。'
            : '还没有入参。'}
        </div>
      )}

      <button className="kv__add" onClick={addFlowInput}>+ 添加入参</button>

      {webhook ? (
        <div className="inputs__where">
          <b>从请求 body 取值</b>
          <span>顶层字段名须与参数名一致；未声明忽略，缺必填或类型不符返回 400。</span>
        </div>
      ) : flowInputs.length > 0 ? (
        <div className="inputs__where">
          <b>值不在这里填</b>
          <span>
            这里只定义参数，具体的值每次运行前在底部
            <button className="linkbtn" onClick={() => setRunPanelOpen(true)}>手动运行</button>
            表单里填。
          </span>
        </div>
      ) : null}
    </>
  )
}
