import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { CategorySummary, DashboardApi, FinancialSummary, InvestmentGoal } from '../dashboard/dashboardApi'
import { formatPercentage, goalContribution, hasActivity, topCategories } from '../dashboard/dashboardView'
import { formatAmount, isZeroAmount } from '../money/amount'
import { monthLabel, monthOf, monthRange, shiftMonth } from '../period/period'
import { FormMessage, LinkButton } from '../ui/Form'
import { MonthSelector } from '../ui/MonthSelector'
import { LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar o resumo. Tente novamente.'

type Loaded = { key: string; current: FinancialSummary; previous: FinancialSummary; goals: InvestmentGoal[] }

const BENEFIT_LABELS: Record<string, string> = {
  food_meal_benefit: 'Cartão de benefícios (VA/VR)',
  food_benefit: 'Cartão de benefícios (VA/VR)',
  meal_benefit: 'Cartão de benefícios (VA/VR)',
  home_office_benefit: 'Auxílio home office (AHO)',
}

function Line({ label, amount, hint }: { label: string; amount: string; hint?: string }) {
  return (
    <View style={styles.line}>
      <View style={styles.lineText}>
        <Text style={styles.lineLabel}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <Text style={styles.amount}>{formatAmount(amount)}</Text>
    </View>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.section} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  )
}

function Ranking({ title, items }: { title: string; items: CategorySummary[] }) {
  if (items.length === 0) return null
  return (
    <Section title={title}>
      {topCategories(items).map((item) => <Line key={item.categoryId} label={item.categoryName} amount={item.amount} />)}
    </Section>
  )
}

/**
 * The home screen's summary of the active wallet in one month, read from `GET /financial-summary` for
 * the month and the one before it, plus the investment goals. Every amount shown is one the API sent:
 * the comparison puts the two months side by side instead of computing a variation, and transfers
 * between wallets stay in their own lines, never inside income or expense. Pull down to read again.
 */
export function DashboardScreen({
  walletId,
  dashboardApi,
  header,
  now = new Date(),
}: {
  walletId: string
  dashboardApi: DashboardApi
  /** The home screen's account and navigation, shown above the summary. */
  header: ReactNode
  now?: Date
}) {
  const [month, setMonth] = useState(() => monthOf(now))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const key = `${walletId}:${month}`

  useEffect(() => {
    let current = true
    const range = monthRange(month)
    const previousRange = monthRange(shiftMonth(month, -1))
    void Promise.all([
      dashboardApi.summary(range.from, range.to),
      dashboardApi.summary(previousRange.from, previousRange.to),
      dashboardApi.goals(),
    ])
      .then(([summary, previous, goals]) => {
        if (!current) return
        setLoaded({ key, current: summary, previous, goals: goals.items })
        setLoadError(null)
        setRefreshing(false)
      })
      .catch((error: unknown) => {
        if (!current) return
        setLoadError(messageOf(error, LOAD_FAILED))
        setRefreshing(false)
      })
    return () => { current = false }
  }, [dashboardApi, key, month, attempt])

  const refresh = useCallback(() => {
    setRefreshing(true)
    setAttempt((value) => value + 1)
  }, [])
  const data = loaded?.key === key ? loaded : null

  // Another wallet or month never shows the previous one's error (adjusted while rendering).
  const [errorKey, setErrorKey] = useState(key)
  if (errorKey !== key) {
    setErrorKey(key)
    setLoadError(null) // the previous wallet's or month's read error is not this one's
  }

  return (
    <ScrollView
      testID="dashboard"
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      {header}
      <MonthSelector month={month} onChange={setMonth} />
      {loadError ? (
        <View style={styles.card}>
          <FormMessage tone="error" message={loadError} />
          <LinkButton label="Tentar novamente" onPress={refresh} />
        </View>
      ) : null}
      {!data && !loadError ? <LoadingState label="Carregando resumo…" /> : null}
      {data ? <Summary data={data} month={month} /> : null}
    </ScrollView>
  )
}

function Summary({ data, month }: { data: Loaded; month: string }) {
  const { current, previous, goals } = data
  const transferOut = current.transferOutTotal ?? '0.00'
  const transferIn = current.transferInTotal ?? '0.00'
  const cardCredit = current.cardCreditTotal ?? '0.00'
  const unlinkedCredit = current.unlinkedCardCreditTotal ?? '0.00'
  const active = hasActivity(current)

  return (
    <>
      {active ? (
        <Section title="Resumo do mês">
          <Line label="Entradas" amount={current.incomeTotal} />
          <Line label="Despesas" amount={current.expenseTotal} />
          <Line label="Aportes em metas" amount={current.contributionTotal} />
          <Line label="Fluxo em dinheiro" amount={current.cashBalance} hint="O que entrou em dinheiro menos o que saiu do caixa no mês." />
          {!isZeroAmount(cardCredit) ? <Line label="Estornos de fatura" amount={cardCredit} hint="Já descontados das despesas." /> : null}
          {!isZeroAmount(unlinkedCredit) ? <Line label="Estornos sem compra identificada" amount={unlinkedCredit} hint="Reduzem as despesas, mas nenhuma categoria." /> : null}
        </Section>
      ) : (
        <Text style={styles.empty}>Nenhum lançamento em {monthLabel(month)}.</Text>
      )}

      {!isZeroAmount(transferOut) || !isZeroAmount(transferIn) ? (
        <Section title="Transferências entre carteiras">
          <Text style={styles.hint}>Não são entrada nem despesa: só mudam o dinheiro de carteira.</Text>
          <Line label="Enviadas" amount={transferOut} />
          <Line label="Recebidas" amount={transferIn} />
        </Section>
      ) : null}

      {current.benefitBalances.length > 0 ? (
        <Section title="Benefícios">
          {current.benefitBalances.map((benefit) => (
            <Line key={benefit.balanceType} label={BENEFIT_LABELS[benefit.balanceType] ?? benefit.balanceType} amount={benefit.amount} />
          ))}
        </Section>
      ) : null}

      <Section title="Comparação com o mês anterior">
        {[
          ['Entradas', previous.incomeTotal, current.incomeTotal],
          ['Despesas', previous.expenseTotal, current.expenseTotal],
          ['Aportes em metas', previous.contributionTotal, current.contributionTotal],
          ['Fluxo em dinheiro', previous.cashBalance, current.cashBalance],
        ].map(([label, before, now]) => (
          <View key={label} style={styles.compare}>
            <Text style={styles.lineLabel}>{label}</Text>
            <Text style={styles.hint}>Mês anterior: {formatAmount(before ?? '0.00')} · Este mês: {formatAmount(now ?? '0.00')}</Text>
          </View>
        ))}
      </Section>

      <Ranking title="Maiores despesas por categoria" items={current.expenseByCategory} />
      <Ranking title="Maiores entradas por categoria" items={current.incomeByCategory} />

      {goals.length > 0 ? (
        <Section title="Metas">
          {[...goals].sort((a, b) => a.title.localeCompare(b.title, 'pt-BR')).map((goal) => (
            <View key={goal.id} style={styles.compare}>
              <Text style={styles.lineLabel}>{goal.title}{goal.status === 'closed' ? ' · encerrada' : ''}</Text>
              <Text style={styles.hint}>
                Acumulado {formatAmount(goal.contributedAmount)} de {formatAmount(goal.targetAmount)} ({formatPercentage(goal.progressPercentage)})
              </Text>
              <Text style={styles.hint}>Aportes neste mês: {formatAmount(goalContribution(current, goal.id))}</Text>
            </View>
          ))}
        </Section>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.sm },
  section: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.sm },
  lineText: { flex: 1 },
  lineLabel: { fontSize: typography.body, color: colors.text },
  amount: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  hint: { fontSize: typography.caption, color: colors.textMuted },
  compare: { gap: spacing.xs },
  empty: { fontSize: typography.body, color: colors.textMuted, textAlign: 'center' },
})
