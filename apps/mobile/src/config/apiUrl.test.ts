import { ApiConfigurationError, resolveApiBaseUrl } from './apiUrl'

describe('resolveApiBaseUrl', () => {
  it('uses the configured address, without a trailing slash', () => {
    expect(resolveApiBaseUrl({ envUrl: 'https://api.saldocerto.example/', devServerHostUri: undefined, isDevelopment: false }))
      .toBe('https://api.saldocerto.example')
    expect(resolveApiBaseUrl({ envUrl: ' https://api.saldocerto.example/v1/ ', devServerHostUri: '10.0.0.2:8081', isDevelopment: true }))
      .toBe('https://api.saldocerto.example/v1')
  })

  it('falls back to the dev server host on the API port in development', () => {
    expect(resolveApiBaseUrl({ envUrl: undefined, devServerHostUri: '192.168.0.10:8081', isDevelopment: true }))
      .toBe('http://192.168.0.10:3000')
    expect(resolveApiBaseUrl({ envUrl: '', devServerHostUri: 'localhost:8081', isDevelopment: true }))
      .toBe('http://localhost:3000')
  })

  it('refuses a release build without a configured address, even when a dev host is known', () => {
    expect(() => resolveApiBaseUrl({ envUrl: undefined, devServerHostUri: '192.168.0.10:8081', isDevelopment: false }))
      .toThrow(new ApiConfigurationError('O endereço da API não foi configurado neste aplicativo.'))
    expect(() => resolveApiBaseUrl({ envUrl: undefined, devServerHostUri: undefined, isDevelopment: true }))
      .toThrow(ApiConfigurationError)
  })

  it('accepts plain http only in development, because the token travels in every request', () => {
    expect(resolveApiBaseUrl({ envUrl: 'http://192.168.0.10:3000', devServerHostUri: undefined, isDevelopment: true }))
      .toBe('http://192.168.0.10:3000')
    expect(() => resolveApiBaseUrl({ envUrl: 'http://api.saldocerto.example', devServerHostUri: undefined, isDevelopment: false }))
      .toThrow(new ApiConfigurationError('O endereço da API precisa usar HTTPS.'))
  })

  it.each([
    'not a url',
    'ftp://api.saldocerto.example',
    'https://api.saldocerto.example/?token=x',
    'https://api.saldocerto.example/#frag',
    'https://user:secret@api.saldocerto.example',
  ])('refuses the invalid address %s', (envUrl) => {
    expect(() => resolveApiBaseUrl({ envUrl, devServerHostUri: undefined, isDevelopment: true })).toThrow(ApiConfigurationError)
  })
})
