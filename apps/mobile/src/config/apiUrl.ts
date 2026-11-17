/**
 * Where the app finds the API.
 *
 * `EXPO_PUBLIC_API_URL` wins when it is set, and it is required outside development: a release build
 * talks only to the address it was built with. In development, without it, the app reaches the API on
 * the same machine that serves the bundle — the host of the Expo dev server, on the API's port — so
 * `npx expo start` works on a phone in the same network with no configuration.
 *
 * A release build accepts only `https`: the session token travels in every request, and over plain
 * `http` anyone on the path could read it.
 */
export class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiConfigurationError'
  }
}

export const DEVELOPMENT_API_PORT = 3000

export type ApiUrlSources = {
  /** `process.env.EXPO_PUBLIC_API_URL`, inlined by Expo at build time. */
  envUrl: string | undefined
  /** `Constants.expoConfig.hostUri`, e.g. `192.168.0.10:8081`, present only when served by the dev server. */
  devServerHostUri: string | undefined
  /** `__DEV__`. */
  isDevelopment: boolean
}

export function resolveApiBaseUrl({ envUrl, devServerHostUri, isDevelopment }: ApiUrlSources): string {
  const configured = envUrl?.trim()
  if (configured) return validatedBaseUrl(configured, isDevelopment)

  if (isDevelopment && devServerHostUri) {
    const host = devServerHostUri.split(':')[0]
    if (host) return `http://${host}:${DEVELOPMENT_API_PORT}`
  }
  throw new ApiConfigurationError('O endereço da API não foi configurado neste aplicativo.')
}

function validatedBaseUrl(value: string, isDevelopment: boolean): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ApiConfigurationError('O endereço da API configurado é inválido.')
  }
  const allowedProtocols = isDevelopment ? ['https:', 'http:'] : ['https:']
  if (!allowedProtocols.includes(url.protocol)) {
    throw new ApiConfigurationError('O endereço da API precisa usar HTTPS.')
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new ApiConfigurationError('O endereço da API configurado é inválido.')
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}
