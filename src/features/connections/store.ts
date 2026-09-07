import { create } from 'zustand'
import type { Connection, ConnectionConfig } from '@/types/index'
import { connectionRepository } from '@/features/connections/repository'
import { log } from '@/lib/log'

interface ConnectionState {
  connections: Connection[]
  activeConnectionId: string | null
  connCounter: number

  // Actions
  addConnection: (conn: Omit<Connection, 'id'> & { id?: string }) => Promise<void>
  setConnections: (connections: Connection[]) => void
  updateConnection: (id: string, updates: Partial<ConnectionConfig>) => Promise<void>
  updateConnectionStatus: (
    id: string,
    updates: Partial<Pick<Connection, 'connected' | 'lastConnected' | 'health'>>
  ) => void
  removeConnection: (id: string) => Promise<void>
  setActiveConnection: (id: string | null) => void
  loadConnections: () => Promise<void>
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  connCounter: 0,

  loadConnections: async () => {
    try {
      const connections = await connectionRepository.load()
      set({ connections, connCounter: connections.length })
    } catch (e) {
      console.error('[ConnectionStore] loadConnections: 加载失败:', e)
    }
  },

  addConnection: async conn => {
    const id = conn.id || crypto.randomUUID()
    const newConn: Connection = {
      ...conn,
      id,
      type: conn.type || 'postgresql',
      connected: conn.connected ?? false,
      keepaliveInterval: conn.keepaliveInterval ?? 30,
      autoReconnect: conn.autoReconnect ?? true,
    }

    await connectionRepository.create(newConn)
    set(state => ({
      connections: [...state.connections, newConn],
      connCounter: state.connCounter + 1,
    }))
  },

  setConnections: connections => set({ connections }),

  updateConnection: async (id, updates) => {
    const { connections } = get()
    const conn = connections.find(c => c.id === id)
    if (!conn) {
      throw new Error('Connection no longer exists')
    }

    await connectionRepository.update({ ...conn, ...updates, id })
    set(state => ({
      connections: state.connections.map(c => (c.id === id ? { ...c, ...updates, id } : c)),
    }))
  },

  updateConnectionStatus: (id, updates) => {
    set(state => ({
      connections: state.connections.map(connection =>
        connection.id === id ? { ...connection, ...updates } : connection
      ),
    }))
  },

  removeConnection: async id => {
    await connectionRepository.remove(id)
    set(state => ({
      connections: state.connections.filter(c => c.id !== id),
      activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
    }))
  },

  setActiveConnection: id => {
    log.debug(`[ConnectionStore] setActiveConnection: ${id}`)
    set({ activeConnectionId: id })
  },
}))
