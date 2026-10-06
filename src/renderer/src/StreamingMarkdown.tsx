import { createElement, memo, useEffect, useId, useRef, useState } from 'react'
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

export const StreamingMarkdown = memo(function StreamingMarkdown({ text, done = false }: {
  text: string
  done?: boolean
}): React.ReactElement {
  const id = useId()
  const [rendered, setRendered] = useState<MarkdownResult | null>(null)
  const mounted = useRef(false)
  const cachedBlocks = useRef(new Map<number, RenderedBlock>())

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
  return (
    <div className="hui-md">
      {valid ? rendered.blocks.map((block, i) => <Block key={i} block={block} />) : null}
      {/* Every received delta is visible on this frame, even while formatting runs. */}
      {tail ? <span className="hui-stream-tail">{tail}</span> : null}
    </div>
  )
})
