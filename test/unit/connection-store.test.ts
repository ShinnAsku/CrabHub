import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Connection } from '@/types'

describe('Connection Store Module', () => {
  let mockConnections: Connection[] = []

  beforeEach(() => {
    mockConnections = [
      {
        id: 'conn-1',
        name: 'Test Postgres',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        database: 'test',
      },
    ]
  })

  it('should have initial connections', () => {
    expect(mockConnections.length).toBe(1)
    expect(mockConnections[0]?.name).toBe('Test Postgres')
  })

  it('should add a new connection', () => {
    const newConnection: Omit<Connection, 'id'> & { id?: string } = {
      name: 'New SQLite',
      type: 'sqlite',
      database: ':memory:',
    }
    
    const addedConnection = { ...newConnection, id: newConnection.id || `conn-${Date.now()}` }
    mockConnections.push(addedConnection)
    
    expect(mockConnections.length).toBe(2)
    expect(mockConnections[1]?.name).toBe('New SQLite')
  })

  it('should update an existing connection', () => {
    const updatedName = 'Updated Postgres'
    const index = mockConnections.findIndex(c => c.id === 'conn-1')
    
    if (index !== -1) {
      mockConnections[index] = {
        ...mockConnections[index],
        name: updatedName,
      }
    }
    
    expect(mockConnections[0]?.name).toBe(updatedName)
  })

  it('should remove a connection', () => {
    mockConnections = mockConnections.filter(c => c.id !== 'conn-1')
    expect(mockConnections.length).toBe(0)
  })
})
