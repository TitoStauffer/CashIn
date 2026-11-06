export type AgentRuntime = 'claude' | 'codex';

// Claude Code is the default runtime; Codex remains available as an explicit fallback.
export function resolveAgentRuntime(value: string | undefined): AgentRuntime {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'claude') return 'claude';
  if (normalized === 'codex') return 'codex';
  throw new Error('AGENT_RUNTIME must be "claude" or "codex".');
}
