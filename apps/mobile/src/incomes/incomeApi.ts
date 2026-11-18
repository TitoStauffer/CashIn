import type { ApiClient } from '../api/client'

/** Where the money goes. `food_benefit` and `meal_benefit` exist only on old records. */
export type IncomeBalanceType = 'cash' | 'food_benefit' | 'meal_benefit' | 'food_meal_benefit' | 'home_office_benefit'

export type Income = {
  id: string
  amount: string
  date: string
  description: string | null
  categoryId: string
  categoryName: string
  subcategoryId: string | null
  subcategoryName: string | null
  balanceType?: IncomeBalanceType
}

export type IncomeInput = {
  amount: string
  date: string
  description: string | null
  categoryId: string
  subcategoryId: string | null
  balanceType: IncomeBalanceType
}

/** The balances a new or edited income can go to; VA and VR share one benefit balance. */
export const INCOME_BALANCE_TYPES: { value: IncomeBalanceType; label: string }[] = [
  { value: 'cash', label: 'Dinheiro' },
  { value: 'food_meal_benefit', label: 'Cartão de benefícios (VA/VR)' },
  { value: 'home_office_benefit', label: 'Auxílio home office (AHO)' },
]

export const isLegacyBalanceType = (balanceType: IncomeBalanceType | undefined) =>
  balanceType === 'food_benefit' || balanceType === 'meal_benefit'

export function balanceTypeLabel(balanceType: IncomeBalanceType | undefined): string {
  if (balanceType === 'food_benefit') return 'Vale-alimentação (VA) · histórico'
  if (balanceType === 'meal_benefit') return 'Vale-refeição (VR) · histórico'
  return INCOME_BALANCE_TYPES.find((item) => item.value === (balanceType ?? 'cash'))?.label ?? ''
}

/**
 * The income routes of `docs/api.md`, in the active wallet. The amount travels as the decimal string the
 * person typed. `PUT` replaces every editable field, and the API normalizes an old VA or VR balance into
 * the unified one on any write, so an edit cannot keep it.
 */
export function createIncomeApi(request: ApiClient) {
  const path = (incomeId: string) => `/incomes/${encodeURIComponent(incomeId)}`
  return {
    list: (from: string, to: string) =>
      request<{ items: Income[] }>(`/incomes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    create: (input: IncomeInput) => request<Income>('/incomes', { method: 'POST', body: input }),
    update: (incomeId: string, input: IncomeInput) => request<Income>(path(incomeId), { method: 'PUT', body: input }),
    remove: (incomeId: string) => request<void>(path(incomeId), { method: 'DELETE' }),
  }
}

export type IncomeApi = ReturnType<typeof createIncomeApi>
