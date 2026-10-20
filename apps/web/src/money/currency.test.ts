import { describe, expect, it } from 'vitest'
import {
  formatBrazilianCurrency,
  formatBrazilianCurrencyInput,
  hasInvalidBrazilianCurrencyInput,
  isPositiveCurrencyAmount,
  maskBrazilianCurrencyInput,
  parseBrazilianCurrencyInput,
} from './currency'

describe('Brazilian currency helpers', () => {
  it('masks digits with grouping and up to two decimal places', () => {
    expect(maskBrazilianCurrencyInput('1234567,89')).toBe('1.234.567,89')
    expect(maskBrazilianCurrencyInput('1234567,891')).toBe('1.234.567,89')
    expect(maskBrazilianCurrencyInput('R$ 1234567,8')).toBe('1.234.567,8')
    expect(maskBrazilianCurrencyInput('')).toBe('')
    expect(maskBrazilianCurrencyInput(',')).toBe('0,')
  })

  it('limits input to the integer precision of numeric(14,2)', () => {
    expect(maskBrazilianCurrencyInput('999999999999,99')).toBe('999.999.999.999,99')
    expect(maskBrazilianCurrencyInput('1234567890123,99')).toBe('123.456.789.012,99')
    expect(parseBrazilianCurrencyInput('999.999.999.999,99')).toBe('999999999999.99')
    expect(parseBrazilianCurrencyInput('1.000.000.000.000,00')).toBeNull()
  })

  it('flags invalid pasted characters and excess decimal places instead of silently accepting them', () => {
    expect(hasInvalidBrazilianCurrencyInput('123abc')).toBe(true)
    expect(hasInvalidBrazilianCurrencyInput('1,239')).toBe(true)
    expect(hasInvalidBrazilianCurrencyInput('1.23')).toBe(true)
    expect(hasInvalidBrazilianCurrencyInput('1.234,56')).toBe(false)
    expect(hasInvalidBrazilianCurrencyInput('1234,56')).toBe(false)
  })

  it('converts localized input into a canonical decimal string without floating point', () => {
    expect(parseBrazilianCurrencyInput('1.234,56')).toBe('1234.56')
    expect(parseBrazilianCurrencyInput('00012,3')).toBe('12.30')
    expect(parseBrazilianCurrencyInput('1234')).toBe('1234.00')
    expect(parseBrazilianCurrencyInput('1,234')).toBeNull()
    expect(parseBrazilianCurrencyInput('1,')).toBe('1.00')
    expect(parseBrazilianCurrencyInput('0,00')).toBeNull()
  })

  it('formats canonical values without converting them to JavaScript numbers', () => {
    expect(formatBrazilianCurrency('999999999999.99')).toBe('R$ 999.999.999.999,99')
    expect(formatBrazilianCurrency('0.01')).toBe('R$ 0,01')
    expect(formatBrazilianCurrencyInput('1234.5')).toBe('1.234,50')
    expect(formatBrazilianCurrency('1000000000000.00')).toBe('R$ 0,00')
  })

  it('checks positivity from the decimal string', () => {
    expect(isPositiveCurrencyAmount('0.00')).toBe(false)
    expect(isPositiveCurrencyAmount('0.01')).toBe(true)
  })
})
