import { Redirect, useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'

import { appCreditCardApi, appImportApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { pickImportFile } from '../imports/pickImportFile'
import { ImportsScreen } from '../screens/ImportsScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function Imports() {
  const router = useRouter()
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  // Coming back from a preview may have confirmed, discarded or undone it, so the history is read again.
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
    <ImportsScreen
      walletId={gate.wallet.id}
      importApi={appImportApi}
      cardApi={appCreditCardApi}
      pickFile={() => pickImportFile()}
      refreshKey={refreshKey}
      onOpenImport={(importId) => router.push({ pathname: '/import-preview', params: { importId } })}
      onOpenRules={() => router.push('/import-rules')}
    />
  )
}
