import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "./app.js";
import { trustedProxiesFromEnvironment } from "./trusted-proxies.js";

test("TRUSTED_PROXIES unset or blank trusts no proxy", () => {
  assert.equal(trustedProxiesFromEnvironment(undefined), undefined);
  assert.equal(trustedProxiesFromEnvironment(""), undefined);
  assert.equal(trustedProxiesFromEnvironment(" , "), undefined);
});

test("TRUSTED_PROXIES is read as a trimmed list of addresses", () => {
  assert.deepEqual(trustedProxiesFromEnvironment("172.30.10.2"), ["172.30.10.2"]);
  assert.deepEqual(trustedProxiesFromEnvironment(" 172.30.10.2 , 10.0.0.0/8,"), ["172.30.10.2", "10.0.0.0/8"]);
});

test("an invalid proxy address stops the API instead of being ignored", () => {
  assert.throws(() => createApp({} as never, { trustedProxies: trustedProxiesFromEnvironment("not-an-address") }));
});
