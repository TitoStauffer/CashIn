import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { Wallet, WalletAccessLink, WalletAccessRequest, WalletApi, WalletInvitation, WalletMember } from '../wallets/walletApi'
import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { canShare } from './WalletsScreen'

const LOAD_FAILED = 'Não foi possível carregar o compartilhamento. Tente novamente.'
const ACTION_FAILED = 'Não foi possível concluir a ação. Tente novamente.'
const MISSING_EMAIL = 'Informe o e-mail da pessoa.'
export const NOT_OWNER_MESSAGE = 'Somente o proprietário pode compartilhar esta carteira.'

type Sharing = { members: WalletMember[]; invitations: WalletInvitation[]; requests: WalletAccessRequest[] }
type Feedback = { tone: 'error' | 'info'; message: string } | null

const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : ACTION_FAILED)

/**
 * Who has access to a shared wallet, and how to change it: members, invitations, the access link and
 * the access requests it produces. Every refusal is the API's message in Portuguese. Accepting an
 * invitation and requesting access happen through the e-mailed link, which opens the Web.
 */
export function WalletSharingScreen({
  wallet,
  walletApi,
  onShareLink,
}: {
  wallet: Wallet
  walletApi: WalletApi
  /** Opens the system share sheet with the access link. */
  onShareLink(url: string): Promise<void>
}) {
  const [sharing, setSharing] = useState<Sharing | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [email, setEmail] = useState('')
  const [link, setLink] = useState<WalletAccessLink | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const allowed = canShare(wallet)

  useEffect(() => {
    if (!allowed) return
    let current = true
    void Promise.all([walletApi.listMembers(wallet.id), walletApi.listInvitations(wallet.id), walletApi.listAccessRequests(wallet.id)])
      .then(([members, invitations, requests]) => {
        if (current) setSharing({ members: members.items, invitations: invitations.items, requests: requests.items })
      })
      .catch((error: unknown) => { if (current) setLoadError(error instanceof Error && error.message ? error.message : LOAD_FAILED) })
    return () => { current = false }
  }, [allowed, walletApi, wallet.id, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])

  // Every action goes through here: one at a time, its message shown, and the lists read again after.
  const run = useCallback(async (action: () => Promise<string | void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const message = await action()
      if (message) setFeedback({ tone: 'info', message })
      refresh()
    } catch (error) {
      setFeedback({ tone: 'error', message: messageOf(error) })
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [refresh])

  if (!allowed) return <ErrorState message={NOT_OWNER_MESSAGE} />
  if (loadError && !sharing) {
    return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />
  }
  if (!sharing) return <LoadingState label="Carregando compartilhamento…" />

  const invite = () => {
    if (!email.trim()) {
      setFeedback({ tone: 'error', message: MISSING_EMAIL })
      return
    }
    void run(async () => {
      const { message } = await walletApi.invite(wallet.id, email.trim())
      setEmail('')
      return message
    })
  }

  const confirmRemoval = (member: WalletMember) => {
    Alert.alert('Remover membro', `${member.email} perde o acesso à carteira ${wallet.name}.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Remover', style: 'destructive', onPress: () => void run(async () => { await walletApi.removeMember(wallet.id, member.id) }) },
    ])
  }

  const pendingInvitations = sharing.invitations.filter((invitation) => invitation.status === 'pending')
  const pendingRequests = sharing.requests.filter((request) => request.status === 'pending')

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Compartilhar {wallet.name}</Text>
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}

      <Text style={styles.section} accessibilityRole="header">Membros</Text>
      {sharing.members.map((member) => (
        <View key={member.id} style={styles.row}>
          <Text style={styles.primary}>{member.email}</Text>
          <Text style={styles.detail}>{member.role === 'owner' ? 'Proprietário' : 'Membro'}</Text>
          {member.role === 'member' ? <LinkButton label={`Remover ${member.email}`} onPress={() => confirmRemoval(member)} /> : null}
        </View>
      ))}

      <Text style={styles.section} accessibilityRole="header">Convidar por e-mail</Text>
      <TextField label="E-mail para convidar" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <PrimaryButton label="Enviar convite" onPress={invite} busy={busy} />
      {pendingInvitations.map((invitation) => (
        <View key={invitation.id} style={styles.row}>
          <Text style={styles.primary}>{invitation.email}</Text>
          <Text style={styles.detail}>Convite pendente</Text>
          <LinkButton
            label={`Cancelar convite de ${invitation.email}`}
            onPress={() => void run(async () => { await walletApi.cancelInvitation(wallet.id, invitation.id) })}
          />
        </View>
      ))}

      <Text style={styles.section} accessibilityRole="header">Link de acesso</Text>
      <Text style={formStyles.body}>Quem abrir o link pede acesso, e você aprova aqui. Cada link novo invalida o anterior.</Text>
      <PrimaryButton
        label="Gerar link de acesso"
        busy={busy}
        onPress={() => void run(async () => { setLink((await walletApi.createAccessLink(wallet.id)).link) })}
      />
      {link ? (
        <View style={styles.row}>
          <Text style={styles.primary} selectable>{link.url}</Text>
          <LinkButton label="Compartilhar link" onPress={() => void onShareLink(link.url).catch(() => undefined)} />
        </View>
      ) : null}

      <Text style={styles.section} accessibilityRole="header">Solicitações de acesso</Text>
      {pendingRequests.length === 0 ? <Text style={formStyles.body}>Nenhuma solicitação pendente.</Text> : null}
      {pendingRequests.map((request) => (
        <View key={request.id} style={styles.row}>
          <Text style={styles.primary}>{request.email}</Text>
          <LinkButton label={`Aprovar ${request.email}`} onPress={() => void run(async () => (await walletApi.approveAccessRequest(wallet.id, request.id)).message)} />
          <LinkButton label={`Recusar ${request.email}`} onPress={() => void run(async () => (await walletApi.rejectAccessRequest(wallet.id, request.id)).message)} />
          <LinkButton label={`Cancelar solicitação de ${request.email}`} onPress={() => void run(async () => { await walletApi.cancelAccessRequest(wallet.id, request.id) })} />
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background },
  section: { fontSize: typography.body, fontWeight: '600', color: colors.text, marginTop: spacing.md },
  row: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.xs },
  primary: { fontSize: typography.body, color: colors.text },
  detail: { fontSize: typography.caption, color: colors.textMuted },
})
