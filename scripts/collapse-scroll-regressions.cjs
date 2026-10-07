module.exports = async () => {
  const passed = []
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async (predicate, label) => {
    const start = performance.now()
    while (!predicate()) {
      if (performance.now() - start > 4000) throw new Error(`Collapse scroll timed out: ${label}`)
      await wait(10)
    }
  }
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const sessionID = 'benchmark-session'
  const emit = (type, properties) => window.benchEmit(type, properties)
  const part = (id, text) => emit('message.part.updated', { part: { sessionID, messageID: id, id: `${id}-part`, type: 'text', text } })
  const ids = ['scroll-user', 'scroll-card', 'scroll-marker', 'scroll-tail-answer']

  // One turn with three calls: a viewport-tall first call (becomes a step), a
  // short second call used as a stable marker right below it, and a tall third
  // call so the pane has scroll room and is not pinned to the bottom.
  const tall = Array.from({ length: 70 }, (_, i) => `第 ${i} 行内容，用于把步骤卡片撑到远超一屏高度。\n`).join('')
  const filler = Array.from({ length: 70 }, (_, i) => `填充行 ${i}，为下方的标记留出滚动空间。\n`).join('')
  emit('message.updated', { info: { sessionID, id: 'scroll-user', role: 'user' } })
  part('scroll-user', '滚动补偿测试')
  emit('message.updated', { info: { sessionID, id: 'scroll-card', role: 'assistant' } })
  part('scroll-card', tall)
  emit('message.updated', { info: { sessionID, id: 'scroll-marker', role: 'assistant' } })
  part('scroll-marker', '下方标记消息')
  emit('message.updated', { info: { sessionID, id: 'scroll-tail-answer', role: 'assistant' } })
  part('scroll-tail-answer', filler)
  await waitFor(() => !!document.querySelector('.hui-call-block[data-message-id="scroll-tail-answer"] .hui-md'), 'filler rendered')

  const el = document.querySelector('.hui-chat-scroll')
  const step = () => document.querySelector('.hui-call-block[data-message-id="scroll-card"]')
  const marker = () => document.querySelector('.hui-call-block[data-message-id="scroll-marker"]')
  const header = step()?.querySelector('.hui-call-header')
  if (!header) throw new Error('the tall call did not fold into a step: ' + (step()?.className ?? 'missing'))
  check(step().classList.contains('is-step'), 'the tall call folded into a step')

  header.click()
  await waitFor(() => step().getAttribute('data-expanded') === 'true', 'step expanded')
  await wait(560)

  // Scroll so the marker sits low in the viewport; the step's top ends up above
  // the viewport, which is the geometry that used to yank the content up.
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }))
  const elRect = el.getBoundingClientRect()
  el.scrollTop += marker().getBoundingClientRect().top - (elRect.top + el.clientHeight * 0.72)
  await wait(40)
  check(step().getBoundingClientRect().top < el.getBoundingClientRect().top, 'the long step extends above the viewport before folding')

  const markerTopBefore = marker().getBoundingClientRect().top
  const scrollTopBefore = el.scrollTop
  step().querySelector('.hui-call-collapse').click()
  await wait(650)
  const markerTopAfter = marker().getBoundingClientRect().top
  check(el.scrollTop < scrollTopBefore - 40, `folding a viewport-tall card scrolls the pane upward (${scrollTopBefore.toFixed(1)} → ${el.scrollTop.toFixed(1)})`)
  check(Math.abs(markerTopAfter - markerTopBefore) < 24, `content below the folding card stays put (${markerTopBefore.toFixed(1)} → ${markerTopAfter.toFixed(1)})`)

  for (const id of ids) emit('message.removed', { sessionID, messageID: id })
  await wait(80)
  return passed
}
