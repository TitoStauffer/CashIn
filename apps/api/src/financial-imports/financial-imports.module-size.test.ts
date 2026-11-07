import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The size of a source file in this directory is not a style preference: it broke the hosted review.
// A file cited by the knowledge vault is read through the GitHub contents API, whose response carries
// it as base64 — a third larger — plus metadata, and a response above the loader's ceiling aborts the
// whole review before any analysis. In the DEV-88 import this directory's repository reached 103.206
// bytes of response and took the review down with it.
//
// This is the guard, so the limit stops being a promise in a Pull Request description and becomes
// something CI can refute. It covers the production sources, which are the ones the vault cites; the
// test files are tracked separately in DEV-95.
const MAX_SOURCE_BYTES = 40_000;

test("every production source of financial-imports stays within the size the hosted review can read", () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, bytes: statSync(new URL(name, import.meta.url)).size }))
    .sort((first, second) => second.bytes - first.bytes);

  assert.ok(sources.length > 0, "the directory must expose production sources to measure");
  const oversized = sources.filter((source) => source.bytes > MAX_SOURCE_BYTES);
  assert.deepEqual(
    oversized.map((source) => `${source.name} (${source.bytes} bytes)`),
    [],
    `every source must stay at or below ${MAX_SOURCE_BYTES} bytes; split the oversized ones by responsibility`,
  );
});
