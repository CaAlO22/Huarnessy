const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const workspaceRegressions = require('./workspace-regressions.cjs')
const busySessionRegressions = require('./busy-session-regressions.cjs')
const replyUIRegressions = require('./reply-ui-regressions.cjs')
const replyDetailsRegressions = require('./reply-details-regressions.cjs')
const stepRangeRegressions = require('./step-range-regressions.cjs')
const messageActionsRegressions = require('./message-actions-regressions.cjs')
const composerRegressions = require('./composer-regressions.cjs')
const permissionRegressions = require('./permission-regressions.cjs')
const collapseScrollRegressions = require('./collapse-scroll-regressions.cjs')
const { writeFile } = require('node:fs/promises')
const screenshotRunId = `${Date.now()}-${process.pid}`
const previewPath = name => join(__dirname, '../out', `${screenshotRunId}-${name}`)

const run = async (kind, scale = 1) => {
  const sessionID = 'benchmark-session'
  const messageID = `message-${kind}`
  const partID = `part-${kind}`
  const text = kind === 'list'
    ? Array.from({ length: 80 * scale }, (_, i) => `- 项目 ${i}: **流式输出**，包含 [链接](https://example.com) 和 $x_${i}^2$，测试连续列表的渲染性能。\n`).join('')
    : kind === 'paragraph'
      ? '这是没有空行的长段落，包含 **强调**、`inline code` 与实时流式输出。'.repeat(160 * scale)
      : kind === 'code'
        ? '```typescript\n' + 'const value = "实时流式输出";\n'.repeat(400 * scale) + '```\n'
      : '$\\frac{1}{1-\\frac{1}{2}z^{-1}}$\n\n' + Array.from({ length: 80 * scale }, (_, i) => `## 段落 ${i}\n\n流式 **Markdown** 与 $x^2$。\n\n`).join('')
  window.benchEmit('message.updated', { info: { id: messageID, sessionID, role: 'assistant' } })
  window.benchEmit('message.part.updated', { part: { id: partID, messageID, sessionID, type: 'text', text: '' } })
  const frames = []
  const longTasks = []
  let previous = performance.now()
  let alive = true
  const frame = now => {
    frames.push(now - previous)
    previous = now
    if (alive) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)))
  observer.observe({ type: 'longtask' })
  const start = performance.now()
  const delays = []
  for (let i = 0; i < text.length; i += 40) {
    const tick = performance.now()
    window.benchEmit('message.part.delta', { sessionID, messageID, partID, field: 'text', delta: text.slice(i, i + 40) })
    await new Promise(resolve => setTimeout(resolve, 4))
    delays.push(performance.now() - tick)
  }
  await new Promise(resolve => setTimeout(resolve, 100))
  const streamingMs = performance.now() - start
  window.benchEmit('message.part.updated', { part: { id: partID, messageID, sessionID, type: 'text', text, time: { end: 1 } } })
  await new Promise(resolve => setTimeout(resolve, 1000))
  alive = false
  observer.disconnect()
  const sorted = frames.slice().sort((a, b) => a - b)
  return {
    kind, characters: text.length, streamingMs: Math.round(streamingMs),
    frameP95Ms: Math.round(sorted[Math.floor(sorted.length * .95)]),
    maxFrameMs: Math.round(Math.max(...frames)), longTasks: longTasks.length,
    maxLongTaskMs: Math.round(Math.max(0, ...longTasks)),
    firstQuarterTickMs: +(delays.slice(0, delays.length / 4).reduce((a, b) => a + b, 0) / (delays.length / 4)).toFixed(1),
    lastQuarterTickMs: +(delays.slice(-Math.floor(delays.length / 4)).reduce((a, b) => a + b, 0) / Math.floor(delays.length / 4)).toFixed(1),
    hasFormattedText: !!document.querySelector('.hui-md strong'),
    hasMath: !!document.querySelector('.katex'),
    hasDisplayMath: !!document.querySelector('.hui-md .katex-display .mfrac'),
    hasHighlight: !!document.querySelector('.hljs'),
    scrollGap: Math.round((() => { const el = document.querySelector('.hui-chat-scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight })())
  }
}

const layoutRegressions = async () => {
  const sessionID = 'benchmark-session', messageID = 'layout-message', partID = 'layout-part'
  const snapshot = text => window.benchEmit('message.part.updated', { part: { sessionID, messageID, id: partID, type: 'text', text } })
  const delta = text => window.benchEmit('message.part.delta', { sessionID, messageID, partID, field: 'text', delta: text })
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  snapshot('开始')
  await wait(300)
  const widths = []
  for (let i = 0; i < 35; i++) {
    delta('测试文字')
    await wait(20)
    widths.push(document.querySelector('.hui-message').getBoundingClientRect().width)
  }
  snapshot('历史段落内容。\n\n'.repeat(45) + '持续增长的段落：')
  await wait(300)
  const heights = [], scrolls = []
  let alive = true
  const sample = () => {
    heights.push(document.querySelector('.hui-message').getBoundingClientRect().height)
    scrolls.push(document.querySelector('.hui-chat-scroll').scrollTop)
    if (alive) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
  for (let i = 0; i < 70; i++) {
    delta('继续输出文字')
    await wait(20)
  }
  await wait(300)
  alive = false
  const countDrops = values => values.slice(1).filter((value, i) => value < values[i] - 1).length
  const result = {
    widthRangePx: Math.round(Math.max(...widths) - Math.min(...widths)),
    heightDrops: countDrops(heights), scrollBacksteps: countDrops(scrolls),
    samples: heights.length
  }
  snapshot('```typescript\nconst start = 0;')
  await wait(300)
  let source = 'const start = 0;'
  let codeTextMismatches = 0
  for (const chunk of [' // 继续当前行', '\n', 'const next = ', '1;', '\n\n', 'const final = 2;']) {
    source += chunk
    delta(chunk)
    await wait(20)
    const displayed = document.querySelector('.hui-md pre code')?.textContent
    if (displayed?.replace(/\n$/, '') !== source.replace(/\n$/, '')) codeTextMismatches++
  }
  result.codeTextMismatches = codeTextMismatches
  window.benchEmit('message.removed', { sessionID, messageID })
  await wait(100)
  return result
}

const regressions = async () => {
  const passed = []
  const sessionID = 'benchmark-session', messageID = 'regression', partID = 'regression-part'
  const delta = text => window.benchEmit('message.part.delta', { sessionID, messageID, partID, field: 'text', delta: text })
  const part = (text, done = false) => window.benchEmit('message.part.updated', { part: {
    sessionID, messageID, id: partID, type: 'text', text, ...(done ? { time: { end: 1 } } : {})
  } })
  const waitFor = async predicate => {
    const start = performance.now()
    while (!predicate()) {
      if (performance.now() - start > 5000) throw new Error('Regression timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const displayed = () => document.querySelector('.hui-md')?.textContent
  part('')
  delta('A'); part('AB'); delta('C')
  await waitFor(() => displayed() === 'ABC')
  check(displayed() === 'ABC', 'delta/snapshot/delta preserves order')

  delta('D')
  window.benchEmit('message.part.removed', { sessionID, messageID, partID })
  await new Promise(resolve => setTimeout(resolve, 50))
  check(!document.querySelector('.hui-md'), 'removal cannot be undone by a pending delta')

  part('switching')
  delta(' pending')
  Array.from(document.querySelectorAll('button')).find(b => b.title === 'Other session').click()
  await new Promise(resolve => setTimeout(resolve, 100))
  check(!document.querySelector('.hui-md'), 'pending deltas do not leak into another session')
  Array.from(document.querySelectorAll('button')).find(b => b.title === 'Streaming benchmark').click()
  await new Promise(resolve => setTimeout(resolve, 100))

  const rich = '# 标题\n\n- **粗体** $x^2$\n- 第二项\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n---\n\n[引用][ref]\n\n[ref]: https://example.com\n\n```unknown-language\n<&>\n```\n\n<script>window.compromised = true</script>\n\n[危险](javascript:alert(1))\n\n&amp;'
  part(rich, true)
  await waitFor(() => !!document.querySelector('.hui-md hr') && !!document.querySelector('.katex') && !document.querySelector('.hui-stream-tail'))
  check(document.querySelectorAll('.hui-md ul > li').length === 2, 'list items have valid DOM parents')
  check(document.querySelectorAll('.hui-md table tbody > tr > td').length === 2, 'table cells have valid DOM parents')
  check(!!document.querySelector('.hui-md a[href="https://example.com"]'), 'cross-paragraph reference links resolve')
  check(!document.querySelector('.hui-md script') && !window.compromised, 'raw HTML stays escaped')
  check(!document.querySelector('.hui-md a[href^="javascript:"]'), 'unsafe URLs stay filtered')
  check(document.querySelector('.hui-md pre code').textContent === '<&>\n', 'unknown code language and entities render safely')

  part('- item\n\n  ```typescript\n  const x = 1;\n')
  await waitFor(() => document.querySelector('.hui-md pre code')?.textContent.includes('const x = 1;') && !document.querySelector('.hui-stream-tail'))
  check(!document.querySelector('.hljs'), 'nested open fences stream without repeated highlighting')
  delta('  ```\n')
  await waitFor(() => !!document.querySelector('.hljs'))
  check(!!document.querySelector('.hljs'), 'closed nested fences receive highlighting')

  part('滚动测试段落。\n\n'.repeat(100), true)
  const el = document.querySelector('.hui-chat-scroll')
  await waitFor(() => el.scrollHeight > el.clientHeight + 500 && !document.querySelector('.hui-stream-tail') && el.scrollHeight - el.scrollTop - el.clientHeight < 5)
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
  el.scrollTop -= 300
  await new Promise(resolve => setTimeout(resolve, 50))
  const top = el.scrollTop
  delta('新增内容。\n\n')
  await new Promise(resolve => setTimeout(resolve, 200))
  check(Math.abs(el.scrollTop - top) < 10, 'manual upward scrolling stays in place during streaming')
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }))
  el.scrollTop = el.scrollHeight
  await new Promise(resolve => setTimeout(resolve, 50))
  delta('继续吸底。\n\n')
  await new Promise(resolve => setTimeout(resolve, 200))
  check(el.scrollHeight - el.scrollTop - el.clientHeight < 5, 'scrolling to the bottom resumes following')
  return passed
}

const sessionDeletionRegressions = async () => {
  const passed = []
  const waitFor = async predicate => {
    const start = performance.now()
    while (!predicate()) {
      if (performance.now() - start > 5000) throw new Error('Session deletion regression timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const check = (condition, name) => { if (!condition) throw new Error(name); passed.push(name) }
  const row = title => Array.from(document.querySelectorAll('aside button')).find(button => button.title === title)
  const menu = () => document.querySelector('[role="menu"]')
  const rightClick = async (title, x = 100, y = 120) => {
    row(title).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }))
    await waitFor(menu)
  }
  window.benchEmit('message.part.updated', { part: { id: 'regression-part', messageID: 'regression', sessionID: 'benchmark-session', type: 'text', text: '保留当前会话' } })
  await waitFor(() => document.querySelector('.hui-md')?.textContent === '保留当前会话')
  await rightClick('Other session', innerWidth - 1, innerHeight - 1)
  const bounds = menu().getBoundingClientRect()
  check(bounds.right <= innerWidth && bounds.bottom <= innerHeight, 'context menu stays within the viewport')
  check(row('Streaming benchmark').classList.contains('glass-soft'), 'right-click does not change the active session')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitFor(() => !menu())
  check(!menu(), 'Escape dismisses the context menu')
  await rightClick('Other session')
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await waitFor(() => !menu())
  check(!menu(), 'clicking outside dismisses the context menu')

  window.benchDeleteFailure = true
  await rightClick('Other session')
  menu().querySelector('button').click()
  await waitFor(() => document.body.textContent.includes('删除会话失败'))
  check(!!row('Other session') && document.querySelector('.hui-md')?.textContent === '保留当前会话', 'failed deletion preserves the session and current messages')
  check(window.benchRequests.at(-1).method === 'DELETE' && window.benchRequests.at(-1).path === '/session/other-session', 'deletion uses DELETE for the clicked session')
  window.benchDeleteFailure = false

  window.benchHoldDelete = true
  const before = window.benchRequests.filter(request => request.method === 'DELETE').length
  await rightClick('Other session')
  const deleteButton = menu().querySelector('button')
  deleteButton.click(); deleteButton.click()
  await waitFor(() => !!window.benchReleaseDelete)
  check(row('Other session').disabled, 'session is disabled while deletion is pending')
  check(window.benchRequests.filter(request => request.method === 'DELETE').length === before + 1, 'repeated clicks do not send duplicate deletions')
  window.benchNextList = [...window.benchSessions]
  window.benchHoldDelete = false
  window.benchReleaseDelete()
  await waitFor(() => !row('Other session'))
  await new Promise(resolve => setTimeout(resolve, 100))
  check(!row('Other session'), 'a stale list response cannot restore a deleted session')
  check(document.querySelector('.hui-md')?.textContent === '保留当前会话', 'deleting an inactive session preserves the active conversation')

  await rightClick('Streaming benchmark')
  window.benchEmit('message.part.delta', { sessionID: 'benchmark-session', messageID: 'regression', partID: 'regression-part', field: 'text', delta: '待提交内容' })
  menu().querySelector('button').click()
  await waitFor(() => !row('Streaming benchmark'))
  window.benchEmit('message.part.delta', { sessionID: 'benchmark-session', messageID: 'regression', partID: 'regression-part', field: 'text', delta: '迟到内容' })
  await new Promise(resolve => setTimeout(resolve, 100))
  check(!document.querySelector('.hui-md') && document.body.textContent.includes('开始一段对话'), 'deleting the active session clears pending and late streamed content')

  window.benchSessions.push({ id: 'missing-session', title: 'Missing session' })
  window.benchMissingID = 'missing-session'
  window.benchEmit('session.created', {})
  await waitFor(() => !!row('Missing session'))
  await rightClick('Missing session')
  menu().querySelector('button').click()
  await waitFor(() => !row('Missing session'))
  check(!document.body.textContent.includes('删除会话失败'), 'already-deleted sessions are handled without an error')

  window.benchSessions.push({ id: 'external-session', title: 'External session' })
  window.benchEmit('session.created', {})
  await waitFor(() => !!row('External session'))
  row('External session').click()
  await new Promise(resolve => setTimeout(resolve, 50))
  window.benchEmit('message.part.updated', { part: { id: 'external-part', messageID: 'external-message', sessionID: 'external-session', type: 'text', text: '外部会话' } })
  await waitFor(() => document.querySelector('.hui-md')?.textContent === '外部会话')
  await rightClick('External session')
  window.benchSessions = window.benchSessions.filter(session => session.id !== 'external-session')
  window.benchEmit('session.deleted', { info: { id: 'external-session' } })
  await waitFor(() => !row('External session') && !document.querySelector('.hui-md') && !menu())
  check(!menu(), 'external deletion clears the active session and its context menu')
  return passed
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: {
    preload: join(__dirname, 'stream-benchmark-preload.cjs'), sandbox: false,
    nodeIntegration: false, contextIsolation: false, backgroundThrottling: false, offscreen: true
  } })
  window.webContents.setFrameRate(60)
  const timeout = setTimeout(() => { console.error('Streaming test timed out'); app.exit(1) }, 120000)
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error(event.message)
  })
  try {
    // Install the fake kernel before React loads. No real sessions or model requests.
    if (process.env.BENCH_FILE) await window.loadFile(process.env.BENCH_FILE)
    else await window.loadURL(process.env.BENCH_URL + '?benchmark')
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = await window.webContents.executeJavaScript(`!!Array.from(document.querySelectorAll('button')).find(b => b.title === 'Streaming benchmark')`).catch(() => false)
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Streaming benchmark').click()`)
    await new Promise(resolve => setTimeout(resolve, 100))
    if (process.env.BENCH_PERMISSION_ONLY) {
      console.log(JSON.stringify({ permissions: await window.webContents.executeJavaScript(`(${permissionRegressions.toString()})()`) }))
      return
    }
    if (!process.env.BENCH_LAYOUT_ONLY) console.log(JSON.stringify({ replyUI: await window.webContents.executeJavaScript(`(${replyUIRegressions.toString()})()`) }))
    if (!process.env.BENCH_LAYOUT_ONLY) console.log(JSON.stringify({ replyDetails: await window.webContents.executeJavaScript(`(${replyDetailsRegressions.toString()})()`) }))
    if (!process.env.BENCH_LAYOUT_ONLY) console.log(JSON.stringify({ stepRanges: await window.webContents.executeJavaScript(`(${stepRangeRegressions.toString()})(${Boolean(process.env.BENCH_SCREENSHOT)})`) }))
    if (process.env.BENCH_SCREENSHOT) {
      await window.webContents.executeJavaScript(`(() => {
        const settings = document.querySelector('button[aria-label="外观设置"]')
        if (settings?.getAttribute('aria-expanded') === 'true') settings.click()
        Array.from(document.querySelectorAll('.hui-chat-pane button')).find(button => button.textContent.trim() === '✕')?.click()
        const scroll = document.querySelector('.hui-chat-scroll')
        scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
        scroll.scrollTop = 0
      })()`)
      await new Promise(resolve => setTimeout(resolve, 120))
      await writeFile(previewPath('step-ranges-collapsed-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.querySelector('.hui-step-range[data-start="11"] .hui-step-range-header').click()`)
      await new Promise(resolve => setTimeout(resolve, 220))
      await window.webContents.executeJavaScript(`document.querySelector('.hui-step-range[data-start="11"]').scrollIntoView({ block: 'start' })`)
      await writeFile(previewPath('step-ranges-unstacking-preview.png'), (await window.webContents.capturePage()).toPNG())
      await new Promise(resolve => setTimeout(resolve, 500))
      await window.webContents.executeJavaScript(`(() => {
        const scroll = document.querySelector('.hui-chat-scroll')
        scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
        document.querySelector('.hui-step-range[data-start="11"]').scrollIntoView({ block: 'start' })
      })()`)
      await new Promise(resolve => setTimeout(resolve, 100))
      await writeFile(previewPath('step-ranges-expanded-preview.png'), (await window.webContents.capturePage()).toPNG())
      if (process.env.BENCH_STEP_PREVIEW_ONLY) {
        console.log(JSON.stringify({ previewRun: screenshotRunId }))
        return
      }
      await window.webContents.executeJavaScript(`(() => { window.benchEmit('message.removed', { sessionID: 'benchmark-session', messageID: 'range-user' }); for (let index = 1; index <= 23; index++) window.benchEmit('message.removed', { sessionID: 'benchmark-session', messageID: 'range-' + index }) })()`)
      await new Promise(resolve => setTimeout(resolve, 100))
      await window.webContents.executeJavaScript(`(${replyUIRegressions.toString()})(true)`)
      await writeFile(previewPath('reply-wait-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`window.benchEmit('message.part.updated', { part: { sessionID: 'benchmark-session', messageID: 'ui-reply', id: 'ui-reply-part', type: 'text', text: '收到啦，回复会从这里自然展开。\\n\\n等待条收拢后，正文继续实时显示。' } }); window.benchEmit('session.error', { sessionID: 'benchmark-session', error: { message: '' } })`)
      await new Promise(resolve => setTimeout(resolve, 750))
      await writeFile(previewPath('reply-content-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`(() => {
        if (document.querySelector('#hui-appearance-settings')) document.querySelector('button[aria-label="外观设置"]').click()
        document.querySelector('.hui-user-message')?.parentElement?.style.setProperty('display', 'none')
        document.querySelector('.app-bg').style.background = 'radial-gradient(80% 80% at 82% 12%, #a82963 0%, #551b42 55%, #150d20 100%)'
      })()`)
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(previewPath('liquid-red-edge-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="外观设置"]').click()`)
      await new Promise(resolve => setTimeout(resolve, 50))
      await window.webContents.executeJavaScript(`document.querySelector('.hui-liquid-toggle').click(); document.querySelector('button[aria-label="外观设置"]').click()`)
      await new Promise(resolve => setTimeout(resolve, 120))
      await writeFile(previewPath('liquid-red-edge-off-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="外观设置"]').click()`)
      await new Promise(resolve => setTimeout(resolve, 50))
      await window.webContents.executeJavaScript(`document.querySelector('.hui-liquid-toggle').click(); document.querySelector('button[aria-label="外观设置"]').click()`)
      await window.webContents.executeJavaScript(`document.querySelector('.hui-user-message')?.parentElement?.style.removeProperty('display'); document.querySelector('.app-bg').style.removeProperty('background')`)
      await window.webContents.executeJavaScript(`if (!document.querySelector('#hui-appearance-settings')) document.querySelector('button[aria-label="外观设置"]')?.click()`)
      await new Promise(resolve => setTimeout(resolve, 50))
      await window.webContents.executeJavaScript(`document.querySelector('.app-bg').style.background = 'repeating-linear-gradient(135deg, #eef3ff 0 80px, #090d18 80px 160px)'`)
      await writeFile(previewPath('liquid-through-frost-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`(() => {
        document.querySelector('.app-bg').style.background = 'repeating-linear-gradient(135deg, #eef3ff 0 5px, #090d18 5px 54px)'
        const backdrop = document.querySelector('.hui-chat-pane-backdrop')
        backdrop.style.backdropFilter = 'none'
        backdrop.style.webkitBackdropFilter = 'none'
        backdrop.style.background = 'rgba(10, 13, 24, .18)'
        if (document.querySelector('.hui-liquid-toggle').checked) document.querySelector('.hui-liquid-toggle').click()
        document.querySelector('button[aria-label="外观设置"]').click()
      })()`)
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(previewPath('liquid-off-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="外观设置"]').click()`)
      await new Promise(resolve => setTimeout(resolve, 50))
      await window.webContents.executeJavaScript(`document.querySelector('.hui-liquid-toggle').click(); document.querySelector('button[aria-label="外观设置"]').click()`)
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(previewPath('liquid-on-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.querySelector('.app-bg').style.removeProperty('background')`)
      await window.webContents.executeJavaScript(`const backdrop = document.querySelector('.hui-chat-pane-backdrop'); backdrop.style.backdropFilter = 'blur(22px) saturate(160%)'; backdrop.style.webkitBackdropFilter = 'blur(22px) saturate(160%)'; backdrop.style.removeProperty('background')`)
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Streaming benchmark').click()`)
      await new Promise(resolve => setTimeout(resolve, 100))
      await window.webContents.executeJavaScript(`(${replyUIRegressions.toString()})('steps')`)
      await writeFile(previewPath('step-collapsed-preview.png'), (await window.webContents.capturePage()).toPNG())
      const header = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector('.hui-call-block.is-step .hui-call-header').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
      window.webContents.sendInputEvent({ type: 'mouseMove', ...header })
      await new Promise(resolve => setTimeout(resolve, 100))
      await writeFile(previewPath('step-hover-preview.png'), (await window.webContents.capturePage()).toPNG())
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...header })
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...header })
      await new Promise(resolve => setTimeout(resolve, 130))
      await writeFile(previewPath('step-opening-preview.png'), (await window.webContents.capturePage()).toPNG())
      await new Promise(resolve => setTimeout(resolve, 430))
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...header })
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...header })
      await new Promise(resolve => setTimeout(resolve, 130))
      await writeFile(previewPath('step-closing-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Streaming benchmark').click()`)
      await new Promise(resolve => setTimeout(resolve, 100))
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.hui-chat-pane button')).find(b => b.textContent.trim() === '✕')?.click()`)
      const mathText = [
        '例：求 $x[n] = (\\frac{1}{2})^n u[n]$ 的 Z 变换。',
        '',
        '解：',
        '',
        '$X(z) = \\sum_{n=0}^{\\infty}(\\frac{1}{2})^n z^{-n} = \\sum_{n=0}^{\\infty}(\\frac{1}{2z})^n$',
        '',
        '当 $|\\frac{1}{2z}| < 1$ 时，等比级数收敛：',
        '',
        '$X(z) = \\frac{1}{1 - \\frac{1}{2}z^{-1}}$',
        '',
        '分子分母同乘 z：',
        '',
        '$X(z) = \\frac{z}{z - \\frac{1}{2}}, \\quad |z| > \\frac{1}{2}$',
        '',
        '极点 $z = \\frac{1}{2}$，收敛域在极点圆外，对应右边（因果）序列。'
      ].join('\n')
      await window.webContents.executeJavaScript(`window.benchEmit('message.updated', { info: { sessionID: 'benchmark-session', id: 'math-preview', role: 'assistant' } }); window.benchEmit('message.part.updated', { part: { sessionID: 'benchmark-session', messageID: 'math-preview', id: 'math-preview-part', type: 'text', text: ${JSON.stringify(mathText)}, time: { end: 1 } } })`)
      await new Promise(resolve => setTimeout(resolve, 400))
      await writeFile(previewPath('math-preview.png'), (await window.webContents.capturePage()).toPNG())
      console.log(JSON.stringify({ mathLayout: await window.webContents.executeJavaScript(`(() => { const formulas = Array.from(document.querySelectorAll('.hui-md .katex:has(.mfrac)')); return formulas.map(formula => { const r = formula.getBoundingClientRect(); const p = formula.closest('p'); const pr = p?.getBoundingClientRect(); return { text: formula.textContent?.slice(0, 48), formulaHeight: r.height, paragraphHeight: pr?.height, lineHeight: p && getComputedStyle(p).lineHeight, display: !!formula.closest('.katex-display') } }) })()`) }))
      await window.webContents.executeJavaScript(`window.benchEmit('message.removed', { sessionID: 'benchmark-session', messageID: 'math-preview' })`)
      await new Promise(resolve => setTimeout(resolve, 100))
      await window.webContents.executeJavaScript(`document.querySelector('[aria-label="模型"]').click()`)
      await new Promise(resolve => setTimeout(resolve, 220))
      await writeFile(previewPath('model-menu-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.querySelector('[aria-label="模型"]').click()`)
      await window.webContents.executeJavaScript(`window.benchEmit('question.asked', { id: 'visual-question', sessionID: 'benchmark-session', questions: [{ header: '运行方式', question: '你希望用哪种方式启动应用？', options: [{ label: '开发模式', description: '启动带热更新的开发窗口' }, { label: '预览模式', description: '启动生产构建的预览窗口' }] }] })`)
      await new Promise(resolve => setTimeout(resolve, 260))
      await writeFile(previewPath('question-dialog-preview.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`window.benchEmit('question.rejected', { sessionID: 'benchmark-session', requestID: 'visual-question' })`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (process.env.BENCH_VISUAL_ONLY) {
      console.log(JSON.stringify({ previewRun: screenshotRunId }))
      return
    }
    if (process.env.BENCH_SCREENSHOT) await new Promise(resolve => setTimeout(resolve, 300))
    const layout = await window.webContents.executeJavaScript(`(${layoutRegressions.toString()})()`)
    console.log(JSON.stringify({ layout }))
    if (!process.env.BENCH_LAYOUT_RECORD) {
      assert.ok(layout.widthRangePx < 2, 'streaming changes the assistant bubble width')
      assert.equal(layout.heightDrops, 0, 'plain-text streaming repeatedly shrinks the bubble')
      assert.equal(layout.scrollBacksteps, 0, 'plain-text streaming scrolls backwards')
      assert.equal(layout.codeTextMismatches, 0, 'live code text moves to another line or loses newlines')
    }
    for (const kind of process.env.BENCH_LAYOUT_ONLY ? [] : ['list', 'paragraph', 'blocks', 'code']) {
      const result = await window.webContents.executeJavaScript(`(${run.toString()})(${JSON.stringify(kind)}, ${process.env.BENCH_LARGE ? 3 : 1})`)
      console.log(JSON.stringify(result))
      if (kind !== 'code') assert.equal(result.hasFormattedText, true)
      if (kind === 'list' || kind === 'blocks') assert.equal(result.hasMath, true)
      if (kind === 'blocks') assert.equal(result.hasDisplayMath, true, 'standalone nested fractions use display layout')
      if (kind === 'code') assert.equal(result.hasHighlight, true)
      assert.ok(result.frameP95Ms < (process.env.BENCH_LARGE ? 100 : 75), 'streaming frame latency regressed')
      assert.ok(result.maxLongTaskMs < 150, 'streaming blocks the renderer for too long')
      assert.ok(result.scrollGap < 5, 'reply keeps scrolling after worker formatting')
      await window.webContents.executeJavaScript(`window.benchEmit('message.removed', { sessionID: 'benchmark-session', messageID: ${JSON.stringify('message-' + kind)} })`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!process.env.BENCH_LAYOUT_ONLY) {
      console.log(JSON.stringify({ regressions: await window.webContents.executeJavaScript(`(${regressions.toString()})()`) }))
      console.log(JSON.stringify({ busySessions: await window.webContents.executeJavaScript(`(${busySessionRegressions.toString()})()`) }))
      console.log(JSON.stringify({ composer: await window.webContents.executeJavaScript(`(${composerRegressions.toString()})()`) }))
      console.log(JSON.stringify({ permissions: await window.webContents.executeJavaScript(`(${permissionRegressions.toString()})()`) }))
      console.log(JSON.stringify({ collapseScroll: await window.webContents.executeJavaScript(`(${collapseScrollRegressions.toString()})()`) }))
      console.log(JSON.stringify({ workspaces: await window.webContents.executeJavaScript(`(${workspaceRegressions.toString()})()`) }))
      if (process.env.BENCH_SCREENSHOT) await writeFile(process.env.BENCH_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      console.log(JSON.stringify({ sessionDeletion: await window.webContents.executeJavaScript(`(${sessionDeletionRegressions.toString()})()`) }))
      console.log(JSON.stringify({ messageActions: await window.webContents.executeJavaScript(`(${messageActionsRegressions.toString()})()`) }))
      if (process.env.BENCH_SCREENSHOT) {
        await new Promise(resolve => setTimeout(resolve, 250))
        await writeFile(previewPath('message-actions-buttons-preview.png'), (await window.webContents.capturePage()).toPNG())
        await window.webContents.executeJavaScript(`document.querySelector('.hui-user-actions [aria-label="撤回消息"]').click()`)
        await new Promise(resolve => setTimeout(resolve, 300))
        await writeFile(previewPath('message-actions-reverted-preview.png'), (await window.webContents.capturePage()).toPNG())
      }
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    window.destroy()
    app.exit(process.exitCode ?? 0)
  }
})
