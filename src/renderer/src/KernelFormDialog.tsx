import { useState } from 'react'
import type { QuestionRequest } from './kernel-client'

export type FormAnswer = Record<string, string | number | boolean | readonly string[]>
type Form = NonNullable<QuestionRequest['form']>
export function formFieldActive(field: Form['fields'][number], answer: FormAnswer): boolean {
  return !('when' in field) || !field.when || field.when.every(condition => {
    const value = answer[condition.key]
    if (value === undefined) return false
    const equal = Array.isArray(value) ? value.includes(condition.value) : value === condition.value
    return condition.op === 'eq' ? equal : !equal
  })
}
export function KernelFormDialog({ form, busy, onReply, onReject }: { form: Form; busy: boolean; onReply(answer: FormAnswer): void; onReject(): void }) {
  const [answer, setAnswer] = useState<FormAnswer>(() => Object.fromEntries(form.fields.flatMap(f => 'default' in f && f.default !== undefined ? [[f.key, f.default]] : f.type === 'boolean' ? [[f.key, false]] : [])))
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const value = (key: string, next: FormAnswer[string] | undefined) => setAnswer(old => { const result = { ...old }; if (next === undefined) delete result[key]; else result[key] = next; return result })
  // Conditions only see earlier active fields, never stale answers from a field that became hidden.
  const effective: FormAnswer = {}
  for (const f of form.fields) if (formFieldActive(f, effective) && answer[f.key] !== undefined) effective[f.key] = answer[f.key]
  const visible = form.fields.filter(f => !('hidden' in f && f.hidden) && formFieldActive(f, effective))
  return <div className="hui-question-backdrop" role="presentation">
    <form className="hui-question-dialog glass" role="dialog" aria-modal="true" aria-label="需要回答的表单" style={{ backdropFilter: 'blur(20px) saturate(150%)' }} onSubmit={event => {
      event.preventDefault()
      const next: FormAnswer = {}
      for (const f of form.fields) {
        if (!formFieldActive(f, effective) || f.type === 'external') continue
        let v = effective[f.key]
        if (f.type === 'multiselect' && custom[f.key]?.trim()) v = [...new Set([...(Array.isArray(v) ? v : []), custom[f.key].trim()])]
        if (f.type === 'multiselect') {
          const size = Array.isArray(v) ? v.length : 0
          if (size < (f.minItems ?? (f.required ? 1 : 0)) || (f.maxItems !== undefined && size > f.maxItems)) { setError(`${f.title ?? f.key}：请选择规定数量的选项`); return }
        }
        if (v !== undefined) next[f.key] = v
      }
      setError(''); onReply(next)
    }}>
      <div className="hui-question-heading">{form.title}</div>
      <div className="hui-question-body">
        {visible.map(f => <fieldset key={f.key} className="hui-question-field" disabled={busy}>
          <legend>{f.title ?? f.key}{'required' in f && f.required ? ' *' : ''}</legend>
          {f.description ? <p className="mb-2 text-xs text-white/60">{f.description}</p> : null}
          {f.type === 'external' ? (/^https?:\/\//i.test(f.url) ? <a href={f.url} target="_blank" rel="noreferrer" className="text-cyan-200 underline">打开外部页面完成此步骤</a> : <p role="alert">不支持的外部页面地址</p>)
            : f.type === 'boolean' ? <label><input type="checkbox" checked={answer[f.key] === true} onChange={e => value(f.key, e.target.checked)} /> {f.title ?? f.key}</label>
            : f.type === 'multiselect' ? <>
              {f.options.map(option => <label key={option.value} className="block py-1"><input type="checkbox" checked={Array.isArray(answer[f.key]) && (answer[f.key] as string[]).includes(option.value)} onChange={e => {
                const old = Array.isArray(answer[f.key]) ? answer[f.key] as string[] : []
                value(f.key, e.target.checked ? [...old, option.value] : old.filter(v => v !== option.value))
              }} /> {option.label}{option.description ? <small className="ml-2 text-white/50">{option.description}</small> : null}</label>)}
              {f.custom ? <input className="hui-question-custom" aria-label={`${f.title ?? f.key} 自定义`} value={custom[f.key] ?? ''} onChange={e => setCustom(old => ({ ...old, [f.key]: e.target.value }))} /> : null}
            </>
            : f.type === 'string' && f.options && !f.custom ? <select className="hui-question-custom" aria-label={f.title ?? f.key} required={f.required} value={String(answer[f.key] ?? '')} onChange={e => value(f.key, e.target.value)}>
              <option value="">请选择…</option>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            : f.type === 'string' ? <>
              <input className="hui-question-custom" aria-label={f.title ?? f.key} type={f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : f.format === 'date' ? 'date' : f.format === 'date-time' ? 'datetime-local' : 'text'} required={f.required} minLength={f.minLength} maxLength={f.maxLength} pattern={f.pattern} placeholder={f.placeholder} value={String(answer[f.key] ?? '')} onChange={e => value(f.key, e.target.value)} list={f.options ? `form-${form.id}-${f.key}` : undefined} />
              {f.options ? <datalist id={`form-${form.id}-${f.key}`}>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist> : null}
            </>
            : <input className="hui-question-custom" aria-label={f.title ?? f.key} type="number" required={f.required} min={f.minimum} max={f.maximum} step={f.type === 'integer' ? 1 : 'any'} value={String(answer[f.key] ?? '')} onChange={e => value(f.key, e.target.value === '' ? undefined : Number(e.target.value))} />}
        </fieldset>)}
        {error ? <p role="alert" className="text-rose-300">{error}</p> : null}
      </div>
      <div className="hui-question-actions"><button type="button" className="hui-question-cancel" disabled={busy} onClick={onReject}>拒绝回答</button>
        {visible.some(f => f.type !== 'external') ? <button type="submit" className="hui-question-submit" disabled={busy}>{busy ? '提交中…' : '提交回答'}</button> : null}
      </div>
    </form>
  </div>
}
