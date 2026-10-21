import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ServerInfo } from '../../shared/kernel'
import type { KernelRequestDiagnostic } from './kernel-client'

const phases: Record<string, string> = { discovering: '正在查找内核', version: '正在检测版本', launching: '正在启动服务', checking: '正在验证接口', ready: '已连接', error: '连接失败', stopped: '内核未启动' }
export function connectionLabel(server: ServerInfo | null, loading: boolean, lost: boolean): string {
  if (server?.status === 'error') return '连接失败'
  if (server?.status === 'stopped') return '内核未启动'
  if (server?.status !== 'ready') return phases[server?.phase ?? 'discovering'] ?? '正在连接'
  if (lost) return '正在重连'
  return loading ? '正在加载工作空间' : '已连接'
}

export function ConnectionStatus({ server, loading, lost, issues, requests, card = false, notice = false }: { server: ServerInfo | null; loading: boolean; lost: boolean; issues: string[]; requests?: () => KernelRequestDiagnostic[]; card?: boolean; notice?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [action, setAction] = useState(false)
  const actionLock = useRef(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [lostAt, setLostAt] = useState<number | null>(null)
  useEffect(() => { setLostAt(lost ? Date.now() : null) }, [lost])
  const pending = server?.status === 'starting' || !server || (server.status === 'ready' && (loading || lost))
  useEffect(() => {
    if (!pending) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pending])
  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [expanded])
  const label = connectionLabel(server, loading, lost)
  const failed = server?.status === 'error' || server?.status === 'stopped'
  const elapsed = Math.max(0, Math.floor((now - (lostAt ?? server?.startedAt ?? now)) / 1000))
  const run = async (kind: 'restart' | 'choose' | 'auto') => {
    if (actionLock.current) return
    actionLock.current = true
    setAction(true); setError('')
    try {
      if (kind === 'restart') await window.api.restartServer()
      else if (kind === 'choose') await window.api.chooseKernel()
      else await window.api.resetKernel()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { actionLock.current = false; setAction(false) }
  }
  // Only diagnostic snapshots are serialized. Connection headers/passwords never enter this component.
  const report = JSON.stringify({ application: 'Huarnessy', server, workspaceIssues: issues, requests: requests?.() ?? [] }, null, 2)
  const controls = <div className="hui-connection-actions">
    <button type="button" disabled={action || server?.status === 'starting'} onClick={() => void run('restart')}>重试连接</button>
    <button type="button" disabled={action} onClick={() => void run('choose')}>选择内核</button>
    <button type="button" disabled={action} onClick={() => void run('auto')}>恢复自动选择</button>
  </div>
  return <>
    {card ? <section className="hui-connection-card" aria-label="内核连接状态" role={failed ? 'alert' : 'status'}>
      <h2>{label}{pending ? ` · ${elapsed} 秒` : ''}</h2>
      {server?.binary ? <p className="break-all text-xs text-white/60">{server.binary}{server.version ? ` · v${server.version}` : ''}</p> : null}
      {server?.error ? <p className="text-rose-200">{server.error}</p> : null}
      {server?.hint ? <p className="whitespace-pre-wrap text-xs text-white/60">{server.hint}</p> : null}
      {lost ? <p className="text-xs text-white/70">{elapsed >= 30 ? '连接持续中断，仍在自动重试。可查看诊断或手动重新连接。' : '与内核的事件连接已中断，正在自动重试。'}</p> : null}
      {issues.map(issue => <p className="text-xs text-amber-200" key={issue}>{issue}</p>)}
      {controls}<button className="hui-connection-detail-button" type="button" onClick={() => setExpanded(true)}>查看连接诊断</button>
      {error ? <p role="alert">{error}</p> : null}
    </section> : notice ? <><span>{elapsed >= 30 ? '与内核的连接持续中断，仍在自动重试。' : '与内核的连接中断，正在重连…'}</span><button type="button" className="underline" onClick={() => setExpanded(true)}>查看诊断</button></> : <button type="button" className="hui-connection-label no-drag" aria-label="连接状态与诊断" title="查看内核连接详情" onClick={() => setExpanded(true)}>
      {label}{server?.version ? ` · v${server.version}` : ''}{issues.length ? ' · 需要处理' : ''}
    </button>}
    {expanded ? createPortal(<div className="hui-connection-backdrop no-drag" role="presentation" onClick={() => setExpanded(false)}>
      <section className="hui-question-dialog glass hui-connection-diagnostics" role="dialog" aria-modal="true" aria-label="连接诊断" onClick={event => event.stopPropagation()} style={{ backdropFilter: 'blur(20px) saturate(150%)' }}>
        <div className="hui-question-heading"><span>连接诊断 · {label}</span><button type="button" autoFocus onClick={() => setExpanded(false)} aria-label="关闭连接诊断">关闭</button></div>
        <div className="hui-question-body">
          {server?.error ? <p className="mb-3 text-rose-200" role="alert">{server.error}</p> : null}
          {controls}
          {error ? <p role="alert" className="text-rose-200">{error}</p> : null}
          <pre className="hui-code mt-3 whitespace-pre-wrap break-all text-xs" aria-label="诊断报告">{report}</pre>
        </div>
        <div className="hui-question-actions"><button type="button" className="hui-question-submit" onClick={() => {
          void navigator.clipboard.writeText(report).then(() => setCopied(true)).catch(e => setError(`复制失败：${String(e)}`))
        }}>{copied ? '已复制诊断' : '复制诊断报告'}</button></div>
      </section>
    </div>, document.body) : null}
  </>
}
