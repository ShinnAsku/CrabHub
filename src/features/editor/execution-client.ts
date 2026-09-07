import { mapRawQueryResult, type BatchResultItem } from '@/lib/tauri-commands'
import { isDesktop, transportInvoke, webAuthHeaders } from '@/lib/transport'
import { Channel, invoke } from '@tauri-apps/api/core'

export interface ScriptRequest {
  id: string
  executionId: string
  statements: string[]
  options: { atomic: boolean; stopOnError: boolean }
  mode?: 'script' | 'independent'
  concurrency?: number
}

export interface StatementOutcome {
  statementIndex: number
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'unknown'
  executionTimeMs: number
  driverElapsedMs?: number | null
  firstRowMs?: number | null
  result: Parameters<typeof mapRawQueryResult>[0] | null
  rowsAffected: number | null
  truncated: boolean
  error: string | null
}

export interface ScriptOutcome {
  executionId: string
  queueMs: number | null
  acquireMs: number | null
  statements: StatementOutcome[]
  transaction: 'native' | 'committed' | 'rolledBack' | 'unknown'
  totalMs: number
  cleanupError: string | null
}

export type ExecutionUpdate =
  | { kind: 'started'; executionId: string }
  | { kind: 'statement'; executionId: string; statement: StatementOutcome }
  | { kind: 'finished'; outcome: ScriptOutcome }
  | { kind: 'error'; executionId: string; error: string }

export function mapStatementOutcome(statement: StatementOutcome): BatchResultItem {
  if (statement.status !== 'succeeded') {
    return {
      type: 'error',
      message: `${statement.status}: ${statement.error ?? 'Statement did not complete'}`,
      duration: statement.executionTimeMs,
    }
  }
  if (statement.result)
    return {
      ...mapRawQueryResult(statement.result),
      duration: statement.executionTimeMs,
      hasMore: false,
    }
  return {
    success: true,
    rowsAffected: statement.rowsAffected ?? 0,
    duration: statement.executionTimeMs,
    message: `${statement.rowsAffected ?? 0} rows affected`,
  }
}

export function cancelExecution(executionId: string): Promise<boolean> {
  return transportInvoke('cancel_execution', { executionId })
}

export async function readExecutionStream(
  stream: ReadableStream<Uint8Array>,
  executionId: string,
  onUpdate: (update: ExecutionUpdate) => void
): Promise<ScriptOutcome> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let finalOutcome: ScriptOutcome | undefined
  const indexes = new Set<number>()
  const accept = (line: string) => {
    if (!line.trim()) return
    if (finalOutcome) throw new Error('Data received after execution finished')
    const update = JSON.parse(line) as ExecutionUpdate
    const receivedId = update.kind === 'finished' ? update.outcome?.executionId : update.executionId
    if (receivedId !== executionId) throw new Error('Execution response ID mismatch')
    if (update.kind === 'error') throw new Error(update.error)
    if (update.kind === 'statement') {
      const index = update.statement?.statementIndex
      if (!Number.isInteger(index) || index < 0 || index >= 1000)
        throw new Error('Invalid statement index')
      if (indexes.has(index)) return
      indexes.add(index)
    } else if (update.kind === 'finished') {
      finalOutcome = update.outcome
    } else if (update.kind !== 'started') {
      throw new Error('Unsupported execution event')
    }
    onUpdate(update)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        if (newline > 36 * 1024 * 1024) throw new Error('Execution event exceeds the client budget')
        accept(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (buffer.length > 36 * 1024 * 1024)
        throw new Error('Execution event exceeds the client budget')
      if (done) break
    }
    if (buffer.trim()) accept(buffer)
    if (!finalOutcome)
      throw new Error(
        'Execution stream ended without a final outcome; do not retry writes automatically'
      )
    return finalOutcome
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function executeScriptStream(
  request: ScriptRequest,
  onUpdate: (update: ExecutionUpdate) => void,
  signal: AbortSignal
): Promise<ScriptOutcome> {
  signal.throwIfAborted()
  if (isDesktop()) {
    let sequence = 0
    let registered = false
    let processing = Promise.resolve()
    let deliveryError: unknown
    const onAbort = () => {
      if (registered) void cancelExecution(request.executionId).catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const channel = new Channel<ExecutionUpdate>()
    channel.onmessage = update => {
      const acknowledgedSequence = sequence++
      processing = processing
        .then(async () => {
          if (update.kind === 'started') registered = true
          const receivedId =
            update.kind === 'finished' ? update.outcome.executionId : update.executionId
          if (receivedId !== request.executionId) throw new Error('Execution response ID mismatch')
          if (signal.aborted) await cancelExecution(request.executionId)
          else onUpdate(update)
          await invoke('acknowledge_execution', {
            executionId: request.executionId,
            sequence: acknowledgedSequence,
          })
        })
        .catch(async error => {
          deliveryError = error
          await cancelExecution(request.executionId).catch(() => {})
        })
    }
    try {
      const outcome = await invoke<ScriptOutcome>('execute_script_stream', {
        request,
        onEvent: channel,
      })
      await processing
      if (deliveryError) throw deliveryError
      onUpdate({ kind: 'finished', outcome })
      return outcome
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const response = await fetch('/api/execution/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...webAuthHeaders() },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem('crabhub-web-token')
    const error = await response.json().catch(() => null)
    throw new Error(error?.error ?? `HTTP ${response.status}`)
  }
  if (!response.body) throw new Error('Streaming response is unavailable')
  try {
    return await readExecutionStream(response.body, request.executionId, onUpdate)
  } catch (error) {
    await cancelExecution(request.executionId).catch(() => {})
    throw error
  }
}
