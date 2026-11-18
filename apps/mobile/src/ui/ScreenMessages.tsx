import { View } from 'react-native'

import { FormMessage, LinkButton } from './Form'
import { listStyles } from './listStyles'
import type { Feedback } from './useActionRunner'

/**
 * The messages at the top of a list screen: the result of the last action, and a read that failed while
 * the last list is still on screen, with its retry. The list may be stale, so the failure is never silent.
 */
export function ScreenMessages({ feedback, loadError, onRetry }: { feedback: Feedback; loadError: string | null; onRetry(): void }) {
  return (
    <>
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}
      {loadError ? (
        <View style={listStyles.card}>
          <FormMessage tone="error" message={loadError} />
          <LinkButton label="Tentar novamente" onPress={onRetry} />
        </View>
      ) : null}
    </>
  )
}
