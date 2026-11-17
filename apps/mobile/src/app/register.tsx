import { useRouter } from 'expo-router'

import { appAuthApi } from '../api/appClient'
import { RegisterScreen } from '../screens/RegisterScreen'

export default function Register() {
  const router = useRouter()
  return (
    <RegisterScreen
      onSubmit={async (email, password) => (await appAuthApi.register(email, password)).message}
      onGoToLogin={() => router.replace('/login')}
    />
  )
}
