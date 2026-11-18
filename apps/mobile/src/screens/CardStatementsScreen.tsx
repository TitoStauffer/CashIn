import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import type { CreditCard, CreditCardApi, CreditCardStatement } from '../cards/creditCardApi'
import { formatAmount, parseAmountInput } from '../money/amount'
import { DATE_INVALID, formatDate, monthOf, monthRange, parseDateInput, todayIso } from '../period/period'
import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { MonthSelector } from '../ui/MonthSelector'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar as faturas. Tente novamente.'

type Loaded = { key: string; statements: CreditCardStatement[] }
type Payment = { statementId: string; date: string; amount: string } | null

function Line({ label, amount }: { label: string; amount: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.amount}>{formatAmount(amount)}</Text>
    </View>
  )
}

/**
 * The statements of one card that close in the chosen month, exactly as the API computes them:
 * purchases, refunds, total, payments and what is still owed are shown as sent, never recomputed. An
 * open statement takes a payment, in full (no amount: the API settles what is owed) or in part; a
 * refusal, such as refunds that already cover the purchases, is the API's message.
 */
export function CardStatementsScreen({
  card,
  cardApi,
  now = new Date(),
}: {
  /** Only what the screen shows and reads: the card id and its nickname. */
  card: Pick<CreditCard, 'id' | 'nickname'>
  cardApi: CreditCardApi
  now?: Date
}) {
  const [month, setMonth] = useState(() => monthOf(now))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [payment, setPayment] = useState<Payment>(null)
  const key = `${card.id}:${month}`

  useEffect(() => {
    let current = true
    const { from, to } = monthRange(month)
    void cardApi.listStatements(card.id, from, to)
      .then(({ items }) => {
        if (!current) return
        setLoaded({ key, statements: items })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [cardApi, card.id, key, month, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, key)
  const statements = loaded?.key === key ? loaded.statements : null

  // Another card or month starts clean (adjusted while rendering, the way React recommends).
  const [formKey, setFormKey] = useState(key)
  if (formKey !== key) {
    setFormKey(key)
    setPayment(null)
    setFeedback(null)
    setLoadError(null) // the previous card's or month's read error is not this one's
  }

  if (loadError && !statements) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />

  const pay = () => {
    if (!payment) return
    const date = parseDateInput(payment.date)
    if (!date) return setFeedback({ tone: 'error', message: DATE_INVALID })
    let amount: string | undefined
    if (payment.amount.trim()) {
      const parsed = parseAmountInput(payment.amount)
      if (!parsed.ok) return setFeedback({ tone: 'error', message: parsed.message })
      amount = parsed.amount
    }
    const { statementId } = payment
    void run(async () => {
      // Without an amount the API pays what is owed; the key is left out instead of sent empty.
      await cardApi.payStatement(card.id, statementId, amount ? { date, amount } : { date })
      return amount ? 'Pagamento parcial registrado.' : 'Fatura paga.'
    }, () => setPayment(null))
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Faturas de {card.nickname}</Text>
      <Text style={styles.detail}>Faturas que fecham no mês escolhido.</Text>
      <MonthSelector month={month} onChange={setMonth} />
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}
      {loadError ? (
        <View style={styles.card}>
          <FormMessage tone="error" message={loadError} />
          <LinkButton label="Tentar novamente" onPress={refresh} />
        </View>
      ) : null}

      {!statements ? <LoadingState label="Carregando faturas…" /> : null}
      {statements && statements.length === 0 ? <Text style={formStyles.body}>Nenhuma fatura fecha neste mês.</Text> : null}
      {statements?.map((statement) => {
        const settled = statement.paidDate !== null
        const paying = payment?.statementId === statement.id ? payment : null
        return (
          <View key={statement.id} style={styles.card}>
            <Text style={styles.primary}>Fecha em {formatDate(statement.closingDate)} · vence em {formatDate(statement.dueDate)}</Text>
            <Text style={styles.detail}>{settled ? `Liquidada em ${formatDate(statement.paidDate ?? '')}` : 'Em aberto'}</Text>
            <Line label="Compras" amount={statement.purchasesAmount} />
            <Line label="Estornos" amount={statement.creditsAmount} />
            <Line label="Total da fatura" amount={statement.totalAmount} />
            <Line label="Pagamentos" amount={statement.paymentsAmount} />
            <Line label="Falta pagar" amount={statement.outstandingAmount} />

            {statement.purchases.length > 0 ? <Text style={styles.section}>Compras</Text> : null}
            {statement.purchases.map((purchase) => (
              <Text key={purchase.id} style={styles.detail}>
                {formatDate(purchase.date)} · {purchase.description ?? purchase.categoryName} · {formatAmount(purchase.amount)}
              </Text>
            ))}
            {statement.credits.length > 0 ? <Text style={styles.section}>Estornos</Text> : null}
            {statement.credits.map((credit) => (
              <Text key={credit.id} style={styles.detail}>
                {formatDate(credit.date)} · {credit.description ?? 'Estorno'}{credit.originalExpenseId ? '' : ' (sem compra identificada)'} · {formatAmount(credit.amount)}
              </Text>
            ))}
            {statement.payments.length > 0 ? <Text style={styles.section}>Pagamentos</Text> : null}
            {statement.payments.map((item) => (
              <Text key={item.id} style={styles.detail}>
                {formatDate(item.date)} · {item.source === 'bank_statement' ? 'conciliado do extrato' : 'registrado à mão'} · {formatAmount(item.amount)}
              </Text>
            ))}

            {!settled && paying ? (
              <View style={styles.form}>
                <TextField label="Data do pagamento (DD/MM/AAAA)" value={paying.date} onChangeText={(date) => setPayment({ ...paying, date })} keyboardType="numbers-and-punctuation" />
                <TextField label="Valor pago (R$)" value={paying.amount} onChangeText={(amount) => setPayment({ ...paying, amount })} keyboardType="decimal-pad" placeholder={formatAmount(statement.outstandingAmount)} />
                <Text style={styles.detail}>Deixe o valor em branco para pagar o que falta. Com um valor menor, o pagamento é parcial.</Text>
                <PrimaryButton label="Registrar pagamento" onPress={pay} busy={busy} />
                <LinkButton label="Cancelar pagamento" onPress={() => setPayment(null)} />
              </View>
            ) : null}
            {!settled && !paying ? (
              <LinkButton
                label={`Pagar fatura que vence em ${formatDate(statement.dueDate)}`}
                onPress={() => setPayment({ statementId: statement.id, date: formatDate(todayIso(now)), amount: '' })}
              />
            ) : null}
          </View>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.xs },
  form: { gap: spacing.xs, marginTop: spacing.sm },
  section: { fontSize: typography.body, fontWeight: '600', color: colors.text, marginTop: spacing.sm },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  lineLabel: { fontSize: typography.body, color: colors.text },
  amount: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  primary: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  detail: { fontSize: typography.caption, color: colors.textMuted },
})
