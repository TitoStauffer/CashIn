import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

// The header that carries the correlation id in both directions: a client may send one to tie its own
// logs to ours, and every response returns the id the API actually used.
export const REQUEST_ID_HEADER = "x-request-id";

// What a client-supplied id may look like. The id ends up verbatim in every log line of the request and
// in a response header, so it is held to a short, plain alphabet: no spaces, quotes, control characters
// or line breaks that could forge a log line or split a header, and nothing long enough to bloat logs.
// A UUID, a ULID or a trace-style hex id all fit.
export const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// Reuses the client's id when it is a single value matching the pattern, and otherwise generates a
// random UUID. An invalid id is dropped silently — rejecting the request over a diagnostic header would
// turn observability into a failure mode. A repeated header arrives as an array and counts as invalid.
export function resolveRequestId(headers: IncomingHttpHeaders): string {
  const supplied = headers[REQUEST_ID_HEADER];
  if (typeof supplied === "string" && CLIENT_REQUEST_ID_PATTERN.test(supplied)) return supplied;
  return randomUUID();
}
