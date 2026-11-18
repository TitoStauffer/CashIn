import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'

import { appAuthApi, appWalletApi, registerUnauthorizedHandler, registerWalletNotFoundHandler } from '../api/appClient'
import { SessionProvider } from '../auth/SessionProvider'
import { tokenStorage } from '../auth/tokenStorage'
import { colors } from '../ui/theme'
import { activeWalletStorage, setActiveWalletId } from '../wallets/activeWallet'
import { WalletProvider } from '../wallets/WalletProvider'

export default function RootLayout() {
  return (
    <SessionProvider authApi={appAuthApi} tokenStore={tokenStorage} registerUnauthorizedHandler={registerUnauthorizedHandler}>
      <WalletProvider
        walletApi={appWalletApi}
        storage={activeWalletStorage}
        setActiveWalletId={setActiveWalletId}
        registerWalletNotFoundHandler={registerWalletNotFoundHandler}
      >
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
          <Stack.Screen name="wallets" options={{ title: 'Carteiras' }} />
          <Stack.Screen name="wallet-sharing" options={{ title: 'Compartilhar carteira' }} />
          <Stack.Screen name="categories" options={{ title: 'Categorias' }} />
          <Stack.Screen name="payment-methods" options={{ title: 'Formas de pagamento' }} />
          <Stack.Screen name="incomes" options={{ title: 'Entradas' }} />
        </Stack>
      </WalletProvider>
    </SessionProvider>
  )
}
