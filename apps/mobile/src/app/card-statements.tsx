import { Redirect, useLocalSearchParams } from 'expo-router'

import { appCreditCardApi } from '../api/appClient'
import { useSession } from '../auth/SessionProvider'
import { CardStatementsScreen } from '../screens/CardStatementsScreen'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { activeWalletGate } from '../wallets/activeWalletGate'
import { useWallets } from '../wallets/WalletProvider'

export default function CardStatements() {
  const { cardId, nickname } = useLocalSearchParams<{ cardId?: string; nickname?: string }>()
  const { state: session } = useSession()
  const { state, activeWallet, reload } = useWallets()
  const gate = activeWalletGate(session, state, activeWallet)
  if (gate.kind === 'redirect') return <Redirect href={gate.href} />
  if (gate.kind === 'error') return <ErrorState message={gate.message} onRetry={reload} />
  if (gate.kind === 'loading') return <LoadingState label="Carregando carteiras…" />
  if (!cardId) return <ErrorState message="Cartão não encontrado." />
  // The card belongs to the active wallet; the API answers 404 for a card of another wallet.
  return <CardStatementsScreen key={`${gate.wallet.id}:${cardId}`} card={{ id: cardId, nickname: nickname ?? 'cartão' }} cardApi={appCreditCardApi} />
}
