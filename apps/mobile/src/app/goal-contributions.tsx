import { Redirect, useLocalSearchParams } from 'expo-router'

import { appGoalApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { GoalContributionsScreen } from '../screens/GoalContributionsScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function GoalContributions() {
  const { goalId, title, status } = useLocalSearchParams<{ goalId?: string; title?: string; status?: string }>()
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  if (!goalId) return <ErrorState message="Meta não encontrada." />
  // The goal belongs to the active wallet; the API answers 404 for a goal of another wallet, and 409 to
  // any change to a closed one even if the status passed here were stale.
  return (
    <GoalContributionsScreen
      key={`${gate.wallet.id}:${goalId}`}
      goal={{ id: goalId, title: title ?? 'meta', status: status === 'closed' ? 'closed' : 'active' }}
      goalApi={appGoalApi}
    />
  )
}
