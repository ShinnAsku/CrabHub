import type { ConnectionConfig } from '@/types/index'
import { transportInvoke } from '@/lib/transport'
import {
  fromStoredConnection,
  toStoredConnection,
  type StoredConnection,
} from '@/features/connections/profile'

export const connectionRepository = {
  async load() {
    const stored = await transportInvoke<StoredConnection[]>('get_connections')
    return stored.map(fromStoredConnection)
  },
  create(config: ConnectionConfig) {
    return transportInvoke<void>('add_connection', { connection: toStoredConnection(config) })
  },
  update(config: ConnectionConfig) {
    return transportInvoke<void>('update_connection', { connection: toStoredConnection(config) })
  },
  remove(id: string) {
    return transportInvoke<void>('delete_connection', { id })
  },
}
