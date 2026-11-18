import { sessionRedirect } from './sessionRedirect'

describe('sessionRedirect', () => {
  it('keeps a signed-in person on the route', () => {
    expect(sessionRedirect({ status: 'signedIn', user: { id: '1', email: 'pessoa@example.com' } })).toBeNull()
  })

  it('sends a signed-out person to the login', () => {
    expect(sessionRedirect({ status: 'signedOut' })).toBe('/login')
  })

  it('sends a restoring or unavailable session to the start route, which offers the retry', () => {
    expect(sessionRedirect({ status: 'restoring' })).toBe('/')
    expect(sessionRedirect({ status: 'unavailable', message: 'Não foi possível conectar à API. Verifique sua conexão.' })).toBe('/')
  })
})
