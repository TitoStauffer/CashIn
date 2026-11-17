import { useRef, useState } from 'react'
import { ScrollView, Text } from 'react-native'

import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'

const MISSING_FIELDS = 'Informe e-mail e senha.'
const PASSWORDS_DIFFER = 'As senhas não coincidem.'
const FALLBACK_ERROR = 'Não foi possível criar a conta. Tente novamente.'
export const CONFIRMATION_GUIDANCE =
  'Abra o link que enviamos para o seu e-mail para confirmar a conta. O link abre a versão Web do Saldo Certo; depois de confirmar, volte aqui e entre.'

/**
 * Sign up. The password rules are the API's: a weak password, an address already in use or the attempt
 * limit come back as the API's message in Portuguese, so the app never states a rule the server does not
 * enforce. The only checks here are the ones that need no server — empty fields and a mistyped repetition.
 */
export function RegisterScreen({
  onSubmit,
  onGoToLogin,
}: {
  /** Resolves with the API's confirmation message. */
  onSubmit(email: string, password: string): Promise<string>
  onGoToLogin(): void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentMessage, setSentMessage] = useState<string | null>(null)

  // The ref closes the gap between two taps in the same frame, before `busy` re-renders the button.
  const inFlight = useRef(false)

  const submit = async () => {
    if (inFlight.current) return
    if (!email.trim() || !password) {
      setError(MISSING_FIELDS)
      return
    }
    if (password !== confirmation) {
      setError(PASSWORDS_DIFFER)
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      setSentMessage(await onSubmit(email.trim(), password))
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : FALLBACK_ERROR)
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  if (sentMessage !== null) {
    return (
      <ScrollView contentContainerStyle={formStyles.screen}>
        <Text style={formStyles.title} accessibilityRole="header">Confirme seu e-mail</Text>
        <FormMessage tone="info" message={sentMessage} />
        <Text style={formStyles.body}>{CONFIRMATION_GUIDANCE}</Text>
        <PrimaryButton label="Ir para o login" onPress={onGoToLogin} />
      </ScrollView>
    )
  }

  return (
    <ScrollView contentContainerStyle={formStyles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Criar conta</Text>
      <TextField
        label="E-mail"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
      />
      <TextField
        label="Senha"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <TextField
        label="Repita a senha"
        value={confirmation}
        onChangeText={setConfirmation}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Text style={formStyles.body}>
        Use pelo menos 8 caracteres, com letra maiúscula, letra minúscula, número e caractere especial.
      </Text>
      {error ? <FormMessage tone="error" message={error} /> : null}
      <PrimaryButton label="Criar conta" onPress={() => void submit()} busy={busy} />
      <LinkButton label="Já tenho conta" onPress={onGoToLogin} />
    </ScrollView>
  )
}
