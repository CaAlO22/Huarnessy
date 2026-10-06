module.exports = async (preview = false) => {
  const passed = []
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const sessionID = 'benchmark-session'
  const emit = (type, properties) => window.benchEmit(type, properties)
  const snapshot = (messageID, type, text) => emit('message.part.updated', { part: { sessionID, messageID, id: `${messageID}-part`, type, text } })
  const send = async text => {
    const input = document.querySelector('textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(30)
    Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '发送').click()
    await wait(50)
  }
  await send('等待动效测试')
  const chip = document.querySelector('.hui-reply-wait')
  check(chip?.textContent === '等待回复' && chip.getBoundingClientRect().width < 160, 'sending immediately shows a compact waiting surface')
  check(!document.querySelector('.hui-message'), 'no empty assistant bubble appears before the user echo')
  emit('message.updated', { info: { sessionID, id: 'ui-user', role: 'user' } })
  snapshot('ui-user', 'text', '等待动效测试')
  emit('message.updated', { info: { sessionID, id: 'ui-reply', role: 'assistant' } })
  snapshot('ui-reply', 'text', '')
  await wait(50)
  check(document.querySelector('.hui-reply-wait') === chip && !document.querySelector('.hui-message'), 'metadata and empty parts preserve the same waiting surface without a blank bubble')
  if (preview) { await wait(300); return passed }
  snapshot('ui-reply', 'reasoning', '首条思考内容')
  await wait(40)
  check(document.querySelector('.hui-reply-wait.is-leaving') && document.querySelector('.hui-reasoning')?.textContent === '首条思考内容', 'first reasoning content is visible while the waiting surface contracts')
  await wait(250)
  check(!document.querySelector('.hui-reply-wait') && !document.querySelector('.is-revealing'), 'the one-time transition removes its waiting overlay')
  emit('message.part.delta', { sessionID, messageID: 'ui-reply', partID: 'ui-reply-part', field: 'text', delta: '继续流式' })
  await wait(40)
  check(document.querySelector('.hui-reasoning')?.textContent.includes('继续流式') && !document.querySelector('.is-revealing'), 'subsequent deltas render immediately without restarting the entrance animation')
  emit('session.error', { sessionID, error: { message: '测试结束' } })
  await wait(30)
  await send('再次发送')
  check(!!document.querySelector('.hui-reply-wait') && document.querySelector('.hui-reasoning')?.textContent.includes('继续流式'), 'a new request shows waiting below the previous reply before its user echo')
  emit('session.error', { sessionID, error: { message: '等待失败' } })
  await wait(250)
  check(!document.querySelector('.hui-reply-wait'), 'request errors clear the waiting state')
  for (const messageID of ['ui-user', 'ui-reply']) emit('message.removed', { sessionID, messageID })
  Array.from(document.querySelectorAll('button')).find(button => button.title === 'Streaming benchmark').click()
  await wait(100)
  return passed
}
