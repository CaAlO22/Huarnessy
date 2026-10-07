module.exports = async () => {
  const passed = []
  const check = (condition, message) => { if (!condition) throw new Error(message); passed.push(message) }
  const waitFor = async predicate => {
    const start = performance.now()
    while (!predicate()) {
      if (performance.now() - start > 5000) throw new Error('Composer regression timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const textarea = document.querySelector('.hui-composer textarea')
  const setText = text => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }

  await waitFor(() => !document.querySelector('[aria-label="模型"]').disabled)
  const model = document.querySelector('[aria-label="模型"]')
  model.click()
  await waitFor(() => model.getAttribute('aria-expanded') === 'true')
  const modelPanel = model.parentElement.querySelector('.hui-picker-panel')
  await waitFor(() => getComputedStyle(modelPanel).visibility === 'visible')
  check(!!modelPanel.querySelector('.hui-picker-option'), 'model picker opens a glass menu')
  Array.from(document.querySelectorAll('.hui-picker-option')).find(option => option.textContent.includes('Beta')).click()
  await waitFor(() => model.textContent.includes('Beta') && model.getAttribute('aria-expanded') === 'false')
  check(model.textContent.includes('Beta') && model.getAttribute('aria-expanded') === 'false', 'model picker selects and closes')

  const initialHeight = textarea.getBoundingClientRect().height
  setText('多行输入\n'.repeat(50))
  await waitFor(() => textarea.getBoundingClientRect().height > initialHeight + 60)
  check(textarea.getBoundingClientRect().height <= 193 && textarea.scrollHeight > textarea.clientHeight, 'composer grows to a capped height and scrolls after the cap')
  setText('')
  await waitFor(() => textarea.getBoundingClientRect().height < initialHeight + 5)
  check(textarea.getBoundingClientRect().height < initialHeight + 5, 'composer shrinks after content is removed')

  const image = new File(['image'], 'sample.png', { type: 'image/png' })
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
  const clipboard = new DataTransfer()
  clipboard.items.add(image)
  textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
  await waitFor(() => document.querySelectorAll('.hui-attachment').length === 1)
  const drop = new DataTransfer()
  drop.items.add(file)
  document.querySelector('.hui-composer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drop }))
  await waitFor(() => document.querySelectorAll('.hui-attachment').length === 2)
  check(!!document.querySelector('.hui-attachment img') && document.querySelector('.hui-attachments').textContent.includes('notes.txt'), 'paste and drop add image and file chips')
  setText('附件测试')
  await waitFor(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === '发送').disabled)
  Array.from(document.querySelectorAll('button')).find(button => button.textContent === '发送').click()
  await waitFor(() => window.benchRequests.some(request => request.path === '/session/benchmark-session/prompt_async' && request.body?.parts?.some(part => part.type === 'file')))
  const prompt = window.benchRequests.filter(request => request.path === '/session/benchmark-session/prompt_async').at(-1)
  check(prompt.body.parts.length === 3 && prompt.body.parts[1].url.startsWith('data:image/png;base64,') && prompt.body.parts[2].filename === 'notes.txt', 'prompt sends text, image and file as SDK parts')
  await waitFor(() => !document.querySelector('.hui-attachment'))
  window.benchEmit('session.idle', { sessionID: 'benchmark-session' })

  // Slash commands open a frosted-glass menu with built-ins plus kernel commands.
  setText('/')
  await waitFor(() => !!document.querySelector('.hui-slash-menu'))
  const slashOptions = () => Array.from(document.querySelectorAll('.hui-slash-option'))
  check(slashOptions().length >= 4, 'typing a slash opens the frosted command menu with built-in commands')
  check(slashOptions().some(option => option.textContent.includes('/compact')), 'the built-in compact command is listed')
  setText('/co')
  await waitFor(() => {
    const options = slashOptions()
    return options.length === 1 && options[0].textContent.includes('/compact')
  })
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => textarea.value === '/compact ')
  check(textarea.value === '/compact ' && !document.querySelector('.hui-slash-menu'), 'selecting a command completes it into the composer and closes the menu')

  // Built-in /compact runs through the summarize endpoint.
  Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '发送').click()
  await waitFor(() => window.benchRequests.some(request => request.path === '/session/benchmark-session/summarize'))
  check(textarea.value === '' && !document.querySelector('.hui-slash-menu'), 'running a built-in command clears the composer')
  window.benchEmit('session.idle', { sessionID: 'benchmark-session' })
  await new Promise(resolve => setTimeout(resolve, 40))

  // User-defined commands still go through the session command endpoint.
  setText('/review')
  await waitFor(() => !!document.querySelector('.hui-slash-menu'))
  Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '发送').click()
  await waitFor(() => window.benchRequests.some(request => request.path === '/session/benchmark-session/command' && request.body?.command === 'review'))
  const commandRequest = window.benchRequests.find(request => request.path === '/session/benchmark-session/command')
  check(commandRequest.directory === window.benchWorkspace, 'a user-defined slash command carries the active workspace directory')
  await waitFor(() => !document.querySelector('.hui-slash-menu') && textarea.value === '')
  window.benchEmit('session.idle', { sessionID: 'benchmark-session' })
  await new Promise(resolve => setTimeout(resolve, 40))

  // Header context ring reflects the model recorded on the reply (falling back
  // to the composer selection) and ignores empty token reports.
  const meter = document.querySelector('.hui-context-meter')
  check(!!meter, 'the header exposes a context usage ring')
  const ringFill = () => meter.querySelector('.hui-context-ring-fill')
  const percent = () => meter.querySelector('.hui-context-percent').textContent
  window.benchEmit('message.updated', { info: { sessionID: 'benchmark-session', id: 'context-message', role: 'assistant', tokens: { input: 60000, output: 4000, reasoning: 0, cache: { read: 0, write: 0 } } } })
  await waitFor(() => percent() === '50%')
  check(percent() === '50%', 'the context ring falls back to the composer model and computes occupancy')
  const ringLength = Number(ringFill().getAttribute('stroke-dasharray'))
  check(Math.abs(Number(ringFill().getAttribute('stroke-dashoffset')) - ringLength / 2) < 0.5, 'the context ring arc matches the occupancy')
  check(meter.getAttribute('title').includes('64,000') && meter.getAttribute('title').includes('128,000'), 'the context ring reports used and max tokens')
  window.benchEmit('message.updated', { info: { sessionID: 'benchmark-session', id: 'context-message', role: 'assistant', providerID: 'test', modelID: 'alpha', tokens: { input: 60000, output: 4000, reasoning: 0, cache: { read: 0, write: 0 } } } })
  await waitFor(() => percent() === '32%')
  check(meter.getAttribute('title').includes('200,000'), 'the context ring follows the model recorded on the reply, not the composer picker')
  window.benchEmit('message.updated', { info: { sessionID: 'benchmark-session', id: 'context-empty', role: 'assistant', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } })
  await new Promise(resolve => setTimeout(resolve, 60))
  check(percent() === '32%', 'an empty token report keeps the last real usage instead of flickering to 0')
  window.benchEmit('message.removed', { sessionID: 'benchmark-session', messageID: 'context-message' })
  window.benchEmit('message.removed', { sessionID: 'benchmark-session', messageID: 'context-empty' })
  await new Promise(resolve => setTimeout(resolve, 40))

  const question = { id: 'question-regression', sessionID: 'benchmark-session', questions: [{ header: '运行方式', question: '如何启动？', options: [{ label: '开发', description: '使用开发模式' }, { label: '预览', description: '使用预览模式' }] }] }
  window.benchQuestions = [question]
  window.benchEmit('message.part.updated', { part: { id: 'question-part', messageID: 'question-message', sessionID: 'benchmark-session', type: 'tool', tool: 'question', state: { status: 'running', input: { questions: question.questions } } } })
  window.benchEmit('question.asked', question)
  await waitFor(() => !!document.querySelector('.hui-question-dialog'))
  check(!document.querySelector('.hui-question-tool pre') && document.querySelector('.hui-question-dialog').textContent.includes('如何启动？'), 'Question tool shows a dialog without raw input')
  Array.from(document.querySelectorAll('.hui-question-option')).find(option => option.textContent.includes('预览')).click()
  await waitFor(() => !document.querySelector('.hui-question-submit').disabled)
  document.querySelector('.hui-question-submit').click()
  await waitFor(() => window.benchRequests.some(request => request.path === '/question/question-regression/reply'))
  const reply = window.benchRequests.find(request => request.path === '/question/question-regression/reply')
  check(reply.directory === window.benchWorkspace && reply.body.answers[0][0] === '预览', 'Question answer uses the active workspace and selected label')
  await waitFor(() => !document.querySelector('.hui-question-dialog'))
  window.benchEmit('message.removed', { sessionID: 'benchmark-session', messageID: 'question-message' })
  await waitFor(() => !document.querySelector('.hui-question-tool'))
  await new Promise(resolve => setTimeout(resolve, 180))
  return passed
}
