const MAX_INTEGER_DIGITS = 12

function groupIntegerDigits(integer: string) {
  const groups: string[] = []
  for (let end = integer.length; end > 0; end -= 3) {
    groups.push(integer.slice(Math.max(0, end - 3), end))
  }
  return groups.reverse().join('.')
}

export function hasInvalidBrazilianCurrencyInput(value: string) {
  const normalized = value.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!normalized) return false
  if (!/^[\d.,]+$/.test(normalized) || (normalized.match(/,/g)?.length ?? 0) > 1) return true

  const [integer, fraction] = normalized.split(',')
  if (fraction !== undefined && fraction.length > 2) return true
  if (integer.includes('.')) {
    const groups = integer.split('.')
    if (groups[0].length < 1 || groups[0].length > 3 || groups.slice(1).some((group) => group.length !== 3)) return true
  }
  if (integer.replace(/\./g, '').replace(/^0+/, '').length > MAX_INTEGER_DIGITS) return true
  return false
}

export function maskBrazilianCurrencyInput(value: string) {
  const cleaned = value
    .replace(/^\s*R\$\s*/i, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(/[^\d,]/g, '')

  if (!/\d/.test(cleaned)) return cleaned.includes(',') ? '0,' : ''

  const commaIndex = cleaned.indexOf(',')
  const hasDecimalSeparator = commaIndex >= 0
  const integerInput = hasDecimalSeparator ? cleaned.slice(0, commaIndex) : cleaned
  const fractionInput = hasDecimalSeparator ? cleaned.slice(commaIndex + 1).replace(/,/g, '').slice(0, 2) : ''
  const normalizedInteger = (integerInput || '0').replace(/^0+(?=\d)/, '').slice(0, MAX_INTEGER_DIGITS)
  const groupedInteger = groupIntegerDigits(normalizedInteger)

  return `${groupedInteger}${hasDecimalSeparator ? `,${fractionInput}` : ''}`
}

export function parseBrazilianCurrencyInput(value: string) {
  const normalized = value.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!normalized || hasInvalidBrazilianCurrencyInput(normalized)) return null

  const [integerInput, fractionInput = ''] = normalized.replace(/\./g, '').split(',')
  const integer = integerInput.replace(/^0+(?=\d)/, '')
  const fraction = fractionInput.padEnd(2, '0')
  const canonical = `${integer}.${fraction}`
  return /^0+\.0{2}$/.test(canonical) ? null : canonical
}

export function formatBrazilianCurrency(amount: string) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount)
  if (!match) return 'R$ 0,00'

  const sign = match[1]
  const integer = match[2].replace(/^0+(?=\d)/, '')
  if (integer.length > MAX_INTEGER_DIGITS) return 'R$ 0,00'
  const fraction = (match[3] ?? '').padEnd(2, '0')
  const groupedInteger = groupIntegerDigits(integer)
  return `${sign}R$ ${groupedInteger},${fraction}`
}

export function formatBrazilianCurrencyInput(amount: string) {
  const formatted = formatBrazilianCurrency(amount)
  return formatted.replace(/^R\$\s*/, '')
}

export function isPositiveCurrencyAmount(amount: string) {
  return !/^0+\.0{2}$/.test(amount)
}
