import { Redirect, useRouter } from 'expo-router'

import { useSession } from '../auth/SessionProvider'
import { LoginScreen } from '../screens/LoginScreen'

export default function Login() {
  const router = useRouter()
  const { state, signIn } = useSession()
  if (state.status === 'signedIn') return <Redirect href="/" />
  return (
    <LoginScreen
      onSubmit={signIn}
      onGoToRegister={() => router.push('/register')}
      notice={state.status === 'signedOut' ? state.notice : undefined}
    />
  )
}
