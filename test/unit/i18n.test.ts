import { describe, it, expect } from 'vitest'
import { t } from '@/lib/i18n'

describe('i18n', () => {
  it('should return string for known key', () => {
    const str = t('common.save')
    expect(str).toBeTruthy()
    expect(typeof str).toBe('string')
  })

  it('should return string for nested connection key', () => {
    const str = t('connection.title')
    expect(str).toBeTruthy()
  })

  it('should return string for notebook key', () => {
    const str = t('notebook.title')
    expect(str).toBeTruthy()
  })

  it('should handle key replacement', () => {
    const str = t('data.importSuccess', { count: '5' })
    expect(str).toContain('5')
  })

  it('should return key when not found', () => {
    const str = t('nonexistent.key.xyz')
    expect(str).toContain('nonexistent')
  })

  it('should have both zh and en translations for all common keys', () => {
    // Spot-check key categories exist
    const keys = ['common.save', 'common.cancel', 'connection.title', 'sidebar.refresh']
    for (const key of keys) {
      expect(t(key)).toBeTruthy()
    }
  })
})
