import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KernelClient, PermissionRequest } from './kernel-client'

type Reply = 'once' | 'always' | 'reject'

export function usePermissions(client: KernelClient | null, directory: string | null, sessionID: string | null, autoApprove = false) {
  const context = useMemo(() => ({ client, directory, sessionID }), [client, directory, sessionID])
  const current = useRef(context)
  current.current = context
  const automatic = useRef(autoApprove)
  automatic.current = autoApprove
  const automaticOperations = useRef(new Map<string, typeof client>())
  const automaticFailures = useRef(new Set<string>())
  const [automaticRevision, setAutomaticRevision] = useState(0)
  const version = useRef(0)
  const operation = useRef<object | null>(null)
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const ctx = current.current
    if (!ctx.client || !ctx.directory) return
    const revision = ++version.current
    try {
      const result = await ctx.client.permission.list({ directory: ctx.directory }, { throwOnError: true })
      if (current.current !== ctx || revision !== version.current) return
      setRequests((result.data ?? []).filter(request => automatic.current || request.sessionID === ctx.sessionID))
    } catch (e) {
      if (current.current === ctx && revision === version.current) setError(`读取待授权请求失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  useEffect(() => {
    version.current++
    operation.current = null
    setRequests([])
    setBusy(false)
    setError(null)
    void reload()
    return () => { version.current++; operation.current = null }
  }, [context, reload])

  useEffect(() => {
    automaticOperations.current.clear()
    automaticFailures.current.clear()
  }, [client])

  useEffect(() => {
    automaticFailures.current.clear()
    if (autoApprove) void reload()
  }, [autoApprove, reload])

  useEffect(() => {
    if (!autoApprove || !client || !directory) return
    for (const request of requests) {
      if (automaticOperations.current.get(request.id) === client || automaticFailures.current.has(request.id)) continue
      automaticOperations.current.set(request.id, client)
      // Approve each request once; do not add permanent kernel rules, so turning
      // the preference off restores ordinary approval prompts immediately.
      void client.permission.reply({ directory, requestID: request.id, reply: 'once' }, { throwOnError: true }).then(() => {
        if (current.current.client !== client) return
        version.current++
        setRequests(previous => previous.filter(item => item.id !== request.id))
        // A completion may have invalidated a list fetched while approval was
        // in flight. Reconcile remaining requests, including background sessions.
        if (automatic.current) void reload()
      }).catch(e => {
        if (current.current.client !== client) return
        automaticFailures.current.add(request.id)
        setError(`自动授权失败：${e instanceof Error ? e.message : String(e)}`)
      }).finally(() => {
        if (automaticOperations.current.get(request.id) === client) automaticOperations.current.delete(request.id)
        if (current.current.client === client) setAutomaticRevision(previous => previous + 1)
      })
    }
  }, [autoApprove, client, directory, requests, automaticRevision, reload])

  const receive = useCallback((type: string, properties: any) => {
    if (!automatic.current && properties.sessionID !== current.current.sessionID) return
    if (type === 'permission.asked' && properties.id) {
      version.current++
      setRequests(previous => previous.some(request => request.id === properties.id) ? previous : [...previous, properties])
    } else if (type === 'permission.replied') {
      version.current++
      if (automaticFailures.current.delete(properties.requestID) && !automaticFailures.current.size) setError(null)
      setRequests(previous => previous.filter(request => request.id !== properties.requestID))
    }
  }, [])

  const reply = async (request: PermissionRequest, answer: Reply) => {
    const ctx = current.current
    if (!ctx.client || !ctx.directory || (!automatic.current && request.sessionID !== ctx.sessionID) || operation.current) return
    const op = {}
    operation.current = op
    setBusy(true)
    setError(null)
    try {
      await ctx.client.permission.reply({ directory: ctx.directory, requestID: request.id, reply: answer }, { throwOnError: true })
      if (current.current === ctx && operation.current === op) {
        version.current++
        automaticFailures.current.delete(request.id)
        setRequests(previous => previous.filter(item => item.id !== request.id))
      }
    } catch (e) {
      if (current.current === ctx && operation.current === op) setError(`提交授权失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (current.current === ctx && operation.current === op) { operation.current = null; setBusy(false) }
    }
  }

  const request = autoApprove ? requests.find(item => automaticFailures.current.has(item.id)) : requests.find(item => item.sessionID === sessionID)
  const dialog = request ? (
    <div className="hui-question-backdrop" role="presentation">
      <section className="hui-question-dialog glass" style={{ backdropFilter: 'blur(20px) saturate(150%)' }} role="dialog" aria-modal="true" aria-label="工具等待授权">
        <div className="hui-question-heading">工具等待授权</div>
        <div className="hui-question-body">
          <p className="text-sm mb-3">{request.permission === 'external_directory' ? '工具需要访问工作空间之外的目录，授权后才能继续执行。' : `工具需要权限：${request.permission}`}</p>
          <pre className="hui-code whitespace-pre-wrap break-all">{request.patterns.join('\n')}</pre>
          {typeof request.metadata.command === 'string' ? <pre className="hui-code mt-2 whitespace-pre-wrap break-all">{request.metadata.command}</pre> : null}
          {typeof request.metadata.filepath === 'string' ? <pre className="hui-code mt-2 whitespace-pre-wrap break-all">{request.metadata.filepath}</pre> : null}
          {request.always.length ? <p className="text-xs mt-3">“始终允许”的范围：{request.always.join('、')}</p> : null}
          {error ? <p className="text-sm text-rose-300 mt-3" role="alert">{error}</p> : null}
        </div>
        <div className="hui-question-actions">
          <button className="hui-question-cancel" disabled={busy} onClick={() => void reply(request, 'reject')}>拒绝</button>
          {request.always.length ? <button className="hui-question-cancel" disabled={busy} onClick={() => void reply(request, 'always')}>始终允许</button> : null}
          <button className="hui-question-submit" disabled={busy} onClick={() => void reply(request, 'once')}>{busy ? '提交中…' : '允许一次'}</button>
        </div>
      </section>
    </div>
  ) : error ? <div className="text-sm text-rose-300" role="alert">{error}<button onClick={() => void reload()}>重试授权查询</button></div> : null
  return { dialog, receive, reload }
}
