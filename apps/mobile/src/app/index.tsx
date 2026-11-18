import { Redirect, useRouter } from 'expo-router'

import { appDashboardApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { DashboardScreen } from '../screens/DashboardScreen'
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

  const home = (embedded: boolean) => (
    <HomeScreen
      user={state.user}
      activeWallet={activeWallet}
      walletError={walletState.status === 'error' ? walletState.message : null}
      embedded={embedded}
      onOpenWallets={() => router.push('/wallets')}
      onQuickExpense={() => router.push('/quick-expense')}
      onOpenExpenses={() => router.push('/expenses')}
      onOpenIncomes={() => router.push('/incomes')}
      onOpenCategories={() => router.push('/categories')}
      onOpenPaymentMethods={() => router.push('/payment-methods')}
      onSignOut={signOut}
    />
  )
  // The summary needs the active wallet: until it is known, the home screen alone shows the wait or error.
  if (!activeWallet) return home(false)
  return <DashboardScreen walletId={activeWallet.id} dashboardApi={appDashboardApi} header={home(true)} />
}
