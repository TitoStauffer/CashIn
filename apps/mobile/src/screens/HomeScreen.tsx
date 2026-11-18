import { useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import type { User } from '../auth/authApi'
import type { Wallet } from '../wallets/walletApi'
import { LinkButton, PrimaryButton } from '../ui/Form'
import { colors, spacing, typography } from '../ui/theme'

/**
 * The first screen after signing in. It names the account and the wallet in use, opens the wallets, the
 * categories and the payment methods, and signs out; the dashboard replaces it in DEV-147. Signing out
 * always ends on the login, even when the API cannot be reached (the session provider drops the token
 * from the device either way).
 */
export function HomeScreen({
  user,
  activeWallet,
  walletError = null,
  onOpenWallets,
  onOpenCategories,
  onOpenPaymentMethods,
  onSignOut,
}: {
  user: User
  activeWallet: Wallet | null
  /** The wallets failed to load: the line says so instead of claiming they are still loading. */
  walletError?: string | null
  onOpenWallets(): void
  onOpenCategories(): void
  onOpenPaymentMethods(): void
  onSignOut(): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  // Signing out happens once: the ref holds between two taps in the same frame, before `busy` renders.
  const inFlight = useRef(false)

  const signOut = () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    void onSignOut()
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">Saldo Certo</Text>
      <Text style={styles.account}>Você entrou como {user.email}</Text>
      <Text style={styles.account}>{walletLine(activeWallet, walletError)}</Text>
      <LinkButton label="Carteiras" onPress={onOpenWallets} />
      <LinkButton label="Categorias" onPress={onOpenCategories} />
      <LinkButton label="Formas de pagamento" onPress={onOpenPaymentMethods} />
      <PrimaryButton label="Sair" onPress={signOut} busy={busy} />
    </View>
  )
}

function walletLine(activeWallet: Wallet | null, walletError: string | null): string {
  if (activeWallet) return `Carteira em uso: ${activeWallet.name}`
  if (walletError) return walletError
  return 'Carregando carteiras…'
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  title: {
    fontSize: typography.title,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  account: {
    fontSize: typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
})
