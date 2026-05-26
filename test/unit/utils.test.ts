import { describe, it, expect } from 'vitest'
import { cn } from '@/lib/utils'

describe('utils', () => {
  describe('cn', () => {
    it('should merge classes', () => {
      expect(cn('foo', 'bar')).toContain('foo')
      expect(cn('foo', 'bar')).toContain('bar')
    })

    it('should handle conditional classes', () => {
      expect(cn('base', false && 'hidden', 'visible')).toContain('base')
      expect(cn('base', false && 'hidden', 'visible')).toContain('visible')
    })

    it('should handle empty input', () => {
      expect(cn()).toBe('')
    })

    it('should merge tailwind conflicts', () => {
      const result = cn('px-2 py-1', 'px-4')
      expect(result).toContain('px-4')
      expect(result).not.toContain('px-2')
    })
  })
})
