import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://api:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/layout/FinancialSidebar.tsx',
        'src/period/MonthYearSelector.tsx',
        'src/period/month.ts',
        'src/money/currency.ts',
        'src/dashboard/DashboardPage.tsx',
        'src/categories/CategoriesPage.tsx',
        'src/expenses/ExpensesPage.tsx',
        'src/goals/GoalsPage.tsx',
        'src/incomes/IncomesPage.tsx',
        'src/App.tsx',
        'src/wallets/WalletContext.tsx',
        'src/wallets/WalletInvitationPage.tsx',
        'src/wallets/WalletAccessRequestPage.tsx',
        'src/wallets/WalletSharingPage.tsx',
        'src/wallets/useWallet.ts',
        'src/wallets/walletApi.ts',
        'src/paymentMethods/PaymentMethodsPage.tsx',
        'src/paymentMethods/paymentMethodsApi.ts',
      ],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/test/**'],
      thresholds: {
        'src/layout/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'src/period/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'src/money/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'src/dashboard/DashboardPage.tsx': { lines: 54, functions: 50, branches: 40, statements: 50 },
        'src/expenses/ExpensesPage.tsx': { lines: 61, functions: 57, branches: 54, statements: 58 },
        'src/goals/GoalsPage.tsx': { lines: 64, functions: 56, branches: 60, statements: 58 },
        'src/incomes/IncomesPage.tsx': { lines: 61, functions: 57, branches: 54, statements: 58 },
        'src/wallets/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'src/paymentMethods/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
      },
    },
  },
})
