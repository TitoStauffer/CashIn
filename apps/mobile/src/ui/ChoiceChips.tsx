import { Pressable, StyleSheet, Text, View } from 'react-native'

import { colors, spacing, typography } from './theme'

/** One choice among a few, shown as chips. Each chip is a radio whose label is its accessibility name. */
export function ChoiceChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange(value: T): void
}) {
  return (
    <View accessibilityRole="radiogroup" style={styles.group}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={[styles.chip, selected && styles.chipSelected]}
          >
            <Text style={[styles.text, selected && styles.textSelected]}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  group: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingVertical: spacing.xs, paddingHorizontal: spacing.md, backgroundColor: colors.surface },
  chipSelected: { borderColor: colors.primary, backgroundColor: colors.primary },
  text: { fontSize: typography.caption, color: colors.text },
  textSelected: { color: colors.onPrimary },
})
