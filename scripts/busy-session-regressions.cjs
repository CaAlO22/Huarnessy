module.exports = async () => {
  const passed = []
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async predicate => {
    const start = performance.now()
    while (!predicate()) {
      if (performance.now() - start > 5000) throw new Error('Busy session regression timed out')
      await wait(10)
    }
  }
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const row = title => Array.from(document.querySelectorAll('aside button')).find(button => button.title === title)
  const button = title => Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === title)

  row('Streaming benchmark').click()
  await wait(80)
  const textarea = document.querySelector('textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '后台运行时切换会话')
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => button('发送') && !button('发送').disabled)
  button('发送').click()
  await waitFor(() => !!button('停止'))
  check(!!button('停止'), 'sending shows the stop button for the active session')

  row('Other session').click()
  await waitFor(() => !!button('发送') && !button('停止'))
  check(!!button('发送') && !button('停止'), 'an idle session shows the send button while another session works')

  row('Streaming benchmark').click()
  await waitFor(() => !!button('停止'))
  check(!!button('停止'), 'returning to a working session restores the stop button')

  window.benchEmit('session.status', {
    sessionID: 'benchmark-session',
    status: { type: 'retry', attempt: 2, message: 'Cannot connect to API: socket closed', next: Date.now() + 3000 }
  })
  await waitFor(() => !!document.querySelector('[data-hui-retry]'))
  check(document.querySelector('[data-hui-retry]').textContent.includes('第 2 次重试'), 'retry notice shows the attempt count')
  check(!!button('停止'), 'retry keeps the stop control available')

  row('Other session').click()
  await waitFor(() => !!button('发送'))
  check(!document.querySelector('[data-hui-retry]'), 'retry notice is scoped to the active session')
  check(!!row('Streaming benchmark')?.querySelector('.hui-retry-dot'), 'sidebar marks the retrying session')

  row('Streaming benchmark').click()
  await waitFor(() => !!document.querySelector('[data-hui-retry]'))
  check(!!document.querySelector('[data-hui-retry]'), 'returning to the session restores the retry notice')

  window.benchEmit('session.status', { sessionID: 'benchmark-session', status: { type: 'busy' } })
  await waitFor(() => !document.querySelector('[data-hui-retry]'))
  check(!!button('停止'), 'busy clears the retry notice but keeps the session working')

  window.benchEmit('session.status', {
    sessionID: 'benchmark-session',
    status: { type: 'retry', attempt: 3, message: 'Cannot connect to API: socket closed', next: Date.now() + 3000 }
  })
  await waitFor(() => !!document.querySelector('[data-hui-retry]'))
  window.benchEmit('session.idle', { sessionID: 'benchmark-session' })
  await waitFor(() => !!button('发送'))
  check(!!button('发送'), 'idle clears the busy state for the working session')
  check(!document.querySelector('[data-hui-retry]') && !row('Streaming benchmark')?.querySelector('.hui-retry-dot'), 'idle clears retry status')
  return passed
}
