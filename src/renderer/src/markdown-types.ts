export interface RenderedBlock {
  cacheID?: number
  reference?: boolean
  html?: string
  tag: string
  properties?: Record<string, unknown>
  propertiesKey?: string
  children?: RenderedBlock[]
}

export interface MarkdownRequest {
  id: string
  text: string
  done: boolean
}

export interface MarkdownResult extends MarkdownRequest {
  tailKind?: 'inline' | 'code' | 'block'
  blocks: RenderedBlock[]
  error?: string
}
