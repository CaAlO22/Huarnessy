import { createElement, memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { MarkdownRequest, MarkdownResult, RenderedBlock } from './markdown-types'

type Job = { request: MarkdownRequest; receive: (result: MarkdownResult) => void }
const waiting = new Map<string, Job>()
let worker: Worker | undefined
let running: Job | undefined

function pump(): void {
  if (running || !waiting.size) return
  if (!worker) {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<MarkdownResult>) => {
      const job = running
      // A fast worker must not trigger multiple DOM replacements within one
      // display frame. Live text continues through its independent delta path.
      requestAnimationFrame(() => {
        running = undefined
        if (job?.request.id === event.data.id) job.receive(event.data)
        pump()
      })
    }
    worker.onerror = (event) => {
      console.error('Markdown worker failed', event.message)
      running?.receive({ ...running.request, blocks: [], error: event.message })
      running = undefined
      waiting.clear()
      worker?.terminate()
      worker = undefined
    }
  }
  const [id, job] = waiting.entries().next().value!
  waiting.delete(id)
  running = job
  worker.postMessage(job.request)
}

const Block = memo(function Block({ block }: { block: RenderedBlock }): React.ReactElement {
  const props: React.HTMLAttributes<HTMLElement> = {
    ...block.properties,
    ...(block.html === undefined ? {} : { dangerouslySetInnerHTML: { __html: block.html } })
  }
  return block.children
    ? createElement(block.tag, props, block.children.map((child, i) => <Block key={i} block={child} />))
    : createElement(block.tag, props)
}, (prev, next) => prev.block === next.block || prev.block.html !== undefined && prev.block.html === next.block.html
  && prev.block.tag === next.block.tag && prev.block.propertiesKey === next.block.propertiesKey)

function continuationTarget(root: HTMLElement, tailKind: MarkdownResult['tailKind']): HTMLElement {
  if (tailKind === 'block') return root
  let current = root
  while (true) {
    const last = Array.from(current.children).reverse().find(child => child.tagName !== 'SPAN' || child.textContent?.trim()) as HTMLElement | undefined
    if (!last) return current === root ? root : current
    if (last.tagName === 'PRE') return tailKind === 'code' ? last.querySelector('code') ?? root : root
    if (['UL', 'OL', 'LI', 'BLOCKQUOTE'].includes(last.tagName)) {
      current = last
      continue
    }
    if (['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(last.tagName)) return last
    // Tight list items contain inline elements directly; append after them.
    return current.tagName === 'LI' ? current : root
  }
}

export const StreamingMarkdown = memo(function StreamingMarkdown({ text, done = false }: {
  text: string
  done?: boolean
}): React.ReactElement {
  const id = useId()
  const [rendered, setRendered] = useState<MarkdownResult | null>(null)
  const mounted = useRef(false)
  const cachedBlocks = useRef(new Map<number, RenderedBlock>())
  const rootRef = useRef<HTMLDivElement>(null)
  const tailRef = useRef<HTMLSpanElement | null>(null)
  const trimmedCodeEnd = useRef<{ node: Text; value: string } | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      waiting.delete(id)
    }
  }, [id])

  useEffect(() => {
    // One outstanding request, with only the latest waiting snapshot per part.
    // Formatting can never build an unbounded queue behind the live text.
    waiting.set(id, { request: { id, text, done }, receive: result => {
      if (!mounted.current) return
      if (result.error) {
        // The worker's next successful reply can still reference its preceding
        // successful snapshot; retain that cache while showing the raw text.
        setRendered(result)
        return
      }
      const current = new Map<number, RenderedBlock>()
      const hydrate = (block: RenderedBlock): RenderedBlock => {
        if (block.children) return { ...block, children: block.children.map(hydrate) }
        const resolved = block.reference ? cachedBlocks.current.get(block.cacheID!)! : block
        if (block.cacheID != null) current.set(block.cacheID, resolved)
        return resolved
      }
      const blocks = result.blocks.map(hydrate)
      cachedBlocks.current = current
      setRendered({ ...result, blocks })
    } })
    pump()
  }, [id, text, done])

  const valid = rendered && !rendered.error && text.startsWith(rendered.text)
  const tail = valid ? text.slice(rendered.text.length) : text

  useLayoutEffect(() => {
    const root = rootRef.current!
    const trimmed = trimmedCodeEnd.current
    if (trimmed && root.contains(trimmed.node)) trimmed.node.data = trimmed.value
    trimmedCodeEnd.current = null
    tailRef.current?.remove()
    if (!tail) return

    const node = tailRef.current ??= document.createElement('span')
    const target = valid ? continuationTarget(root, rendered.tailKind) : root
    node.className = target === root ? 'hui-stream-tail hui-stream-tail-block' : 'hui-stream-tail'
    // remark-rehype adds one trailing newline to code HTML. Remove that
    // synthetic newline while appending into the same live code line, keeping
    // actual line breaks already received from the source.
    const end = target.lastChild
    if (valid && rendered.tailKind === 'code' && !rendered.text.endsWith('\n')
      && target !== root && end instanceof Text && end.data.endsWith('\n')) {
      trimmedCodeEnd.current = { node: end, value: end.data }
      end.data = end.data.slice(0, -1)
    }
    node.textContent = tail
    target.appendChild(node)
    // This text-only DOM node is separate from React's generated HTML. Worker
    // commits may replace its host; reattach before paint, in the same text flow.
  }, [tail, valid, rendered])

  useLayoutEffect(() => () => { tailRef.current?.remove() }, [])
  return (
    <div ref={rootRef} className="hui-md">
      {valid ? rendered.blocks.map((block, i) => <Block key={i} block={block} />) : null}
    </div>
  )
})
