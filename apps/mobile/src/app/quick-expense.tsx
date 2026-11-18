import { Redirect, useRouter } from 'expo-router'

import { appCatalogApi, appExpenseApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { QuickExpenseScreen } from '../screens/QuickExpenseScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function QuickExpense() {
  const router = useRouter()
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  return (
    <QuickExpenseScreen
      walletId={gate.wallet.id}
      walletName={gate.wallet.name}
      expenseApi={appExpenseApi}
      catalogApi={appCatalogApi}
      onOpenExpenses={() => router.replace('/expenses')}
    />
  )
}
