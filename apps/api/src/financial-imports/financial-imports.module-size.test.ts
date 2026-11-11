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
// something CI can refute. DEV-95 extended it from the production sources to every file in the
// directory, test files included: the reading cost of a 50 KB test is the same whether or not the
// vault cites it, and only a guard keeps a split from being undone one case at a time.
const MAX_SOURCE_BYTES = 40_000;

// Each entry names the ticket that removes it. An exception with no ticket is permanent, because nothing
// ever brings it back up for decision. The list is empty since DEV-108 split the last oversized file — the
// monolithic PostgreSQL import test — into one file per phase over a shared fixture.
const DECLARED_OVERSIZED: Array<{ name: string; ticket: string }> = [];

test("every source of financial-imports stays within the size the hosted review can read", () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, bytes: statSync(new URL(name, import.meta.url)).size }))
    .sort((first, second) => second.bytes - first.bytes);

  assert.ok(sources.length > 0, "the directory must expose sources to measure");
  const oversized = sources.filter((source) => source.bytes > MAX_SOURCE_BYTES);
  assert.deepEqual(
    oversized.filter((source) => !DECLARED_OVERSIZED.some((declared) => declared.name === source.name)).map((source) => `${source.name} (${source.bytes} bytes)`),
    [],
    `every source must stay at or below ${MAX_SOURCE_BYTES} bytes; split the oversized ones by responsibility`,
  );
  // A declaration that stopped being true is a stale exception, and a stale exception hides the next
  // oversized file behind a name nobody rechecks.
  assert.deepEqual(
    DECLARED_OVERSIZED.filter((declared) => !oversized.some((source) => source.name === declared.name)).map((declared) => declared.name),
    [],
    "a declared exception that now fits the limit must be removed from DECLARED_OVERSIZED",
  );
  // An entry without a ticket key is the permanent exception this list exists to prevent.
  assert.deepEqual(
    DECLARED_OVERSIZED.filter((declared) => !/^DEV-\d+$/.test(declared.ticket)).map((declared) => declared.name),
    [],
    "every declared exception must name the ticket that removes it",
  );
});
