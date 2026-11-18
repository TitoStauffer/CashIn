import { Redirect } from 'expo-router'

import { appCatalogApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { PaymentMethodsScreen } from '../screens/PaymentMethodsScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function PaymentMethods() {
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  return <PaymentMethodsScreen walletId={gate.wallet.id} catalogApi={appCatalogApi} />
}
