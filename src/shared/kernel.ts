export type KernelProtocol = 'v1' | 'v2'
export type ServerStatus = 'starting' | 'ready' | 'error' | 'stopped'
export type ServerErrorKind = 'not-found' | 'spawn' | 'version' | 'port' | 'exited' | 'auth' | 'protocol' | 'timeout'
export interface KernelCandidate { path: string; source: 'manual' | 'environment' | 'managed' | 'path' }
export interface ServerInfo {
  status: ServerStatus
  attempt?: number
  sequence?: number
  phase?: 'discovering' | 'version' | 'launching' | 'checking' | 'ready' | 'error' | 'stopped'
  startedAt?: number
  stages?: { phase: string; at: number }[]
  candidates?: KernelCandidate[]
  source?: KernelCandidate['source']
  protocol?: KernelProtocol
  url?: string
  port?: number
  error?: string
  errorKind?: ServerErrorKind
  hint?: string
  version?: string
  binary?: string
  args?: string[]
  logs?: string[]
  exitCode?: number | null
  lastProbe?: { endpoint: string; status?: number; error?: string }
}
// Credentials are deliberately separate from the diagnostic/status snapshot.
export interface KernelConnection { attempt?: number; url: string; protocol: KernelProtocol; headers?: Record<string, string> }
