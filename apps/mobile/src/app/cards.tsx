import { Redirect, useRouter } from 'expo-router'

import { appCreditCardApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { CardsScreen } from '../screens/CardsScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function Cards() {
  const router = useRouter()
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  return (
    <CardsScreen
      walletId={gate.wallet.id}
      cardApi={appCreditCardApi}
      onOpenStatements={(card) => router.push({ pathname: '/card-statements', params: { cardId: card.id, nickname: card.nickname } })}
    />
  )
}
