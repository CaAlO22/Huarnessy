module.exports = async () => {
  const passed = []
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async predicate => {
    const start = performance.now()
    while (!predicate()) {
      if (performance.now() - start > 4000) throw new Error('Message actions timed out')
      await wait(10)
    }
  }
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const sessionID = 'message-actions-session'
  const text = (id, role, content) => ({
    info: { id, sessionID, role },
    parts: [{ id: `${id}-part`, messageID: id, sessionID, type: 'text', text: content }]
  })
  window.benchMessages[sessionID] = [
    text('actions-user-one', 'user', '第一轮 **原文**'),
    text('actions-answer-one', 'assistant', '第一轮回复'),
    text('actions-user-two', 'user', '第二轮原文'),
    text('actions-answer-two', 'assistant', '第二轮回复')
  ]
  window.benchSessions.push({ id: sessionID, title: 'Message actions', directory: window.benchWorkspace })
  window.benchSessions.push({ id: 'message-actions-other', title: 'Message actions other', directory: window.benchWorkspace })
  window.benchEmit('session.created', { info: window.benchSessions.at(-1) })
  await waitFor(() => !!Array.from(document.querySelectorAll('button')).find(button => button.title === 'Message actions'))
  Array.from(document.querySelectorAll('button')).find(button => button.title === 'Message actions').click()
  await waitFor(() => document.querySelectorAll('.hui-user-actions').length === 2)
  const actions = () => Array.from(document.querySelectorAll('.hui-user-actions'))
  actions()[0].querySelector('[aria-label="复制消息"]').click()
  await waitFor(() => window.benchClipboard === '第一轮 **原文**')
  await waitFor(() => actions()[0].textContent.includes('已复制'))
  check(actions()[0].textContent.includes('已复制') && window.benchClipboard === '第一轮 **原文**', 'copy keeps the original Markdown source')

  window.benchRevertFailure = true
  actions()[0].querySelector('[aria-label="撤回消息"]').click()
  await waitFor(() => document.body.textContent.includes('撤回失败'))
  check(actions().length === 2 && !document.querySelector('.hui-revert-notice'), 'failed revert keeps the conversation visible')
  window.benchRevertFailure = false

  actions()[0].querySelector('[aria-label="撤回消息"]').click()
  await waitFor(() => !!document.querySelector('.hui-revert-notice'))
  check(actions().length === 0 && document.querySelector('.hui-revert-notice').textContent.includes('已撤回 2 轮'), 'reverting an earlier user turn hides it and all following turns')
  const request = window.benchRequests.filter(item => item.path === `/session/${sessionID}/revert`).at(-1)
  check(request?.body?.messageID === 'actions-user-one' && request.directory === window.benchWorkspace, 'revert uses the selected message and current workspace')

  Array.from(document.querySelectorAll('button')).find(button => button.title === 'Message actions other').click()
  await waitFor(() => !document.querySelector('.hui-revert-notice'))
  Array.from(document.querySelectorAll('button')).find(button => button.title === 'Message actions').click()
  await waitFor(() => !!document.querySelector('.hui-revert-notice'))
  check(actions().length === 0, 'reverted turns stay hidden when reopening the session')
  await waitFor(() => !document.querySelector('.hui-revert-notice button').disabled)
  document.querySelector('.hui-revert-notice button').click()
  await waitFor(() => actions().length === 2)
  check(!document.querySelector('.hui-revert-notice') && window.benchRequests.some(item => item.path === `/session/${sessionID}/unrevert`), 'restore brings back the conversation through the kernel')
  await waitFor(() => !actions()[1].querySelector('[aria-label="撤回消息"]').disabled)
  actions()[1].querySelector('[aria-label="撤回消息"]').click()
  await waitFor(() => document.querySelector('.hui-revert-notice')?.textContent.includes('已撤回 1 轮'))
  check(actions().length === 1, 'reverting the latest turn preserves earlier messages')
  await waitFor(() => !document.querySelector('.hui-revert-notice button').disabled)
  document.querySelector('.hui-revert-notice button').click()
  await waitFor(() => actions().length === 2)
  return passed
}
