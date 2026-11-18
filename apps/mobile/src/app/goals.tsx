import { Redirect, useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'

import { appCatalogApi, appGoalApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { GoalsScreen } from '../screens/GoalsScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function Goals() {
  const router = useRouter()
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  // Coming back from the contributions changes the progress, so the list is read again on each return.
  const [refreshKey, setRefreshKey] = useState(0)
  const focusedBefore = useRef(false)
  useFocusEffect(useCallback(() => {
    if (focusedBefore.current) setRefreshKey((value) => value + 1)
    focusedBefore.current = true
  }, []))

  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  return (
    <GoalsScreen
      walletId={gate.wallet.id}
      goalApi={appGoalApi}
      catalogApi={appCatalogApi}
      refreshKey={refreshKey}
      onOpenContributions={(goal) => router.push({ pathname: '/goal-contributions', params: { goalId: goal.id, title: goal.title, status: goal.status } })}
    />
  )
}
