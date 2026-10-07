module.exports = async () => {
  const passed = []
  const waitFor = async predicate => {
    const start = performance.now()
    while (!predicate()) {
      if (performance.now() - start > 5000) throw new Error('Permission regression timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const check = (ok, label) => { if (!ok) throw new Error(label); passed.push(label) }
  const select = title => Array.from(document.querySelectorAll('aside button')).find(button => button.title === title).click()
  const dialog = () => document.querySelector('[aria-label="工具等待授权"]')
  const click = text => Array.from(dialog().querySelectorAll('button')).find(button => button.textContent === text).click()
  const request = (id, sessionID = 'benchmark-session') => ({ id, sessionID, permission: 'external_directory', patterns: ['C:\\Temp\\*'], always: ['C:\\Temp\\*'], metadata: { filepath: 'C:\\Temp\\stream2.log' } })
  const ask = r => { window.benchPermissions.push(r); window.benchEmit('permission.asked', r) }
  // Read requests have filepath metadata, not a Bash command. Recover one
  // already waiting before opening the session, as in the real incident.
  select('Other session')
  await new Promise(resolve => setTimeout(resolve, 80))
  window.benchPermissions = [request('permission-read')]
  select('Streaming benchmark')
  await waitFor(dialog)
  check(dialog().textContent.includes('C:\\Temp\\stream2.log'), 'opening a session recovers a pending Read permission and shows its file via REST')
  click('允许一次')
  await waitFor(() => !dialog())
  check(window.benchRequests.some(r => r.path === '/permission/permission-read/reply' && r.body.reply === 'once' && r.directory === window.benchWorkspace), 'one-time approval carries the active workspace')
  for (const [id, button, answer] of [['always', '始终允许', 'always'], ['reject', '拒绝', 'reject']]) {
    ask(request(id))
    await waitFor(dialog)
    if (id === 'always') {
      window.benchPermissionFailure = true
      click(button)
      await waitFor(() => dialog()?.querySelector('[role="alert"]'))
      check(!!dialog(), 'failed approval shows an error and permits retry')
      window.benchPermissionFailure = false
    }
    click(button)
    await waitFor(() => !dialog())
    check(window.benchRequests.some(r => r.path === `/permission/${id}/reply` && r.body.reply === answer), `${answer} reply reaches the kernel`)
  }
  ask(request('late'))
  await waitFor(dialog)
  window.benchHoldPermission = true
  click('允许一次')
  await waitFor(() => !!window.benchReleasePermission)
  select('Other session')
  await waitFor(() => !dialog())
  ask(request('other', 'other-session'))
  await waitFor(dialog)
  window.benchHoldPermission = false
  window.benchReleasePermission()
  await new Promise(resolve => setTimeout(resolve, 60))
  check(!!dialog() && !dialog().querySelector('.hui-question-submit').disabled, 'late approval cannot clear or disable another session prompt')
  window.benchEmit('permission.replied', { sessionID: 'other-session', requestID: 'other', reply: 'reject' })
  window.benchPermissions = []
  await waitFor(() => !dialog())
  check(!dialog(), 'external approval removes the prompt over SSE')
  select('Streaming benchmark')
  await new Promise(resolve => setTimeout(resolve, 80))
  if (!document.querySelector('[aria-label="默认无限权限"]')) document.querySelector('[aria-label="外观设置"]').click()
  await waitFor(() => !!document.querySelector('[aria-label="默认无限权限"]'))
  const toggle = () => document.querySelector('[aria-label="默认无限权限"]')
  check(!toggle().checked, 'unlimited permissions defaults to off')
  check(getComputedStyle(toggle().closest('.hui-unlimited-permissions')).color === 'rgb(250, 204, 21)', 'the unlimited permission setting is highlighted in yellow')
  window.benchPermissions = [request('auto-existing'), request('auto-background', 'other-session')]
  toggle().click()
  await waitFor(() => window.benchRequests.some(r => r.path === '/permission/auto-existing/reply') && window.benchRequests.some(r => r.path === '/permission/auto-background/reply'))
  check(!dialog() && localStorage.getItem('hui.unlimitedPermissions') === 'true', 'enabling persists the preference and approves existing and background requests without a dialog')
  ask({ ...request('auto-command'), permission: 'bash', metadata: { command: 'echo test' } })
  await waitFor(() => window.benchRequests.some(r => r.path === '/permission/auto-command/reply'))
  const autoReplies = window.benchRequests.filter(r => r.path.startsWith('/permission/auto-') && r.path.endsWith('/reply'))
  check(autoReplies.every(r => r.body.reply === 'once' && r.directory === window.benchWorkspace), 'automatic approvals handle all permission types without permanently changing kernel rules')
  window.benchPermissionFailure = true
  ask(request('auto-failure'))
  await waitFor(() => dialog()?.textContent.includes('自动授权失败'))
  const attempts = window.benchRequests.filter(r => r.path === '/permission/auto-failure/reply').length
  await new Promise(resolve => setTimeout(resolve, 120))
  check(window.benchRequests.filter(r => r.path === '/permission/auto-failure/reply').length === attempts, 'failed automatic approval offers manual retry without a retry loop')
  window.benchPermissionFailure = false
  click('允许一次')
  await waitFor(() => !dialog())
  window.benchHoldPermission = true
  window.benchReleasePermission = null
  ask(request('auto-inflight'))
  await waitFor(() => !!window.benchReleasePermission)
  window.benchEmit('permission.asked', request('auto-inflight'))
  await new Promise(resolve => setTimeout(resolve, 60))
  check(window.benchRequests.filter(r => r.path === '/permission/auto-inflight/reply').length === 1, 'duplicate SSE requests do not submit duplicate automatic approvals')
  toggle().click()
  await waitFor(() => localStorage.getItem('hui.unlimitedPermissions') === 'false')
  ask(request('manual-again'))
  await waitFor(dialog)
  check(!window.benchRequests.some(r => r.path === '/permission/manual-again/reply'), 'turning the setting off restores manual approval for the next request')
  window.benchHoldPermission = false
  window.benchReleasePermission()
  await new Promise(resolve => setTimeout(resolve, 60))
  check(!!dialog(), 'a late automatic approval after disabling cannot clear a new manual prompt')
  click('拒绝')
  await waitFor(() => !dialog())
  if (document.querySelector('[aria-label="默认无限权限"]')) document.querySelector('[aria-label="外观设置"]').click()
  return passed
}
