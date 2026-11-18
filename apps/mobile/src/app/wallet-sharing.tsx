import { Redirect, useLocalSearchParams } from 'expo-router'
import { Share } from 'react-native'

import { appWalletApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { WalletSharingScreen } from '../screens/WalletSharingScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { useWallets } from '../wallets/WalletProvider'

export default function WalletSharing() {
  const { walletId } = useLocalSearchParams<{ walletId?: string }>()
  const { state: session } = useSession()
  const { state } = useWallets()
  if (session.status === 'signedOut') return <Redirect href="/login" />
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
