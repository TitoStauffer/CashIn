import { Redirect } from 'expo-router'

import { appCatalogApi, appIncomeApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { IncomesScreen } from '../screens/IncomesScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function Incomes() {
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  return <IncomesScreen walletId={gate.wallet.id} incomeApi={appIncomeApi} catalogApi={appCatalogApi} />
}
