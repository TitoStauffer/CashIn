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
  // A path refused by `assertSafeApiPath` never reached the server, so it carries no status and would
  // otherwise land on each screen's fallback — usually a connection message, which tells the person to
  // retry something that cannot succeed. Matched by `name` instead of importing the class, to keep this
  // module free of a dependency on the HTTP client.
  if (error instanceof Error && error.name === 'UnsafeApiPathError') {
    return 'Não foi possível montar o endereço desta requisição. Atualize a página; se continuar, é falha do aplicativo e não da sua conexão.'
  }
  return fallback
}
