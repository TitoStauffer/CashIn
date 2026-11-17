import { useRef, useState } from 'react'
import { ScrollView, Text } from 'react-native'

import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'

const MISSING_FIELDS = 'Informe e-mail e senha.'
const FALLBACK_ERROR = 'Não foi possível entrar. Tente novamente.'

/**
 * Sign in with e-mail and password. Every refusal shows the API's own message in Portuguese — wrong
 * credentials, an unconfirmed account (the API answers both alike, on purpose) and the attempt limit.
 * The password is never kept beyond the field.
 */
export function LoginScreen({
  onSubmit,
  onGoToRegister,
  notice,
}: {
  onSubmit(email: string, password: string): Promise<void>
  onGoToRegister(): void
  /** Shown above the form, e.g. when an expired session brought the person here. */
  notice?: string
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The ref closes the gap between two taps in the same frame, before `busy` re-renders the button.
  const inFlight = useRef(false)

  const submit = async () => {
    if (inFlight.current) return
    if (!email.trim() || !password) {
      setError(MISSING_FIELDS)
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await onSubmit(email.trim(), password)
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : FALLBACK_ERROR)
      setBusy(false)
      inFlight.current = false
    }
  }

  return (
    <ScrollView contentContainerStyle={formStyles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Entrar no Saldo Certo</Text>
      {notice ? <FormMessage tone="info" message={notice} /> : null}
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
        autoComplete="current-password"
        textContentType="password"
      />
      {error ? <FormMessage tone="error" message={error} /> : null}
      <PrimaryButton label="Entrar" onPress={() => void submit()} busy={busy} />
      <LinkButton label="Criar conta" onPress={onGoToRegister} />
    </ScrollView>
  )
}
