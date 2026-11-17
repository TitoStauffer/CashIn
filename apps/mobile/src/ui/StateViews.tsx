import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'

import { colors, spacing, typography } from './theme'

/**
 * The three states every screen that loads data goes through besides its content: loading, error and
 * empty. One component per state keeps the wording and the accessibility the same across screens.
 */
export function LoadingState({ label = 'Carregando…' }: { label?: string }) {
  return (
    <View style={styles.container} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.message}>{label}</Text>
    </View>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.container} accessibilityRole="alert">
      <Text style={styles.title}>Algo deu errado</Text>
      <Text style={styles.message}>{message}</Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.button}>
          <Text style={styles.buttonText}>Tentar novamente</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export function EmptyState({ title, message }: { title: string; message?: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  title: {
    fontSize: typography.title,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'center',
  },
  message: {
    fontSize: typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + spacing.xs,
  },
  buttonText: {
    color: colors.onPrimary,
    fontSize: typography.body,
    fontWeight: '600',
  },
})
