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
 *
 * `!`, `*`, `'`, `(` and `)` are here because `encodeURIComponent` does **not** escape them, and
 * `URLSearchParams` does not escape `*`. Leaving them out made the guard refuse legitimate output of
 * the very encoders the callers use: a category named `Casa (reforma)` or a search for `*` would have
 * thrown at runtime. That was the false negative the first version of this file warned about and did
 * not close.
 */
const ALLOWED_PATH = /^\/[A-Za-z0-9\-._~%/?&=+:,!*'()]*$/;

export class UnsafeApiPathError extends Error {
  // Declared as a field rather than a constructor parameter property: the Web build runs with
  // `erasableSyntaxOnly`, which rejects the parameter-property shorthand.
  readonly path: string;

  constructor(path: string) {
    // The message **can** reach the person: `WalletContext` and `FinancialSidebar` show `error.message`
    // verbatim, without going through `getApiErrorFeedback`. So it is written for them, in Portuguese,
    // and says what to do — rather than naming a path, which would mean nothing to whoever reads it.
    // An earlier version of this comment claimed the opposite and was wrong.
    super('Não foi possível montar o endereço desta requisição. Atualize a página e tente de novo.');
    this.name = 'UnsafeApiPathError';
    this.path = path;
  }
}

/**
 * A segment that climbs out of the current directory, in every spelling the URL Standard recognises.
 *
 * Comparing against the literal `..` was not enough: `%` is an allowed character, so `.%2e`, `%2e.`
 * and `%2e%2e` reach the same place, and `%2E` does too because percent-encoding is case-insensitive.
 * Decoding the segment covers all of them, including a spelling nobody enumerated — `decodeURIComponent`
 * is what the browser itself applies before resolving the path.
 */
function climbsOut(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A lone `%` or a truncated escape is not something any encoder here produces, so a path carrying
    // one is already a bug: treat it as unsafe instead of guessing what it meant.
    return true;
  }
  return decoded === '..';
}

export function assertSafeApiPath(path: string): string {
  if (typeof path !== 'string' || !ALLOWED_PATH.test(path)) throw new UnsafeApiPathError(String(path));
  // `//host` is a protocol-relative URL and a climbing segment leaves `/api`; both change the request
  // target even though every character in them is allowed on its own.
  if (path.startsWith('//') || path.split(/[/?&=]/).some(climbsOut)) throw new UnsafeApiPathError(path);
  return path;
}
