import { useConnectionStore } from '@/features/connections/store'
import { useExplorerStore } from '@/features/explorer/store'
import { useTransactionStore } from '@/features/editor/transaction-store'

export function observeConnectionLifecycle() {
  return useConnectionStore.subscribe((current, previous) => {
    for (const connection of previous.connections) {
      const next = current.connections.find(candidate => candidate.id === connection.id)
      if (!next || (connection.connected && !next.connected)) {
        useTransactionStore.getState().disconnect(connection.id)
        useExplorerStore.getState().disconnect(connection.id)
      }
    }
  })
}
