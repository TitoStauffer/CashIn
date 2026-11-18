import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import type { CatalogApi, Category, PaymentMethod } from '../catalog/catalogApi'
import { amountToInput, parseAmountInput } from '../money/amount'
import { DATE_INVALID, formatDate, parseDateInput } from '../period/period'
import { ChoiceChips } from '../ui/ChoiceChips'
import { formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { colors, spacing, typography } from '../ui/theme'
import { balanceDebitedBy, type CreditCard, type Expense, type ExpenseApi, type ExpenseInput } from './expenseApi'

export const MISSING_CATEGORY = 'Escolha a categoria da despesa.'
/** The API's own message for a credit purchase without a card. */
export const MISSING_CARD = 'Selecione o cartão de crédito da compra.'
const NO_CATEGORIES = 'Cadastre uma categoria de saída em Categorias antes de lançar.'
const NO_CARDS = 'Nenhum cartão ativo nesta carteira. Os cartões são cadastrados na Web por enquanto.'
const NO_METHOD = ''

export type ExpenseOptions = { categories: Category[]; paymentMethods: PaymentMethod[]; creditCards: CreditCard[] }

type Draft = {
  amount: string
  date: string
  description: string
  categoryId: string
  subcategoryId: string
  paymentMethodId: string
  creditCardId: string
}

function draftFor(expense: Expense | null, today: string): Draft {
  if (!expense) return { amount: '', date: formatDate(today), description: '', categoryId: '', subcategoryId: '', paymentMethodId: NO_METHOD, creditCardId: '' }
  return {
    amount: amountToInput(expense.amount),
    date: formatDate(expense.date),
    description: expense.description ?? '',
    categoryId: expense.categoryId,
    subcategoryId: expense.subcategoryId ?? '',
    paymentMethodId: expense.paymentMethodId ?? NO_METHOD,
    creditCardId: expense.creditCardId ?? '',
  }
}

/**
 * What a new expense can use: active payment methods and cards, as the API requires for new records.
 * An edited expense also keeps the method and card it already has, even if they were deactivated since,
 * so editing its amount does not force another choice.
 */
export function selectableOptions(options: ExpenseOptions, expense: Expense | null) {
  return {
    paymentMethods: options.paymentMethods.filter((method) => method.isActive || method.id === expense?.paymentMethodId),
    creditCards: options.creditCards.filter((card) => card.isActive || card.id === expense?.creditCardId),
  }
}

/**
 * The fields of an expense, shared by the expense list and the quick entry of the home screen. It checks
 * what the person can fix before sending (amount, date, category and the card of a credit purchase) and
 * hands the exact decimal amount to `onSubmit`; every other refusal is the API's, shown by the screen.
 */
export function ExpenseForm({
  options,
  expense = null,
  today,
  busy,
  compact = false,
  submitLabel,
  onSubmit,
  onInvalid,
  onCancel,
}: {
  options: ExpenseOptions
  expense?: Expense | null
  today: string
  busy: boolean
  /** The quick entry: amount, category and payment only; date (today) and description stay hidden. */
  compact?: boolean
  submitLabel: string
  onSubmit(input: ExpenseInput): void
  onInvalid(message: string): void
  onCancel?(): void
}) {
  const [draft, setDraft] = useState(() => draftFor(expense, today))
  const { paymentMethods, creditCards } = selectableOptions(options, expense)
  const method = paymentMethods.find((candidate) => candidate.id === draft.paymentMethodId) ?? null
  const isCredit = method?.nature === 'credit_card'
  const category = options.categories.find((candidate) => candidate.id === draft.categoryId)

  const submit = () => {
    const amount = parseAmountInput(draft.amount)
    if (!amount.ok) return onInvalid(amount.message)
    const date = parseDateInput(draft.date)
    if (!date) return onInvalid(DATE_INVALID)
    if (!draft.categoryId) return onInvalid(MISSING_CATEGORY)
    if (isCredit && !draft.creditCardId) return onInvalid(MISSING_CARD)
    onSubmit({
      amount: amount.amount,
      date,
      description: draft.description.trim() || null,
      categoryId: draft.categoryId,
      subcategoryId: draft.subcategoryId || null,
      paymentMethodId: draft.paymentMethodId || null,
      // The API refuses a card on anything but a credit purchase, so a card chosen before switching to
      // another method is dropped here.
      creditCardId: isCredit ? draft.creditCardId : null,
    })
  }

  return (
    <View style={styles.form}>
      <TextField label="Valor (R$)" value={draft.amount} onChangeText={(amount) => setDraft({ ...draft, amount })} keyboardType="decimal-pad" placeholder="0,00" autoFocus={compact} />
      {compact ? null : (
        <>
          <TextField label="Data (DD/MM/AAAA)" value={draft.date} onChangeText={(date) => setDraft({ ...draft, date })} keyboardType="numbers-and-punctuation" />
          <TextField label="Descrição (opcional)" value={draft.description} onChangeText={(description) => setDraft({ ...draft, description })} />
        </>
      )}
      <Text style={styles.detail}>Categoria</Text>
      {options.categories.length === 0 ? <Text style={formStyles.body}>{NO_CATEGORIES}</Text> : (
        <ChoiceChips
          options={options.categories.map((item) => ({ value: item.id, label: item.name }))}
          value={draft.categoryId}
          onChange={(categoryId) => setDraft({ ...draft, categoryId, subcategoryId: '' })}
        />
      )}
      {!compact && category && category.subcategories.length > 0 ? (
        <>
          <Text style={styles.detail}>Subcategoria</Text>
          <ChoiceChips
            options={[{ value: '', label: 'Sem subcategoria' }, ...category.subcategories.map((item) => ({ value: item.id, label: item.name }))]}
            value={draft.subcategoryId}
            onChange={(subcategoryId) => setDraft({ ...draft, subcategoryId })}
          />
        </>
      ) : null}
      <Text style={styles.detail}>Forma de pagamento</Text>
      <ChoiceChips
        options={[
          { value: NO_METHOD, label: 'Sem forma de pagamento' },
          ...paymentMethods.map((item) => ({ value: item.id, label: item.isActive ? item.name : `${item.name} (inativa)` })),
        ]}
        value={draft.paymentMethodId}
        onChange={(paymentMethodId) => setDraft({ ...draft, paymentMethodId })}
      />
      <Text style={styles.detail}>{balanceDebitedBy(method?.nature ?? null)}</Text>
      {isCredit ? (
        <>
          <Text style={styles.detail}>Cartão de crédito</Text>
          {creditCards.length === 0 ? <Text style={formStyles.body}>{NO_CARDS}</Text> : (
            <ChoiceChips
              options={creditCards.map((card) => ({ value: card.id, label: card.isActive ? card.nickname : `${card.nickname} (inativo)` }))}
              value={draft.creditCardId}
              onChange={(creditCardId) => setDraft({ ...draft, creditCardId })}
            />
          )}
        </>
      ) : null}
      <PrimaryButton label={submitLabel} onPress={submit} busy={busy} />
      {onCancel ? <LinkButton label="Cancelar edição" onPress={onCancel} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: spacing.xs },
  detail: { fontSize: typography.caption, color: colors.textMuted },
})

/** Reads what the expense form offers in the active wallet: expense categories, payment methods and cards. */
export async function loadExpenseOptions(
  catalogApi: Pick<CatalogApi, 'listCategories' | 'listPaymentMethods'>,
  expenseApi: Pick<ExpenseApi, 'listCreditCards'>,
): Promise<ExpenseOptions> {
  const [categories, paymentMethods, creditCards] = await Promise.all([
    catalogApi.listCategories('expense'),
    catalogApi.listPaymentMethods(),
    expenseApi.listCreditCards(),
  ])
  return { categories: categories.items, paymentMethods: paymentMethods.items, creditCards: creditCards.items }
}
