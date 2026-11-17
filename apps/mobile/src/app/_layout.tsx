import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'

import { appAuthApi, registerUnauthorizedHandler } from '../api/appClient'
import { SessionProvider } from '../auth/SessionProvider'
import { tokenStorage } from '../auth/tokenStorage'
import { colors } from '../ui/theme'

export default function RootLayout() {
  return (
    <SessionProvider authApi={appAuthApi} tokenStore={tokenStorage} registerUnauthorizedHandler={registerUnauthorizedHandler}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Saldo Certo' }} />
        <Stack.Screen name="login" options={{ title: 'Entrar', headerBackVisible: false }} />
        <Stack.Screen name="register" options={{ title: 'Criar conta' }} />
      </Stack>
    </SessionProvider>
  )
}
