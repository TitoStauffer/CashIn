import { Redirect } from 'expo-router'

import { appCatalogApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { CategoriesScreen } from '../screens/CategoriesScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function Categories() {
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  return <CategoriesScreen walletId={gate.wallet.id} catalogApi={appCatalogApi} />
}
