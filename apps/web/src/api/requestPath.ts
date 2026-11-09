/**
 * Guards the path every `request` helper concatenates into `fetch(`/api${path}`)`.
 *
 * Each feature module builds its path from literal prefixes plus identifiers wrapped in
 * `encodeURIComponent`, so nothing user-controlled can escape the `/api` prefix today. That argument
 * holds by reading every caller, which is exactly what a static analyser cannot do: `path` is a public
 * parameter of a generic function, so SonarCloud's taint analysis assumes untrusted input and reports
 * `tssecurity:S8476` — *Client-Side Request Forgery via unsanitized user input*. Two of those findings
 * kept the `master` quality gate red (DEV-105) while every Pull Request stayed green, because a PR only
 * analyses its own diff.
 *
 * This is not only a way to silence the tool. The protection the callers rely on is a convention, and a
 * convention holds until someone forgets it: one `request(`/thing/${id}`)` written without
 * `encodeURIComponent` would let an id of `../../evil` or `/evil.com` redirect the request. Validating
 * here turns that convention into a check that fails loudly, close to the mistake.
 */

/**
 * A path must start at the API root and may only carry the characters a route needs. `%` is allowed
 * because `encodeURIComponent` produces it; the sequences that would leave `/api` — `//`, `..`, a
 * scheme, a host — are refused below rather than escaped, because a caller producing one of them has a
 * bug, and silently rewriting it would hide the bug.
 */
const ALLOWED_PATH = /^\/[A-Za-z0-9\-._~%/?&=+:,]*$/;

export class UnsafeApiPathError extends Error {
  // Declared as a field rather than a constructor parameter property: the Web build runs with
  // `erasableSyntaxOnly`, which rejects the parameter-property shorthand.
  readonly path: string;

  constructor(path: string) {
    // The message reaches no end user: every caller is internal, and a failure here is a programming
    // error, not something a person can act on.
    super('Caminho de API inválido.');
    this.name = 'UnsafeApiPathError';
    this.path = path;
  }
}

export function assertSafeApiPath(path: string): string {
  if (typeof path !== 'string' || !ALLOWED_PATH.test(path)) throw new UnsafeApiPathError(String(path));
  // `//host` is a protocol-relative URL and `..` climbs out of `/api`; both change the request target
  // even though every character in them is allowed on its own.
  if (path.startsWith('//') || path.split(/[/?&=]/).includes('..')) throw new UnsafeApiPathError(path);
  return path;
}
