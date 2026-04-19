import { describe, it, expect } from 'bun:test'
import { mockConnections, mockTables, mockQueryResult, mockTauriCommands } from '../mock/tauri-commands'

describe('Tauri Commands Mock', () => {
  it('should have mock connections', () => {
    expect(mockConnections.length).toBeGreaterThan(0)
    expect(mockConnections[0]?.type).toBe('postgresql')
    expect(mockConnections[1]?.type).toBe('sqlite')
  })

  it('should have mock tables', () => {
    expect(mockTables.length).toBeGreaterThan(0)
    expect(mockTables[0]?.name).toBe('users')
    expect(mockTables[1]?.name).toBe('orders')
  })

  it('should have mock query result', () => {
    expect(mockQueryResult.columns.length).toBe(3)
    expect(mockQueryResult.columns[0]?.name).toBe('id')
    expect(mockQueryResult.columns[1]?.name).toBe('name')
    expect(mockQueryResult.columns[2]?.name).toBe('email')
    expect(mockQueryResult.rows.length).toBe(2)
    expect(mockQueryResult.rowCount).toBe(2)
  })

  it('should execute get_connections', async () => {
    const connections = await mockTauriCommands.get_connections()
    expect(connections).toEqual(mockConnections)
  })

  it('should execute get_tables', async () => {
    const tables = await mockTauriCommands.get_tables()
    expect(tables).toEqual(mockTables)
  })

  it('should execute execute_query', async () => {
    const result = await mockTauriCommands.execute_query()
    expect(result).toEqual(mockQueryResult)
  })

  it('should test connection successfully', async () => {
    const result = await mockTauriCommands.test_connection_cmd()
    expect(result.success).toBe(true)
  })

  it('should add a new connection', async () => {
    const newConn = {
      name: 'New Connection',
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'root',
      database: 'test',
    }
    const result = await mockTauriCommands.add_connection(newConn)
    expect(result.name).toBe(newConn.name)
    expect(result.type).toBe(newConn.type)
    expect(result.id).toBeDefined()
  })
})
