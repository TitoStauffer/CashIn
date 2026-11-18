import { AMOUNT_INVALID, AMOUNT_NOT_POSITIVE, AMOUNT_REQUIRED, amountToInput, formatAmount, parseAmountInput } from './amount'

describe('parseAmountInput', () => {
  it.each([
    ['0,10', '0.10'],
    ['0.10', '0.10'],
    ['0,1', '0.10'],
    ['1250,50', '1250.50'],
    ['1250.5', '1250.50'],
    ['1250', '1250.00'],
    ['R$ 7,05', '7.05'],
    ['007,30', '7.30'],
    ['999999999999,99', '999999999999.99'],
  ])('keeps the exact decimal typed: %s → %s', (typed, amount) => {
    expect(parseAmountInput(typed)).toEqual({ ok: true, amount })
  })

  it('never goes through a floating point number', () => {
    // 0.1 + 0.2 is 0.30000000000000004 as a number; as text it stays what was typed.
    expect(parseAmountInput('0,30')).toEqual({ ok: true, amount: '0.30' })
    expect(parseAmountInput('123456789012,34')).toEqual({ ok: true, amount: '123456789012.34' })
  })

  it.each([
    ['', AMOUNT_REQUIRED],
    ['   ', AMOUNT_REQUIRED],
    ['-5,00', AMOUNT_NOT_POSITIVE],
    ['0', AMOUNT_NOT_POSITIVE],
    ['0,00', AMOUNT_NOT_POSITIVE],
    ['1,234', AMOUNT_INVALID],
    ['1.250,50', AMOUNT_INVALID],
    ['1.250', AMOUNT_INVALID],
    ['12a', AMOUNT_INVALID],
    [',50', AMOUNT_INVALID],
    ['1234567890123', AMOUNT_INVALID],
  ])('refuses %j', (typed, message) => {
    expect(parseAmountInput(typed)).toEqual({ ok: false, message })
  })
})

describe('formatAmount', () => {
  it.each([
    ['1250.50', 'R$ 1.250,50'],
    ['0.1', 'R$ 0,10'],
    ['7', 'R$ 7,00'],
    ['1234567.89', 'R$ 1.234.567,89'],
    ['-30.00', '-R$ 30,00'],
  ])('%s → %s', (amount, text) => {
    expect(formatAmount(amount)).toBe(text)
  })

  it('puts the amount back in the field the way it is typed', () => {
    expect(amountToInput('1250.50')).toBe('1250,50')
  })
})
