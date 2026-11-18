import { Redirect, useLocalSearchParams } from 'expo-router'
import { Share } from 'react-native'

import { appWalletApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { sessionRedirect } from '../auth/sessionRedirect'
import { WalletSharingScreen } from '../screens/WalletSharingScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { useWallets } from '../wallets/WalletProvider'

export default function WalletSharing() {
  const { walletId } = useLocalSearchParams<{ walletId?: string }>()
  const { state: session } = useSession()
  const { state, reload } = useWallets()
  const redirect = sessionRedirect(session)
  if (redirect) return <Redirect href={redirect} />
  if (state.status === 'error') return <ErrorState message={state.message} onRetry={reload} />
  if (state.status !== 'ready') return <LoadingState label="Carregando carteiras…" />
  const wallet = state.wallets.find((candidate) => candidate.id === walletId)
  if (!wallet) return <ErrorState message="Carteira não encontrada." />
  return (
    <WalletSharingScreen
      wallet={wallet}
      walletApi={appWalletApi}
      onShareLink={async (url) => { await Share.share({ message: url }) }}
    />
  )
}
