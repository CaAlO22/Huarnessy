module.exports = async () => {
  const passed = []
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const sessionID = 'benchmark-session'
  const emit = (type, properties) => window.benchEmit(type, properties)
  emit('message.updated', { info: { id: 'details-user', sessionID, role: 'user', time: { created: 1000 } } })
  emit('message.part.updated', { part: { id: 'details-user-part', messageID: 'details-user', sessionID, type: 'text', text: '生成详情测试' } })
  emit('message.updated', { info: { id: 'details-reply', sessionID, role: 'assistant', modelID: 'test-model', providerID: 'test-provider', time: { created: 2000 } } })
  emit('message.part.updated', { part: { id: 'details-part', messageID: 'details-reply', sessionID, type: 'text', text: '长回复正文，用于验证输入框上方的阅读空间。\n\n'.repeat(80) } })
  await wait(100)
  const bubble = document.querySelector('[data-message-id="details-reply"]')
  check(!bubble.querySelector('.hui-reply-info'), 'unfinished replies do not expose completed metrics')
  emit('message.updated', { info: { id: 'details-reply', sessionID, role: 'assistant', time: { created: 2000, completed: 5000 }, tokens: { output: 60, reasoning: 30 } } })
  await wait(100)
  const trigger = bubble.querySelector('.hui-reply-info')
  const scroller = document.querySelector('.hui-chat-scroll')
  const dock = document.querySelector('.hui-composer-dock')
  scroller.scrollTop = scroller.scrollHeight
  await wait(100)
  const clearance = () => dock.getBoundingClientRect().top - bubble.getBoundingClientRect().bottom
  check(clearance() >= 24 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2, 'long replies finish at least 24px above the floating composer at the true scroll bottom')
  scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }))
  scroller.dispatchEvent(new Event('scroll'))
  const input = document.querySelector('textarea')
  const setInput = text => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const initialDockHeight = dock.getBoundingClientRect().height
  setInput('输入框增高测试\n'.repeat(14))
  await wait(250)
  check(dock.getBoundingClientRect().height > initialDockHeight + 40 && clearance() >= 24 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2, 'growing the composer keeps the final bubble clear and follows the new scroll bottom')
  setInput('')
  await wait(250)
  check(clearance() >= 24 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2, 'shrinking the composer preserves the bottom clearance')
  check(!!trigger && !document.querySelector('.hui-reply-stats'), 'final bubble owns the info button without a persistent caption')
  const panel = document.getElementById(trigger.getAttribute('aria-controls'))
  check(panel.parentElement.parentElement === document.body && panel.getAttribute('aria-hidden') === 'true', 'details start hidden and escape bubble clipping through a portal')
  check(getComputedStyle(trigger).backgroundImage !== 'none' && getComputedStyle(trigger).backdropFilter.includes('blur'), 'the collapsed info glyph rests on a circular glass surface')
  trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  await wait(80)
  check(trigger.getAttribute('aria-expanded') === 'false', 'brief pointer pass does not open details')
  await wait(170)
  check(trigger.getAttribute('aria-expanded') === 'true', 'deliberate hover opens details')
  const openingWidths = []
  const cornerErrors = []
  for (let frame = 0; frame < 20; frame++) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const bounds = panel.getBoundingClientRect()
    openingWidths.push(bounds.width)
    const radius = parseFloat(getComputedStyle(panel).borderBottomRightRadius)
    const anchor = trigger.getBoundingClientRect()
    cornerErrors.push(Math.max(Math.abs(radius - 14), Math.abs(bounds.right - radius - (anchor.left + anchor.width / 2)), Math.abs(bounds.bottom - radius - (anchor.top + anchor.height / 2))))
  }
  check(openingWidths.every((width, index) => width <= 320.5 && (!index || width >= openingWidths[index - 1] - .5)), 'glass grows monotonically from the circle without overshoot or end rebound')
  check(cornerErrors.every(error => error < 1), 'the icon corner retains its original curvature and concentric center throughout expansion')
  await Promise.all(panel.getAnimations().map(animation => animation.finished))
  check(getComputedStyle(panel).transform === 'none' && getComputedStyle(panel.querySelector('.hui-reply-details-body')).transform === 'none', 'shape expansion never stretches the text')
  panel.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  trigger.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: panel }))
  panel.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: trigger }))
  await wait(250)
  check(trigger.getAttribute('aria-expanded') === 'true', 'moving into the panel keeps it readable')
  check(panel.textContent.includes('test-model') && panel.textContent.includes('4.0 秒'), 'metrics retain model identity and end-to-end timing')
  check(panel.textContent.includes('未提供') && panel.textContent.includes('观测输出速度') && panel.textContent.includes('观测首 token 延迟') && !panel.querySelector('p'), 'unobserved history has explicitly labeled missing measurements without a footer explanation')
  const rect = panel.getBoundingClientRect()
  check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'popover stays inside the viewport')
  check(getComputedStyle(panel).backdropFilter.includes('blur'), 'glass blur survives the active build mode')
  // Force a real overlap, as in the user's screenshot. Test browser hit
  // ordering with an interactive disclosure, not just a pointer-disabled exit.
  const composer = document.querySelector('.hui-composer')
  const sendButton = Array.from(composer.querySelectorAll('button')).find(button => button.textContent.trim() === '发送')
  const sendBounds = sendButton.getBoundingClientRect()
  const overlapPoint = { x: sendBounds.left + sendBounds.width / 2, y: sendBounds.top + sendBounds.height / 2 }
  scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }))
  scroller.scrollTop -= overlapPoint.y + 24 - trigger.getBoundingClientRect().bottom
  await new Promise(resolve => requestAnimationFrame(resolve))
  trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  await wait(40)
  await Promise.all(panel.getAnimations().map(animation => animation.finished))
  check(panel.dataset.open === 'true', 'the overlapping details remain interactive for the layer regression')
  const glassBounds = panel.getBoundingClientRect()
  check(overlapPoint.x > glassBounds.left && overlapPoint.x < glassBounds.right && overlapPoint.y > glassBounds.top && overlapPoint.y < glassBounds.bottom, 'layer regression creates an actual details/composer overlap')
  for (let frame = 0; frame < 6; frame++) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    check(composer.contains(document.elementFromPoint(overlapPoint.x, overlapPoint.y)), `the composer owns mouse input above the overlapping interactive glass (frame ${frame})`)
  }
  panel.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
  await wait(140)
  check(trigger.getAttribute('aria-expanded') === 'false', 'leaving an unpinned panel starts closing without requiring a click')
  const alignedIcon = () => {
    const icon = panel.querySelector('.hui-reply-details-anchor').getBoundingClientRect()
    const anchor = trigger.getBoundingClientRect()
    return Math.abs(icon.left + icon.width / 2 - anchor.left - anchor.width / 2) < 1
      && Math.abs(icon.top + icon.height / 2 - anchor.top - anchor.height / 2) < 1
  }
  for (let frame = 0; frame < 5; frame++) {
    scroller.scrollTop -= 10
    await new Promise(resolve => requestAnimationFrame(resolve))
    check(alignedIcon(), `the shrinking glass follows the message during continued scrolling (frame ${frame})`)
  }
  await wait(400)
  scroller.scrollTop = scroller.scrollHeight
  await wait(50)
  trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  await wait(220)
  check(panel.dataset.visible === 'true' && panel.getBoundingClientRect().width < 320, 'scroll regression starts while the glass is still expanding')
  scroller.scrollTop -= 30
  await new Promise(resolve => requestAnimationFrame(resolve))
  check(alignedIcon(), 'scrolling mid-expansion keeps the portal icon aligned with its real message button')
  for (let frame = 0; frame < 5; frame++) {
    scroller.scrollTop -= 10
    await new Promise(resolve => requestAnimationFrame(resolve))
    check(alignedIcon(), `scroll-triggered closing continues following the moving button (frame ${frame})`)
  }
  await wait(400)
  scroller.scrollTop = scroller.scrollHeight
  await wait(50)
  trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  await wait(180)
  trigger.click()
  panel.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
  await wait(250)
  check(trigger.getAttribute('aria-expanded') === 'true', 'click pins details after the pointer leaves')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(30)
  check(trigger.getAttribute('aria-expanded') === 'false', 'Escape closes details')
  await Promise.all(panel.getAnimations().map(animation => animation.ready))
  await wait(45)
  const closingWidth = panel.getBoundingClientRect().width
  check(panel.dataset.visible === 'true' && closingWidth > trigger.offsetWidth && closingWidth < 320, 'closing continuously reduces the same glass toward the original circle')
  await wait(400)
  check(panel.dataset.visible === 'false' && getComputedStyle(panel).visibility === 'hidden', 'closing finishes and releases the hidden surface')
  trigger.blur()
  trigger.focus({ preventScroll: true })
  // The offscreen BrowserWindow has no OS focus; exercise React's keyboard
  // focus path with the same bubbling event a focused window delivers.
  trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  await wait(30)
  check(trigger.getAttribute('aria-expanded') === 'true', 'keyboard focus opens details')
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await wait(30)
  check(trigger.getAttribute('aria-expanded') === 'false', 'outside click closes details')
  const interruptedWidth = panel.getBoundingClientRect().width
  trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  await new Promise(resolve => requestAnimationFrame(resolve))
  check(trigger.getAttribute('aria-expanded') === 'true' && Math.abs(panel.getBoundingClientRect().width - interruptedWidth) < 60, 'reopening during exit resumes the current visual frame without snapping to an endpoint')
  for (const id of ['details-user', 'details-reply']) emit('message.removed', { sessionID, messageID: id })
  await wait(100)
  check(!panel.isConnected, 'removed replies clean up their portal')
  setInput('观测指标测试')
  await wait(50)
  Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '发送').click()
  await wait(70)
  const user = { id: 'observed-user', sessionID, role: 'user', time: { created: Date.now() } }
  const assistant = { id: 'observed-reply', sessionID, parentID: user.id, role: 'assistant', modelID: 'observed-model', time: { created: Date.now() } }
  emit('message.updated', { info: user })
  emit('message.part.updated', { part: { id: 'observed-user-part', messageID: user.id, sessionID, type: 'text', text: '观测指标测试' } })
  emit('message.updated', { info: assistant })
  emit('message.part.updated', { part: { id: 'observed-reason', messageID: assistant.id, sessionID, type: 'reasoning', text: '' } })
  await wait(50)
  emit('message.part.delta', { sessionID, messageID: assistant.id, partID: 'observed-reason', field: 'text', delta: '思考内容' })
  await wait(70)
  const sessionButton = id => Array.from(document.querySelectorAll('aside button')).find(button => button.title === id)
  sessionButton('Other session').click()
  await wait(100)
  emit('message.part.updated', { part: { id: 'observed-text', messageID: assistant.id, sessionID, type: 'text', text: '' } })
  emit('message.part.delta', { sessionID, messageID: assistant.id, partID: 'observed-text', field: 'text', delta: '观测输出' })
  await wait(70)
  emit('message.part.delta', { sessionID, messageID: assistant.id, partID: 'observed-text', field: 'text', delta: '结束' })
  await wait(200)
  emit('message.part.updated', { part: { id: 'observed-text', messageID: assistant.id, sessionID, type: 'text', text: '观测输出结束' } })
  emit('message.updated', { info: { ...assistant, time: { ...assistant.time, completed: Date.now() }, tokens: { output: 40, reasoning: 20 } } })
  emit('session.idle', { sessionID })
  await wait(100)
  check(!document.querySelector('[data-message-id="observed-reply"]'), 'background receipt measurements never inject content into the selected session')
  sessionButton('Streaming benchmark').click()
  await wait(150)
  const recorded = JSON.parse(localStorage.getItem('hui.stream-observations.v1')).find(record => record.message === assistant.id)
  check(recorded.first - recorded.request >= 90 && recorded.last > recorded.first, 'nonempty model output records receipt times independently of the waiting-bubble animation')
  const expectedSpeed = (60 / ((recorded.last - recorded.first) / 1000)).toFixed(1)
  const observedButton = document.querySelector('[data-message-id="observed-reply"] .hui-reply-info')
  const observedPanel = document.getElementById(observedButton.getAttribute('aria-controls'))
  check(observedPanel.textContent.includes(`${expectedSpeed} token/秒`), 'observed throughput uses only first-to-last model receipt intervals, excluding delayed duplicate snapshots')
  const latencyRow = Array.from(observedPanel.querySelectorAll('dl > div')).find(row => row.querySelector('dt').textContent === '观测首 token 延迟')
  check(latencyRow.querySelector('dd').textContent !== '未提供', 'locally initiated requests show observed first-token latency')
  sessionButton('Other session').click()
  await wait(100)
  sessionButton('Streaming benchmark').click()
  await wait(150)
  const restored = document.querySelector('[data-message-id="observed-reply"] .hui-reply-info')
  check(document.getElementById(restored.getAttribute('aria-controls')).textContent.includes(`${expectedSpeed} token/秒`), 'reopening the session preserves measured reply metrics')
  for (const id of [user.id, assistant.id]) emit('message.removed', { sessionID, messageID: id })
  await wait(100)
  return passed
}
