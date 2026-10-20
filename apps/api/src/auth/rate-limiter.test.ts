import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRateLimiter } from "./rate-limiter.js";

test("rate limiter resets after its temporary window and isolates client keys", () => {
  let currentTime = 1_000;
  const rateLimiter = new InMemoryRateLimiter({
    maxRequests: 2,
    windowMs: 5_000,
    now: () => currentTime,
  });

  assert.deepEqual(rateLimiter.consume("client-a"), {
    allowed: true,
    remaining: 1,
    retryAfterSeconds: 0,
  });
  assert.deepEqual(rateLimiter.consume("client-a"), {
    allowed: true,
    remaining: 0,
    retryAfterSeconds: 0,
  });
  assert.deepEqual(rateLimiter.consume("client-a"), {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 5,
  });
  assert.equal(rateLimiter.consume("client-b").allowed, true);

  currentTime += 5_000;
  assert.equal(rateLimiter.consume("client-a").allowed, true);
});
