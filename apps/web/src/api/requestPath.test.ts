import { describe, expect, it } from 'vitest'
import { UnsafeApiPathError, assertSafeApiPath } from './requestPath'

describe('assertSafeApiPath', () => {
  it('accepts the paths the feature modules actually build', () => {
    // Collected from the nine `request` helpers: literal prefixes, ids under `encodeURIComponent`,
    // and query strings produced by `URLSearchParams`.
    for (const path of [
      '/credit-cards',
      '/credit-cards/abc-123',
      '/credit-cards/abc-123/statements?from=2026-01-01&to=2026-01-31',
      '/credit-cards/abc-123/statements/st-1/pay',
      '/investment-goals/goal-1/contributions/c-1',
      '/financial-imports/sessions/s-1/items/i-1',
      '/dashboard/summary?month=2026-11',
      '/wallets/w-1/members/m-1',
      '/expenses?page=2&size=50',
      // `encodeURIComponent` output: a space becomes `%20`, an accent becomes `%C3%A1`.
      '/categories/Casa%20e%20Alimenta%C3%A7%C3%A3o',
    ]) {
      expect(assertSafeApiPath(path)).toBe(path)
    }
  })

  // These are the shapes that make the request leave `/api`, which is what `tssecurity:S8476` warns
  // about. Each one is reachable only through a caller that forgot `encodeURIComponent`.
  it('refuses a path that would redirect the request away from the API root', () => {
    for (const path of [
      '//evil.example.com/steal',
      '//evil.example.com',
      '/../../etc/passwd',
      '/credit-cards/../../admin',
      '/credit-cards/..',
      '/wallets/..?x=1',
    ]) {
      expect(() => assertSafeApiPath(path)).toThrow(UnsafeApiPathError)
    }
  })

  // `%` is an allowed character, so comparing the segment with the literal `..` left three other
  // spellings of a double-dot segment reaching the same place — and percent-encoding is
  // case-insensitive, so each has an uppercase form too. Decoding the segment covers all of them.
  it('refuses every spelling of a climbing segment, encoded and in either case', () => {
    for (const segment of ['..', '.%2e', '%2e.', '%2e%2e', '.%2E', '%2E.', '%2E%2E', '%2e%2E']) {
      expect(() => assertSafeApiPath(`/x/${segment}/evil`)).toThrow(UnsafeApiPathError)
      expect(() => assertSafeApiPath(`/x/${segment}`)).toThrow(UnsafeApiPathError)
    }
  })

  it('refuses a truncated percent escape instead of guessing what it meant', () => {
    // No encoder used here produces a lone `%`, so a path carrying one is already a bug.
    for (const path of ['/categories/%', '/categories/%zz', '/categories/abc%2']) {
      expect(() => assertSafeApiPath(path)).toThrow(UnsafeApiPathError)
    }
  })

  // The mirror risk of the guard: refusing output the encoders legitimately produce would break a
  // screen at runtime. `encodeURIComponent` does not escape `!*'()`, and `URLSearchParams` keeps `*`.
  it('accepts the characters the encoders leave unescaped', () => {
    for (const value of ['Casa (reforma)', "Mercado d'Água", 'Pai!', 'A*B', 'x(1)*y', "!*'()"]) {
      const path = `/categories/${encodeURIComponent(value)}`
      expect(assertSafeApiPath(path)).toBe(path)
    }

    const query = new URLSearchParams({ q: 'A*B (teste)!' })
    const searchPath = `/expenses?${query.toString()}`
    expect(assertSafeApiPath(searchPath)).toBe(searchPath)
  })

  it('refuses a path that does not start at the API root', () => {
    for (const path of ['', 'credit-cards', 'https://evil.example.com', 'javascript:alert(1)', ' /credit-cards']) {
      expect(() => assertSafeApiPath(path)).toThrow(UnsafeApiPathError)
    }
  })

  it('refuses characters a route never needs', () => {
    // A backslash is read as a separator by some URL parsers, and the rest can split or smuggle a
    // request. None of them can come out of `encodeURIComponent`.
    for (const path of ['/credit-cards\\..\\admin', '/credit-cards#fragment', '/credit-cards\nHost: evil', '/credit-cards<script>', '/credit-cards@evil.com']) {
      expect(() => assertSafeApiPath(path)).toThrow(UnsafeApiPathError)
    }
  })

  it('keeps the thrown error free of anything a user should read', () => {
    // Every caller is internal: reaching this error is a programming mistake, so the message must not
    // look like guidance for the person using the screen.
    const error = new UnsafeApiPathError('//evil.example.com')

    expect(error.name).toBe('UnsafeApiPathError')
    expect(error.message).toBe('Caminho de API inválido.')
    expect(error.path).toBe('//evil.example.com')
  })
})
