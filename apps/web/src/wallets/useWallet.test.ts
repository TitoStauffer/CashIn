import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useWallet } from './useWallet'

describe('useWallet', () => {
  it('throws when rendered outside WalletProvider', () => {
    expect(() => renderHook(() => useWallet())).toThrow('useWallet must be used within WalletProvider')
  })
})
