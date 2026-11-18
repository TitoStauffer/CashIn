import { useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { Wallet } from '../wallets/walletApi'
import type { WalletState } from '../wallets/WalletProvider'
import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'

const MISSING_NAME = 'Informe o nome da carteira.'
const CREATE_FAILED = 'Não foi possível criar a carteira. Tente novamente.'

/** Only the owner of a shared wallet manages who has access; the personal wallet is never shared. */
export function canShare(wallet: Wallet): boolean {
  return wallet.role === 'owner' && !wallet.isPersonal
}

/**
 * The account's wallets: pick the active one, create a new one, and — for the owner of a shared
 * wallet — open its sharing. The API refuses sharing to anyone else; hiding the action here only keeps
 * people away from a door that would not open.
 */
export function WalletsScreen({
  state,
  onSelect,
  onCreate,
  onManage,
  onRetry,
  onDismissNotice,
}: {
  state: WalletState
  onSelect(walletId: string): void
  onCreate(name: string): Promise<void>
  onManage(walletId: string): void
  onRetry(): void
  onDismissNotice(): void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  if (state.status === 'idle' || state.status === 'loading') return <LoadingState label="Carregando carteiras…" />
  if (state.status === 'error') return <ErrorState message={state.message} onRetry={onRetry} />

  const create = async () => {
    if (inFlight.current) return
    if (!name.trim()) {
      setError(MISSING_NAME)
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await onCreate(name.trim())
      setName('')
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : CREATE_FAILED)
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      {state.notice ? (
        <View style={styles.notice}>
          <FormMessage tone="info" message={state.notice} />
          <LinkButton label="Entendi" onPress={onDismissNotice} />
        </View>
      ) : null}
      <Text style={formStyles.title} accessibilityRole="header">Suas carteiras</Text>
      {state.wallets.map((wallet) => {
        const active = wallet.id === state.activeWalletId
        return (
          <View key={wallet.id} style={[styles.row, active && styles.rowActive]}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Usar a carteira ${wallet.name}`}
              onPress={() => onSelect(wallet.id)}
              style={styles.rowMain}
            >
              <Text style={styles.name}>{wallet.name}</Text>
              <Text style={styles.detail}>
                {wallet.isPersonal ? 'Pessoal' : wallet.role === 'owner' ? 'Compartilhada · você é o proprietário' : 'Compartilhada · você é membro'}
                {active ? ' · em uso' : ''}
              </Text>
            </Pressable>
            {canShare(wallet) ? <LinkButton label={`Compartilhar ${wallet.name}`} onPress={() => onManage(wallet.id)} /> : null}
          </View>
        )
      })}
      <Text style={styles.section} accessibilityRole="header">Nova carteira</Text>
      <TextField label="Nome da nova carteira" value={name} onChangeText={setName} maxLength={80} />
      {error ? <FormMessage tone="error" message={error} /> : null}
      <PrimaryButton label="Criar carteira" onPress={() => void create()} busy={busy} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background },
  notice: { gap: spacing.xs, padding: spacing.md, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  row: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.xs },
  rowActive: { borderColor: colors.primary },
  rowMain: { gap: spacing.xs },
  name: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  detail: { fontSize: typography.caption, color: colors.textMuted },
  section: { fontSize: typography.body, fontWeight: '600', color: colors.text, marginTop: spacing.md },
})
