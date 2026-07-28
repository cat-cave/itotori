import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("RealLive runbook names the accepted-output production patchback seam and its local setup", () => {
  const runbook = read("docs/localize-reallive.md");
  const help = read("apps/itotori/src/help-text.ts");
  const readme = read("README.md");

  assert.match(
    runbook,
    /wiki \+ localize → final accepted outputs in Postgres\s+→ Studio “Produce patched build” → re-extract and verify/u,
  );
  assert.match(runbook, /POST \/api\/patchback\/produce/u);
  assert.match(runbook, /redacted `run-summary\.json` cannot be\s+fed to `patch` or `patch produce`/u);
  assert.match(runbook, /Buffer\.alloc\(32, 11\)\.toString\("base64"\)/u);
  assert.match(runbook, /The OpenRouter provider key lives only in the main checkout's gitignored\s+`\.env`; it is never copied/u);
  assert.match(runbook, /itotori patch produce --help/u);
  assert.match(runbook, /27,405 of 27,407 unit texts\s+byte-identical/u);

  assert.match(help, /NativePatchbackInput, never localize run-summary\.json/u);
  assert.match(help, /Studio's Produce patched build action uses \/api\/patchback\/produce/u);
  assert.match(readme, /Studio's \*\*Produce patched build\*\* action/u);
  assert.doesNotMatch(readme, /no copy-paste CLI-only route from this archive to a localized patch/u);
});
