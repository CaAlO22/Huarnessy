module.exports = async () => {
  const passed = []
  const a = window.benchDefaultWorkspace, b = 'E:\\工作空间\\项目 B'
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async predicate => {
    const start = performance.now()
    while (!predicate()) {
      if (performance.now() - start > 5000) throw new Error('Workspace regression timed out')
      await wait(10)
    }
  }
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const row = title => Array.from(document.querySelectorAll('aside button')).find(button => button.title === title)
  const button = title => Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === title)
  const path = () => document.querySelector('[aria-label="当前工作空间"]')?.textContent
  const choose = async directory => {
    window.benchNextWorkspace = directory
    button('切换工作空间').click()
    await waitFor(() => path() === directory && !!button('切换工作空间') && !button('切换工作空间').disabled)
    await wait(50)
  }
  check(path() === a, 'sidebar shows the current workspace path')
  check(!row('Foreign workspace') && !row('Nested workspace'), 'sessions are isolated by the exact workspace directory')
  const oldSource = window.benchSource
  const beforeCancel = document.querySelector('.hui-md')?.textContent
  window.benchNextWorkspace = null
  button('切换工作空间').click()
  await wait(50)
  check(path() === a && window.benchSource === oldSource && document.querySelector('.hui-md')?.textContent === beforeCancel, 'canceling the folder picker preserves the current workspace and conversation')
  window.benchChoiceError = true
  button('切换工作空间').click()
  await waitFor(() => document.body.textContent.includes('切换工作空间失败'))
  check(path() === a && !oldSource.closed, 'folder-picker failure preserves the current connection')
  window.benchChoiceError = false

  window.benchHoldList = a
  window.benchEmit('session.updated', { info: { id: 'benchmark-session', directory: a } })
  await waitFor(() => !!window.benchReleaseList)
  window.benchMessages['foreign-session'] = [{ info: { id: 'b-message', sessionID: 'foreign-session', role: 'assistant' }, parts: [{ id: 'b-part', messageID: 'b-message', sessionID: 'foreign-session', type: 'text', text: '工作空间 B 的历史记录', time: { end: 1 } }] }]
  await choose(b)
  await waitFor(() => !!row('Foreign workspace'))
  check(oldSource.closed && !row('Streaming benchmark') && !document.querySelector('.hui-md'), 'switching closes the old SSE connection and clears its messages')
  check(new URL(window.benchSource.url).searchParams.get('directory') === b, 'SSE reconnects with the chosen directory')
  row('Foreign workspace').click()
  await waitFor(() => document.querySelector('.hui-md')?.textContent === '工作空间 B 的历史记录')
  check(!!window.benchRequests.find(request => request.path === '/session/foreign-session/message' && request.directory === b), 'history requests use the selected workspace')
  window.benchHoldList = null
  window.benchReleaseList()
  const late = { type: 'message.part.delta', properties: { sessionID: 'foreign-session', messageID: 'b-message', partID: 'b-part', field: 'text', delta: '串入内容' } }
  oldSource.onmessage({ data: JSON.stringify(late) })
  window.benchSource.onmessage({ data: JSON.stringify({ directory: a, payload: late }) })
  window.benchEmit('session.deleted', { info: { id: 'foreign-session', directory: a } })
  await wait(100)
  check(!row('Streaming benchmark') && row('Foreign workspace') && document.querySelector('.hui-md')?.textContent === '工作空间 B 的历史记录', 'late requests and foreign workspace events cannot overwrite the current workspace')

  button('+ 新建会话').click()
  await waitFor(() => !!row('New Session') && row('New Session').classList.contains('glass-soft'))
  const created = window.benchSessions.find(session => session.title === 'New Session' && session.directory === b)
  check(!!created, 'new sessions are created in the selected directory')
  const textarea = document.querySelector('textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '只在工作空间 B 发送')
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => button('发送') && !button('发送').disabled)
  button('发送').click()
  await waitFor(() => window.benchRequests.some(request => request.path === `/session/${created.id}/prompt_async`))
  check(window.benchRequests.find(request => request.path === `/session/${created.id}/prompt_async`).directory === b, 'model prompts carry the selected directory')
  await waitFor(() => !!button('停止'))
  button('停止').click()
  await waitFor(() => window.benchRequests.some(request => request.path === `/session/${created.id}/abort`))
  check(window.benchRequests.find(request => request.path === `/session/${created.id}/abort`).directory === b, 'abort requests carry the selected directory')
  window.benchEmit('session.idle', { sessionID: created.id })
  await waitFor(() => !!button('发送'))
  row('New Session').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 }))
  await waitFor(() => !!document.querySelector('[role="menu"]'))
  document.querySelector('[role="menuitem"]').click()
  await waitFor(() => !row('New Session'))
  check(window.benchRequests.find(request => request.method === 'DELETE' && request.path === `/session/${created.id}`).directory === b, 'deletion requests carry the selected directory')

  await choose(a)
  await waitFor(() => !!row('Streaming benchmark'))
  window.benchHoldMessages = 'benchmark-session'
  window.benchMessages['benchmark-session'] = [{ info: { id: 'late-history', sessionID: 'benchmark-session', role: 'assistant' }, parts: [{ id: 'late-history-part', messageID: 'late-history', type: 'text', text: '迟到的 A 历史记录' }] }]
  row('Streaming benchmark').click()
  await waitFor(() => !!window.benchReleaseMessages)
  await choose(b)
  window.benchHoldMessages = null
  window.benchReleaseMessages()
  await wait(100)
  check(!document.querySelector('.hui-md'), 'a pending history response from the previous workspace is discarded')

  await choose(a)
  await waitFor(() => !!row('Streaming benchmark'))
  window.benchHoldCreate = a
  button('+ 新建会话').click()
  await waitFor(() => !!window.benchReleaseCreate)
  await choose(b)
  window.benchHoldCreate = null
  window.benchReleaseCreate()
  await wait(100)
  check(!row('New Session') && !document.querySelector('.hui-md'), 'a pending session creation cannot select a session in another workspace')
  check(window.benchRequests.filter(request => request.path.startsWith('/session')).every(request => request.directory === a || request.directory === b), 'all session requests explicitly identify their workspace')

  await choose(a)
  await waitFor(() => !!row('Streaming benchmark'))
  window.benchMessages['benchmark-session'] = []
  row('Streaming benchmark').click()
  await wait(100)
  check(!row('Foreign workspace') && path() === a, 'returning to a workspace restores only its session list')
  return passed
}
