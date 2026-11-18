import { Redirect, useRouter } from 'expo-router'

import { useSession } from '../auth/SessionProvider'
import { WalletsScreen } from '../screens/WalletsScreen'
import { useWallets } from '../wallets/WalletProvider'

export default function Wallets() {
  const router = useRouter()
  const { state: session } = useSession()
  const { state, selectWallet, createWallet, reload, dismissNotice } = useWallets()
  if (session.status === 'signedOut') return <Redirect href="/login" />
  return (
    <WalletsScreen
      state={state}
      onSelect={selectWallet}
      onCreate={createWallet}
      onManage={(walletId) => router.push({ pathname: '/wallet-sharing', params: { walletId } })}
      onRetry={reload}
      onDismissNotice={dismissNotice}
    />
  )
}
