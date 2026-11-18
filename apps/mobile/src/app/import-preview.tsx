import { Redirect, useLocalSearchParams } from 'expo-router'

import { appCatalogApi, appImportApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { ImportPreviewScreen } from '../screens/ImportPreviewScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function ImportPreview() {
  const { importId } = useLocalSearchParams<{ importId?: string }>()
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  if (!importId) return <ErrorState message="Importação não encontrada." />
  // The import belongs to the active wallet; the API answers 404 for an import of another wallet.
  return <ImportPreviewScreen key={`${gate.wallet.id}:${importId}`} importId={importId} importApi={appImportApi} catalogApi={appCatalogApi} />
}
