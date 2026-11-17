/** The base visual tokens of the app. Screens use these instead of literal colors and sizes. */
export const colors = {
  background: '#F7F8FA',
  surface: '#FFFFFF',
  text: '#1B1F24',
  textMuted: '#5B6573',
  primary: '#1F6FEB',
  onPrimary: '#FFFFFF',
  danger: '#C62828',
  success: '#2E7D32',
  border: '#DDE1E6',
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const

export const typography = {
  title: 22,
  body: 16,
  caption: 13,
} as const
