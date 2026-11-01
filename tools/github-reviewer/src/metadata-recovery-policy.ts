/** Skip only a proven checkbox-only edit; ambiguous payloads retain recovery. */
export function requiresCiRecovery(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const event = payload as { changes?: { title?: unknown; body?: { from?: unknown } }; pull_request?: { body?: unknown } };
  if (event.changes?.title !== undefined) return true;
  const before = event.changes?.body?.from;
  const after = event.pull_request?.body;
  if (typeof before !== 'string' || typeof after !== 'string') return true;
  const normalize = (body: string): string => body.replace(/^(\s*[-*]\s+)\[[ xX]\](?=\s)/gm, '$1[ ]');
  return normalize(before) !== normalize(after);
}
