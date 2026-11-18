import { Redirect } from 'expo-router'

import { appCatalogApi, appExpenseApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { ExpensesScreen } from '../screens/ExpensesScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function Expenses() {
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  return <ExpensesScreen walletId={gate.wallet.id} expenseApi={appExpenseApi} catalogApi={appCatalogApi} />
}
