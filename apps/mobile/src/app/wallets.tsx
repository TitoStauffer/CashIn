import { Redirect, useRouter } from 'expo-router'

import { useSession } from '../auth/SessionProvider'
import { sessionRedirect } from '../auth/sessionRedirect'
import { WalletsScreen } from '../screens/WalletsScreen'
import { useWallets } from '../wallets/WalletProvider'

export default function Wallets() {
  const router = useRouter()
  const { state: session } = useSession()
  const { state, selectWallet, createWallet, reload, dismissNotice } = useWallets()
  const redirect = sessionRedirect(session)
  if (redirect) return <Redirect href={redirect} />
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
