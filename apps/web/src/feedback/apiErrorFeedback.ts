export function getApiErrorFeedback(
  error: unknown,
  fallback: string,
  messages: Partial<Record<number, string>> = {},
): string {
  const status = error instanceof Error && 'status' in error ? Number(error.status) : undefined
  if (status !== undefined && messages[status]) return messages[status]
  if (status === 401) {
    window.location.assign('/login')
    return 'Sua sessão expirou. Entre novamente para continuar.'
  }
  if (status === 403) return 'Você não tem permissão para concluir esta ação nesta carteira. Selecione uma carteira à qual você tenha acesso ou atualize a página.'
  if (status === 400) return 'Confira os dados informados e tente novamente.'
  if (status === 429) return 'Muitas tentativas. Aguarde um pouco e tente novamente.'
  return fallback
}
