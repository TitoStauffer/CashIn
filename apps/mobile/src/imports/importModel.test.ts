import type { ImportItem } from './importApi'
import {
  adjacentClosingDates,
  calculateClosingDate,
  createDraft,
  currentReconciliation,
  describeImporter,
  describeMissingReconciliation,
  DISCARDED_MESSAGE,
  formatFileSize,
  effectiveClosingDate,
  importNames,
  isCsvConfigurationValid,
  itemDate,
  itemName,
  reconciliationOptions,
  sessionStatusLabel,
  typeOptions,
  withDate,
  withType,
} from './importModel'

const ITEM: ImportItem = {
  id: 't1', sequence: 3, date: '2026-11-05', description: 'Mercado', amount: '120.50', type: 'expense',
  categoryId: 'cat-1', subcategoryId: 'sub-1', validationStatus: 'valid', errorMessage: null, canEdit: true,
}

describe('importModel', () => {
  it('names a discarded preview apart from a failed import', () => {
    expect(sessionStatusLabel({ status: 'failed', failureMessage: DISCARDED_MESSAGE })).toBe('Descartada')
    expect(sessionStatusLabel({ status: 'failed', failureMessage: 'Arquivo inválido.' })).toBe('Falhou')
    expect(sessionStatusLabel({ status: 'preview', failureMessage: null })).toBe('Aguardando confirmação')
  })

  it('offers the types of each kind of import', () => {
    expect(typeOptions({ kind: 'bank_statement' }).map((option) => option.label)).toEqual(['Entrada', 'Saída', 'Transferência'])
    expect(typeOptions({ kind: 'credit_card_statement' })).toEqual([
      { value: 'expense', label: 'Compra' },
      { value: 'card_credit', label: 'Estorno/crédito na fatura' },
      { value: 'transfer', label: 'Pagamento da fatura' },
    ])
  })

  it('drops category and reconciliation on a new type, and the chosen statement on a new date', () => {
    const draft = { ...createDraft(ITEM), creditCardStatementId: 's1', statementClosingDate: '2026-11-10' }
    expect(withType(draft, 'transfer')).toEqual({
      ...draft, type: 'transfer', categoryId: null, subcategoryId: null,
      creditCardStatementId: null, transferCounterpartWalletId: null, walletTransferId: null,
    })
    expect(withDate(draft, '2026-11-20')).toEqual({ ...draft, date: '2026-11-20', statementClosingDate: null })
  })

  it('calculates the statement of a card item as the API does', () => {
    expect(calculateClosingDate('2026-11-10', 10)).toBe('2026-11-10')
    expect(calculateClosingDate('2026-11-11', 10)).toBe('2026-12-10')
    expect(calculateClosingDate('2026-02-10', 31)).toBe('2026-02-28')
    expect(adjacentClosingDates('2026-01-15', 10)).toEqual(['2026-01-10', '2026-02-10', '2026-03-10'])
  })

  it('names the statement a card item lands on: the chosen one, or the one its date calculates', () => {
    expect(effectiveClosingDate({ date: '2026-11-05', statementClosingDate: '2026-12-10' }, 10)).toBe('2026-12-10')
    expect(effectiveClosingDate({ date: '2026-11-05', statementClosingDate: null }, 10)).toBe('2026-11-10')
    expect(effectiveClosingDate({ date: '', statementClosingDate: null }, 10)).toBeNull()
    expect(effectiveClosingDate({ date: '2026-11-05' }, null)).toBeNull()
  })

  it('offers each reconciliation as one choice that clears the others', () => {
    const transfer: ImportItem = {
      ...ITEM, type: 'transfer', categoryId: null, subcategoryId: null,
      statementCandidates: [{ statementId: 's1', creditCardId: 'c1', creditCardName: 'Roxo', closingDate: '2026-11-01', dueDate: '2026-11-10', outstandingAmount: '120.50' }],
      transferCandidates: [{ walletTransferId: 'w1', counterpartWalletId: 'wal-2', counterpartWalletName: null, amount: '120.50', date: '2026-11-04', description: null, direction: 'outgoing' }],
      transferCounterpartWallets: [{ walletId: 'wal-3', walletName: 'Casa', isPersonal: false }],
    }
    const options = reconciliationOptions(transfer)
    expect(options.map((option) => option.label)).toEqual([
      'Fatura Roxo · vence 10/11/2026 · falta R$ 120,50',
      'Transferência para outra carteira · 04/11/2026 · R$ 120,50',
      'Nova transferência para Casa',
    ])
    expect(options.map((option) => option.changes)).toEqual([
      { creditCardStatementId: 's1', walletTransferId: null, transferCounterpartWalletId: null },
      { creditCardStatementId: null, walletTransferId: 'w1', transferCounterpartWalletId: 'wal-2' },
      { creditCardStatementId: null, walletTransferId: null, transferCounterpartWalletId: 'wal-3' },
    ])
    const draft = createDraft(transfer)
    expect(currentReconciliation(draft)).toBe('')
    expect(currentReconciliation({ ...draft, ...options[1]?.changes })).toBe('transfer:w1')
    expect(currentReconciliation({ ...draft, ...options[2]?.changes })).toBe('wallet:wal-3')
  })

  it('claims no direction without the candidates that decide it', () => {
    const transfer: ImportItem = { ...ITEM, type: 'transfer', transferCounterpartWallets: [{ walletId: 'wal-3', walletName: 'Casa', isPersonal: false }] }
    expect(reconciliationOptions(transfer).map((option) => option.label)).toEqual(['Nova transferência com Casa'])
  })

  it('says why nothing can be reconciled, by the reason the API gave', () => {
    expect(describeMissingReconciliation({ ...ITEM, reconciliationUnavailableReason: 'not_a_transfer' })).toContain('salva como saída')
    expect(describeMissingReconciliation({ ...ITEM, reconciliationUnavailableReason: 'card_payment' })).toContain('pagamento de fatura')
    expect(describeMissingReconciliation({ ...ITEM, reconciliationUnavailableReason: null })).toContain('Nenhuma fatura em aberto')
    expect(describeMissingReconciliation({ ...ITEM, canEdit: false })).toBe('Esta movimentação não tem conciliação disponível nesta prévia.')
  })

  it('names who imported without inventing an unknown person', () => {
    expect(describeImporter({ importedBy: { userId: 'u1', email: 'eu@exemplo.com', isCurrentUser: true } })).toBe('importado por você')
    expect(describeImporter({ importedBy: { userId: 'u2', email: 'outra@exemplo.com', isCurrentUser: false } })).toBe('importado por outra@exemplo.com')
    expect(describeImporter({ importedBy: { userId: 'u2', email: null, isCurrentUser: false } })).toBe('importado por outro membro da carteira')
  })

  it('formats file sizes', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2,0 KB')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3,0 MB')
  })

  it('accepts a CSV layout only with the date and exactly one money layout, on columns of this file', () => {
    const columns = [{ index: 0 }, { index: 1 }, { index: 2 }]
    const layout = {
      delimiter: ';' as const, encoding: 'utf-8' as const, hasHeader: true, dateFormat: 'dd/MM/yyyy' as const, numberFormat: 'pt-BR' as const,
      columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
    }
    expect(isCsvConfigurationValid(layout, columns)).toBe(true)
    expect(isCsvConfigurationValid({ ...layout, columns: { ...layout.columns, amount: null, credit: 2, debit: 1, description: null } }, columns)).toBe(true)
    expect(isCsvConfigurationValid({ ...layout, columns: { ...layout.columns, amount: null } }, columns)).toBe(false)
    expect(isCsvConfigurationValid({ ...layout, columns: { ...layout.columns, credit: 1 } }, columns)).toBe(false)
    expect(isCsvConfigurationValid({ ...layout, columns: { ...layout.columns, amount: null, credit: 2, debit: null } }, columns)).toBe(false)
    expect(isCsvConfigurationValid({ ...layout, columns: { ...layout.columns, description: 2 } }, columns)).toBe(false)
    expect(isCsvConfigurationValid({ ...layout, columns: { ...layout.columns, amount: 3 } }, columns)).toBe(false)
    expect(isCsvConfigurationValid(null, columns)).toBe(false)
  })

  it('names each import and item uniquely (rule 23)', () => {
    const one = { fileName: 'extrato.ofx', createdAt: '2026-11-18T12:00:00.000Z' }
    expect(importNames([one, one, { ...one, fileName: 'fatura.ofx' }])).toEqual([
      'importação de extrato.ofx em 18/11/2026, 1ª da lista',
      'importação de extrato.ofx em 18/11/2026, 2ª da lista',
      'importação de fatura.ofx em 18/11/2026',
    ])
    expect(itemName(ITEM)).toBe('movimentação 3 de 05/11/2026, R$ 120,50 (Mercado)')
    expect(itemName({ ...ITEM, date: '', description: null })).toBe('movimentação 3 de data inválida, R$ 120,50')
    expect(itemDate({ date: '' })).toBe('data inválida')
  })
})
