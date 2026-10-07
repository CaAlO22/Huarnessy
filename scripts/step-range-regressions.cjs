module.exports = async (keepPreview = false) => {
  const passed = []
  const sessionID = 'benchmark-session'
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async predicate => {
    const started = performance.now()
    while (!predicate()) {
      if (performance.now() - started > 5000) throw new Error('Step range timed out')
      await wait(12)
    }
  }
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const emit = (type, payload) => window.benchEmit(type, payload)
  const addCall = index => {
    const id = `range-${index}`
    emit('message.updated', { info: { sessionID, id, role: 'assistant' } })
    emit('message.part.updated', { part: { sessionID, messageID: id, id: `${id}-text`, type: 'reasoning', text: `第 ${index} 次检查：确认这一步的内容。` } })
    const tool = index % 3 === 0 ? 'edit' : index % 3 === 1 ? 'read' : 'bash'
    emit('message.part.updated', { part: { sessionID, messageID: id, id: `${id}-tool`, type: 'tool', tool, state: { status: 'completed', input: {}, output: '' } } })
  }
  emit('message.updated', { info: { sessionID, id: 'range-user', role: 'user' } })
  emit('message.part.updated', { part: { sessionID, messageID: 'range-user', id: 'range-user-text', type: 'text', text: '检查长步骤记录' } })
  for (let index = 1; index <= 12; index++) addCall(index)
  await waitFor(() => !!document.querySelector('.hui-call-block[data-message-id="range-12"]'))
  check(!document.querySelector('.hui-step-range'), 'fewer than ten older steps stay individually visible')

  addCall(13)
  await waitFor(() => !!document.querySelector('.hui-step-range[data-start="1"][data-end="10"]'))
  const first = document.querySelector('.hui-step-range[data-start="1"]')
  const header = first.querySelector('.hui-step-range-header')
  check(header.getAttribute('aria-expanded') === 'false' && first.querySelectorAll('.hui-call-block').length === 0, 'a completed ten-step range starts compact and leaves old Markdown unmounted')
  check(getComputedStyle(header, '::before').content !== 'none' && getComputedStyle(header, '::after').content !== 'none', 'compact summary card shows two shallow layers')
  check(header.textContent.includes('步骤 1–10') && header.textContent.includes('10 步') && header.querySelector('[data-tool-color="read"]') && header.querySelector('[data-tool-color="write"]'), 'range summary exposes stable numbers and colored tool totals')
  check(document.querySelector('.hui-call-block[data-message-id="range-13"]').classList.contains('is-active'), 'the newest answer stays a full-width answer')

  const foldedHeight = first.getBoundingClientRect().height
  const foldedWidth = header.getBoundingClientRect().width
  const foldedTop = header.getBoundingClientRect().top
  check(foldedHeight <= 43, `collapsed range stays a short bubble (${foldedHeight})`)
  check(getComputedStyle(first).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(first).backgroundImage === 'none', 'range itself has no enclosing glass surface')
  header.click()
  await waitFor(() => first.querySelectorAll('.hui-call-block').length === 10)
  await wait(110)
  const openingHeight = first.getBoundingClientRect().height
  const movingItem = first.querySelectorAll('.hui-step-range-item')[5]
  const openingOffset = movingItem.getBoundingClientRect().top - header.getBoundingClientRect().bottom
  const openingTransform = getComputedStyle(movingItem).transform
  check(openingHeight > foldedHeight && first.querySelectorAll('.hui-call-block').length === 10, `range reveals its original steps progressively (${foldedHeight}, ${openingHeight}, ${first.querySelectorAll('.hui-call-block').length})`)
  check(Math.abs(header.getBoundingClientRect().top - foldedTop) < 25, 'opening an older range keeps its summary in view')
  await wait(750)
  const expandedWidth = header.getBoundingClientRect().width
  const expandedOffset = movingItem.getBoundingClientRect().top - header.getBoundingClientRect().bottom
  check(Math.abs(expandedWidth - foldedWidth) < 10 && expandedOffset > openingOffset, `summary stays the same card while independent steps slide out beneath it (${foldedWidth}, ${expandedWidth}; ${openingOffset}, ${expandedOffset}; start ${movingItem.style.getPropertyValue('--range-start')}; offset ${movingItem.offsetTop}; transform ${openingTransform} → ${getComputedStyle(movingItem).transform})`)
  const firstStep = first.querySelector('.hui-call-block[data-message-id="range-1"]')
  firstStep.querySelector('.hui-call-header').click()
  await wait(550)
  check(firstStep.querySelector('.hui-call-header').getAttribute('aria-expanded') === 'true', 'individual steps remain expandable inside a range')

  const scroll = document.querySelector('.hui-chat-scroll')
  scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -350, bubbles: true }))
  scroll.scrollTop = 0
  scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
  await wait(50)
  for (let index = 14; index <= 23; index++) addCall(index)
  await waitFor(() => !!document.querySelector('.hui-call-block[data-message-id="range-23"]'))
  check(!document.querySelector('.hui-step-range[data-start="11"]') && first.getAttribute('data-expanded') === 'true', 'new calls do not regroup history while the reader is inspecting it')
  scroll.scrollTop = scroll.scrollHeight
  scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
  await waitFor(() => !!document.querySelector('.hui-step-range[data-start="11"][data-end="20"]'))
  check(first.getAttribute('data-expanded') === 'true' && firstStep.querySelector('.hui-call-header').getAttribute('aria-expanded') === 'true', 'returning to the bottom groups newer history without closing manually opened content')
  check(document.querySelectorAll('.hui-step-range').length === 2 && !!document.querySelector('.hui-call-block[data-message-id="range-23"].is-active'), 'two stable ranges leave the three newest calls visible')

  const secondCard = first.querySelectorAll('.hui-step-range-item')[1]
  const beforeClosing = secondCard.getBoundingClientRect().top - header.getBoundingClientRect().bottom
  header.click()
  await wait(250)
  check(secondCard.getBoundingClientRect().top - header.getBoundingClientRect().bottom < beforeClosing, 'closing cards move back toward the summary before being removed')
  await wait(600)
  check(header.getAttribute('aria-expanded') === 'false' && first.querySelectorAll('.hui-call-block').length === 0, 'closing a range releases hidden step DOM after the animation')
  if (!keepPreview) {
    emit('message.removed', { sessionID, messageID: 'range-user' })
    for (let index = 1; index <= 23; index++) emit('message.removed', { sessionID, messageID: `range-${index}` })
    await wait(80)
  }
  return passed
}
