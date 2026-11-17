import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'

import { colors, spacing, typography } from './theme'

/** A labelled text field; the label is also its accessibility name, so tests and screen readers agree. */
export function TextField({ label, ...input }: { label: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.textMuted} style={styles.input} {...input} />
    </View>
  )
}

/** The main action of a form. While `busy`, it shows progress and ignores presses, so a form is sent once. */
export function PrimaryButton({ label, onPress, busy = false }: { label: string; onPress(): void; busy?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, busy }}
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      style={[styles.button, busy && styles.buttonBusy]}
    >
      {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  )
}

export function LinkButton({ label, onPress }: { label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={label} onPress={onPress} style={styles.link}>
      <Text style={styles.linkText}>{label}</Text>
    </Pressable>
  )
}

/** A message for the person: an error from the API, or a notice such as an expired session. */
export function FormMessage({ tone, message }: { tone: 'error' | 'info'; message: string }) {
  return (
    <Text accessibilityRole={tone === 'error' ? 'alert' : 'text'} style={[styles.message, tone === 'error' ? styles.error : styles.info]}>
      {message}
    </Text>
  )
}

export const formStyles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  title: {
    fontSize: typography.title,
    fontWeight: '700',
    color: colors.text,
  },
  body: {
    fontSize: typography.body,
    color: colors.textMuted,
  },
})

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  label: { fontSize: typography.caption, color: colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + spacing.xs,
    fontSize: typography.body,
    color: colors.text,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingVertical: spacing.sm + spacing.xs,
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: colors.onPrimary, fontSize: typography.body, fontWeight: '600' },
  link: { alignItems: 'center', paddingVertical: spacing.sm },
  linkText: { color: colors.primary, fontSize: typography.body },
  message: { fontSize: typography.body },
  error: { color: colors.danger },
  info: { color: colors.textMuted },
})
