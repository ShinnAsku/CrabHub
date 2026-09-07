import { transactionRequest, type TransactionResult } from '@/features/editor/transaction-client'
import { create } from 'zustand'

interface TransactionStore {
  sessions: Record<string, TransactionResult>
  pending: Record<string, string>
  begin: (tabId: string, connectionId: string) => Promise<void>
  execute: (tabId: string, statements: string[]) => Promise<TransactionResult>
  finish: (tabId: string, action: 'commit' | 'rollback') => Promise<void>
  cancel: (tabId: string) => Promise<void>
  refresh: (tabId: string) => Promise<void>
  disconnect: (connectionId: string) => void
}

export const useTransactionStore = create<TransactionStore>((set, get) => {
  const clear = (tabId: string) =>
    set(state => {
      const sessions = { ...state.sessions }
      const pending = { ...state.pending }
      delete sessions[tabId]
      delete pending[tabId]
      return { sessions, pending }
    })
  const run = async (
    tabId: string,
    action: 'execute' | 'commit' | 'rollback',
    statements: string[] = []
  ) => {
    const session = get().sessions[tabId]
    if (!session || get().pending[tabId]) throw new Error('Transaction is unavailable or busy')
    const operationId = crypto.randomUUID()
    set(state => ({ pending: { ...state.pending, [tabId]: operationId } }))
    try {
      const result = await transactionRequest(
        action === 'execute'
          ? { action, transactionId: session.transactionId, statements }
          : { action, transactionId: session.transactionId }
      )
      if (get().pending[tabId] === operationId) {
        if (result.state === 'active')
          set(state => {
            const pending = { ...state.pending }
            delete pending[tabId]
            return {
              pending,
              sessions: { ...state.sessions, [tabId]: { ...result, statements: [] } },
            }
          })
        else clear(tabId)
      }
      return result
    } catch (error) {
      if (get().pending[tabId] === operationId) clear(tabId)
      await transactionRequest({ action: 'cancel', transactionId: session.transactionId }).catch(
        () => {}
      )
      throw error
    }
  }
  return {
    sessions: {},
    pending: {},
    begin: async (tabId, connectionId) => {
      if (get().sessions[tabId] || get().pending[tabId])
        throw new Error('Transaction is already active or busy')
      const operationId = crypto.randomUUID()
      set(state => ({ pending: { ...state.pending, [tabId]: operationId } }))
      try {
        const result = await transactionRequest({ action: 'begin', id: connectionId })
        if (get().pending[tabId] !== operationId) {
          await transactionRequest({ action: 'cancel', transactionId: result.transactionId })
          return
        }
        clear(tabId)
        set(state => ({ sessions: { ...state.sessions, [tabId]: result } }))
      } catch (error) {
        if (get().pending[tabId] === operationId) clear(tabId)
        throw error
      }
    },
    execute: (tabId, statements) => run(tabId, 'execute', statements),
    finish: async (tabId, action) => {
      await run(tabId, action)
    },
    cancel: async tabId => {
      const session = get().sessions[tabId]
      clear(tabId)
      if (session)
        await transactionRequest({ action: 'cancel', transactionId: session.transactionId })
    },
    refresh: async tabId => {
      const session = get().sessions[tabId]
      if (!session || get().pending[tabId]) return
      try {
        await transactionRequest({ action: 'status', transactionId: session.transactionId })
      } catch {
        if (get().sessions[tabId]?.transactionId === session.transactionId && !get().pending[tabId])
          clear(tabId)
      }
    },
    disconnect: connectionId => {
      for (const [tabId, session] of Object.entries(get().sessions)) {
        if (
          session.connectionId === connectionId ||
          session.connectionId.startsWith(`${connectionId}:sub:`)
        ) {
          void get()
            .cancel(tabId)
            .catch(() => {})
        }
      }
    },
  }
})
