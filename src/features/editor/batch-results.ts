import type { QueryResult } from '@/types/index'

export type QueryResultSlot = { result: QueryResult; sql: string; hasMore: boolean }
export type QueryPagination = { hasMore: boolean; currentOffset: number; originalSql: string }

export function snapshotQueryResults(slots: ReadonlyMap<number, QueryResultSlot>) {
  const results: QueryResult[] = []
  const pagination: Record<number, QueryPagination> = {}
  for (const [, slot] of [...slots].sort(([left], [right]) => left - right)) {
    pagination[results.length] = {
      hasMore: slot.hasMore,
      currentOffset: slot.result.rows.length,
      originalSql: slot.sql,
    }
    results.push(slot.result)
  }
  return { results, pagination }
}
