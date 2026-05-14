import { describe, it, expect } from 'vitest'

describe('Performance Benchmarks', () => {
  it('should measure loop performance', () => {
    const start = performance.now()
    let sum = 0
    for (let i = 0; i < 1_000_000; i++) {
      sum += i
    }
    const end = performance.now()
    console.log(`Loop took ${end - start}ms`)
    expect(sum).toBe(499999500000)
  })

  it('should measure array operations', () => {
    const start = performance.now()
    const arr = Array.from({ length: 100_000 }, (_, i) => i)
    const mapped = arr.map(x => x * 2)
    const filtered = mapped.filter(x => x % 4 === 0)
    const end = performance.now()
    console.log(`Array operations took ${end - start}ms`)
    expect(filtered.length).toBe(25000)
  })

  it('should measure object creation', () => {
    const start = performance.now()
    const objects = Array.from({ length: 10_000 }, (_, i) => ({
      id: i,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      active: i % 2 === 0,
    }))
    const end = performance.now()
    console.log(`Object creation took ${end - start}ms`)
    expect(objects.length).toBe(10000)
    expect(objects[0]?.name).toBe('User 0')
  })
})
