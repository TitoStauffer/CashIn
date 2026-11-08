import { describe, expect, it } from 'vitest'
import { canLearnRuleFromItem, hasDraftChanged } from './importsModel'
import type { FinancialImportItem, FinancialImportItemInput } from './importsApi'

// A closing day of 10 puts a purchase on 2026-10-05 in the statement that closes on 2026-10-10.
const closingDay = 10

function cardItem(overrides: Partial<FinancialImportItem> = {}): FinancialImportItem {
  return {
    id: 'item-1',
    sequence: 1,
    date: '2026-10-05',
    description: 'MERCADO',
    amount: '100.00',
    type: 'expense',
    categoryId: 'category-1',
    subcategoryId: null,
    validationStatus: 'valid',
    errorMessage: null,
    canEdit: true,
    statementClosingDate: '2026-10-10',
    creditCardStatementId: null,
    transferCounterpartWalletId: null,
    walletTransferId: null,
    ...overrides,
  }
}

function draftOf(item: FinancialImportItem, overrides: Partial<FinancialImportItemInput> = {}): FinancialImportItemInput {
  return {
    date: item.date,
    description: item.description ?? '',
    type: item.type,
    categoryId: item.categoryId,
    subcategoryId: item.subcategoryId,
    statementClosingDate: item.statementClosingDate ?? null,
    creditCardStatementId: null,
    transferCounterpartWalletId: null,
    walletTransferId: null,
    ...overrides,
  }
}

describe('hasDraftChanged in a card statement session', () => {
  // Changing the date clears `statementClosingDate`, so returning to the original date used to leave
  // the draft marked as changed — and a changed draft blocks the confirmation until the item is saved.
  it('treats a cleared statement as the one the date calculates', () => {
    const item = cardItem()
    const draft = draftOf(item, { statementClosingDate: null })

    expect(hasDraftChanged(item, draft, closingDay)).toBe(false)
  })

  it('still reports a change when the date really moved to another statement', () => {
    const item = cardItem()
    const draft = draftOf(item, { date: '2026-10-20', statementClosingDate: null })

    expect(hasDraftChanged(item, draft, closingDay)).toBe(true)
  })

  // The explicit choice of a neighbouring statement is lost when the date changes, so clearing it is
  // a real change: the line would land on a different statement than the user picked.
  it('reports a change when a chosen neighbouring statement was cleared', () => {
    const item = cardItem({ statementClosingDate: '2026-11-10' })
    const draft = draftOf(item, { statementClosingDate: null })

    expect(hasDraftChanged(item, draft, closingDay)).toBe(true)
  })

  it('compares the raw field outside a card session, where the statement is never offered', () => {
    const item = cardItem()
    const draft = draftOf(item, { statementClosingDate: null })

    expect(hasDraftChanged(item, draft, null)).toBe(true)
  })

  it('reports a change in the fields that have nothing to do with the statement', () => {
    const item = cardItem()

    expect(hasDraftChanged(item, draftOf(item, { description: 'MERCADO CENTRAL' }), closingDay)).toBe(true)
    expect(hasDraftChanged(item, draftOf(item), closingDay)).toBe(false)
    expect(hasDraftChanged(item, undefined, closingDay)).toBe(false)
  })
})

describe('canLearnRuleFromItem', () => {
  // The rule button and the confirmation have to agree on what "changed" means. While this consumer
  // compared the raw field, going back to the original date released the confirmation and still hid
  // the button, with no reason the user could see.
  it('offers the rule again once the date is back to the one the statement was derived from', () => {
    const item = cardItem({ categorizationSource: 'manual' })
    const draft = draftOf(item, { date: '2026-10-05', statementClosingDate: null })

    expect(canLearnRuleFromItem(item, draft, closingDay)).toBe(true)
  })

  it('keeps the rule hidden while a real change is pending', () => {
    const item = cardItem({ categorizationSource: 'manual' })
    const draft = draftOf(item, { description: 'MERCADO CENTRAL' })

    expect(canLearnRuleFromItem(item, draft, closingDay)).toBe(false)
  })

  it('does not offer the rule for an item the user never categorized by hand', () => {
    const item = cardItem({ categorizationSource: 'rule' })

    expect(canLearnRuleFromItem(item, draftOf(item), closingDay)).toBe(false)
  })
})
