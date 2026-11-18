import { StyleSheet, Text, View } from 'react-native'

import { monthLabel, shiftMonth } from '../period/period'
import { LinkButton } from './Form'
import { colors, spacing, typography } from './theme'

/** The period of a list: one month, moved backwards or forwards. */
export function MonthSelector({ month, onChange }: { month: string; onChange(month: string): void }) {
  return (
    <View style={styles.row}>
      <LinkButton label="Mês anterior" onPress={() => onChange(shiftMonth(month, -1))} />
      <Text style={styles.label} accessibilityRole="header">{monthLabel(month)}</Text>
      <LinkButton label="Próximo mês" onPress={() => onChange(shiftMonth(month, 1))} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  label: { fontSize: typography.body, fontWeight: '600', color: colors.text },
})
