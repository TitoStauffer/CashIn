/**
 * Money as the API carries it: a decimal string with up to two places ("1250.50"). Nothing here goes
 * through a JavaScript number, so a typed "0,10" reaches the API as "0.10" and never as 0.1 or
 * 0.10000000000000001.
 */

const MAX_INTEGER_DIGITS = 12

export const AMOUNT_REQUIRED = 'Informe o valor.'
export const AMOUNT_NOT_POSITIVE = 'O valor deve ser maior que zero.'
export const AMOUNT_INVALID = 'Informe o valor com até duas casas decimais, por exemplo 1250,50.'

export type ParsedAmount = { ok: true; amount: string } | { ok: false; message: string }

/**
 * Reads what the person typed. Comma and dot are both the decimal separator, because the phone's
 * decimal keyboard offers either one depending on its language; there is no thousands separator, so
 * "1.250" is refused instead of being guessed as 1250 or 1.25. A minus sign is refused: an income or an
 * expense is always a positive amount.
 */
export function parseAmountInput(text: string): ParsedAmount {
  const value = text.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!value) return { ok: false, message: AMOUNT_REQUIRED }
  if (value.startsWith('-')) return { ok: false, message: AMOUNT_NOT_POSITIVE }
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value)
  if (!match) return { ok: false, message: AMOUNT_INVALID }
  const integer = (match[1] ?? '').replace(/^0+(?=\d)/, '')
  if (integer.length > MAX_INTEGER_DIGITS) return { ok: false, message: AMOUNT_INVALID }
  const amount = `${integer}.${(match[2] ?? '').padEnd(2, '0')}`
  if (/^0\.00$/.test(amount)) return { ok: false, message: AMOUNT_NOT_POSITIVE }
  return { ok: true, amount }
}

function groupThousands(integer: string): string {
  const groups: string[] = []
  for (let end = integer.length; end > 0; end -= 3) groups.unshift(integer.slice(Math.max(0, end - 3), end))
  return groups.join('.')
}

/** "1250.5" → "R$ 1.250,50", by string manipulation only. */
export function formatAmount(amount: string): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount)
  if (!match) return amount
  const integer = (match[2] ?? '').replace(/^0+(?=\d)/, '')
  return `${match[1]}R$ ${groupThousands(integer)},${(match[3] ?? '').padEnd(2, '0')}`
}

/** The API amount back in the field, the way the person would type it: "1250.50" → "1250,50". */
export function amountToInput(amount: string): string {
  return amount.replace('.', ',')
}

type Decimal = { units: bigint; scale: number }

/**
 * Any decimal the API may send, kept at its own scale, or null when the text is not a decimal. The
 * contract promises cents, but an amount with more places is read whole instead of being taken for zero
 * (Code Review of PR #126).
 */
function parseDecimal(amount: string): Decimal | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim())
  if (!match) return null
  const fraction = match[3] ?? ''
  const units = BigInt(`${match[2] ?? '0'}${fraction}`)
  return { units: match[1] ? -units : units, scale: fraction.length }
}

const atScale = (decimal: Decimal, scale: number) => decimal.units * 10n ** BigInt(scale - decimal.scale)

/**
 * Orders two API amounts without a floating point number: negative, zero or positive like `a - b`.
 * Text that is not a decimal sorts below every amount.
 */
export function compareAmounts(a: string, b: string): number {
  const first = parseDecimal(a)
  const second = parseDecimal(b)
  if (!first || !second) return first ? 1 : second ? -1 : 0
  const scale = Math.max(first.scale, second.scale)
  const difference = atScale(first, scale) - atScale(second, scale)
  return difference === 0n ? 0 : difference > 0n ? 1 : -1
}

/** Only a real zero is zero: text that is not a decimal never counts as an empty amount. */
export function isZeroAmount(amount: string): boolean {
  const decimal = parseDecimal(amount)
  return decimal !== null && decimal.units === 0n
}
