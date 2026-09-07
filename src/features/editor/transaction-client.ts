import type { StatementOutcome } from '@/features/editor/execution-client'
import { transportInvoke } from '@/lib/transport'

export interface TransactionResult {
  transactionId: string
  connectionId: string
  state: 'active' | 'committed' | 'rolledBack' | 'unknown'
  statements: StatementOutcome[]
}

type TransactionRequest =
  | { action: 'begin'; id: string }
  | { action: 'execute'; transactionId: string; statements: string[] }
  | { action: 'commit' | 'rollback' | 'cancel' | 'status'; transactionId: string }

export function transactionRequest(request: TransactionRequest) {
  return transportInvoke<TransactionResult>('transaction_request', { request })
}
