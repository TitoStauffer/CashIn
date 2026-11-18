import { Redirect, useRouter } from 'expo-router'

import { useSession } from '../auth/SessionProvider'
import { HomeScreen } from '../screens/HomeScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { useWallets } from '../wallets/WalletProvider'

// Route files only wire screens: tests and components live outside src/app, where every file is a route.
export default function Index() {
  const router = useRouter()
  const { state, signOut, retryRestore } = useSession()
  const { activeWallet, state: walletState } = useWallets()
  if (state.status === 'restoring') return <LoadingState label="Verificando sua sessão…" />
  if (state.status === 'unavailable') return <ErrorState message={state.message} onRetry={retryRestore} />
  if (state.status === 'signedOut') return <Redirect href="/login" />
  return <HomeScreen user={state.user} activeWallet={activeWallet} walletError={walletState.status === 'error' ? walletState.message : null} onOpenWallets={() => router.push('/wallets')} onSignOut={signOut} />
}
