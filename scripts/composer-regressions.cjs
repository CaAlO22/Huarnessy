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
