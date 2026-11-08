import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The `test` script enumerates every test file by hand, so a new file that is not listed there stops
// being executed and nothing fails: the suite stays green while the cases are simply gone. DEV-95
// added two files to that list and this guard is what keeps the next one from being forgotten.
// `test:coverage` uses a glob and does not have this problem, which is why only `test` is compared.

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

function testFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return testFiles(`${directory}${entry.name}/`, `${prefix}${entry.name}/`);
    return entry.name.endsWith(".test.ts") ? [`src/${prefix}${entry.name}`] : [];
  });
}

test("the npm test script lists every test file in the API source tree", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.test;
  assert.ok(script, "apps/api/package.json must define a test script");

  const listed = new Set(script.match(/src\/\S+?\.test\.ts/g) ?? []);
  const present = testFiles(sourceRoot);

  assert.ok(present.length > 0, "the source tree must expose test files to compare");
  assert.deepEqual(present.filter((file) => !listed.has(file)), [], "these test files are never executed by `npm test`");
  assert.deepEqual([...listed].filter((file) => !present.includes(file)), [], "the test script lists files that no longer exist");
});
