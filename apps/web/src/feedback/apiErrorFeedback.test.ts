import { afterEach, describe, expect, it, vi } from 'vitest'
import { getApiErrorFeedback } from './apiErrorFeedback'

describe('getApiErrorFeedback', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([400, 404, 409, 429, 500, 503])('does not display the payload of an HTTP %s error', (status) => {
    const error = Object.assign(new Error('server-only-detail: synthetic-private-payload'), { status })
    const feedback = getApiErrorFeedback(error, 'Não foi possível carregar os registros. Tente novamente.', {
      404: 'O registro não está mais disponível. Atualize a lista.',
      409: 'Os dados mudaram. Atualize a lista antes de tentar novamente.',
    })
    expect(feedback).not.toMatch(/server-only-detail|synthetic-private-payload/)
    expect(feedback).toMatch(/novamente|Atualize/)
  })

  it('redirects an expired HTTP 401 session to login without displaying its payload', () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    expect(getApiErrorFeedback(Object.assign(new Error('server-only-detail'), { status: 401 }), 'Falha.'))
      .toBe('Sua sessão expirou. Entre novamente para continuar.')
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('explains HTTP 403 permissions without treating them as an expired session', () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    const feedback = getApiErrorFeedback(Object.assign(new Error('server-only-detail'), { status: 403 }), 'Falha.')
    expect(feedback).toMatch(/não tem permissão.*Selecione uma carteira/)
    expect(feedback).not.toMatch(/expirou|server-only-detail/)
    expect(assign).not.toHaveBeenCalled()
  })

  it('allows invitation-specific session guidance without redirecting', () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    expect(getApiErrorFeedback(Object.assign(new Error('server-only-detail'), { status: 401 }), 'Falha.', {
      401: 'Entre na conta que recebeu o convite.',
    })).toBe('Entre na conta que recebeu o convite.')
    expect(assign).not.toHaveBeenCalled()
  })

  it.each([new Error('server-only-detail'), null, { message: 'server-only-detail' }])('uses the action fallback for an unknown error', (error) => {
    expect(getApiErrorFeedback(error, 'Não foi possível salvar a meta. Tente novamente.'))
      .toBe('Não foi possível salvar a meta. Tente novamente.')
  })
})
