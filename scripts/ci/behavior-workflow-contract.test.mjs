import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/_tier1.yml", "utf8");

function job(name) {
  const jobs = workflow.slice(workflow.indexOf("jobs:\n") + "jobs:\n".length);
  const match = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
    "mu",
  ).exec(jobs);
  assert.notEqual(match, null, `missing ${name} job`);
  return match[0];
}

function namedStep(body, name) {
  const match = new RegExp(
    `^      - name: ${name}\\n([\\s\\S]*?)(?=^      - name:|(?![\\s\\S]))`,
    "mu",
  ).exec(body);
  assert.notEqual(match, null, `missing ${name} step`);
  return match[0];
}

test("behavior job publishes a nonempty candidate proof with pinned artifact code", () => {
  const body = job("behavior");
  assert.match(body, /run: just ci tier1-behavior/u);
  assert.match(body, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(body, /name: behavior-proof-\$\{\{ github\.sha \}\}/u);
  assert.match(body, /path: behavior-proof/u);
  assert.match(body, /if-no-files-found: error/u);
});

test("non-required full-matrix context verifies the proof and remains fail-closed", () => {
  const body = job("full-matrix");
  assert.match(body, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(body, /needs: \[behavior\]/u);
  assert.match(body, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/u);
  assert.match(body, /run: node scripts\/ci\/verify-behavior-gate\.mjs --full-matrix/u);
  assert.doesNotMatch(body, /continue-on-error/u);
});

test("required context verifies the candidate and ratchets against its merge-base baseline", () => {
  const body = job("required");
  const baselineStep = namedStep(body, "Generate behavior baseline from merge base");
  const ratchetStep = namedStep(body, "Reject behavior cell-count regression");
  assert.match(body, /needs: \[native, portable, db, browser, alpha, mutation, behavior\]/u);
  assert.doesNotMatch(body, /needs:[^\n]*full-matrix/u);
  assert.match(body, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/u);
  assert.match(body, /fetch-depth: 0/u);
  assert.match(body, /verify-behavior-gate\.mjs --local-candidate/u);
  assert.match(baselineStep, /base_ref="\$\{\{ github\.base_ref \|\| 'main' \}\}"/u);
  assert.match(
    baselineStep,
    /git fetch --no-tags origin "\+refs\/heads\/\$base_ref:refs\/remotes\/origin\/\$base_ref"/u,
  );
  assert.match(
    baselineStep,
    /git rev-parse --verify --quiet "\$base_remote\^\{commit\}" >\/dev\/null/u,
  );
  assert.match(baselineStep, /git merge-base HEAD "\$base_remote"/u);
  assert.match(baselineStep, /git worktree add --detach/u);
  assert.match(baselineStep, /pnpm --dir "\$baseline_root" install --frozen-lockfile/u);
  assert.match(baselineStep, /node scripts\/ci\/run-behavior-proof\.mjs/u);
  assert.match(
    baselineStep,
    /cp "\$baseline_root\/behavior-proof\/cell-report\.json" "\$RUNNER_TEMP\/baseline-cell-report\.json"/u,
  );
  assert.match(baselineStep, /trap cleanup EXIT/u);
  assert.match(baselineStep, /git worktree remove --force "\$baseline_root"/u);
  assert.match(baselineStep, /trap - EXIT/u);
  assert.match(ratchetStep, /node scripts\/ci\/behavior-cell-ratchet\.mjs/u);
  assert.match(ratchetStep, /\$RUNNER_TEMP\/baseline-cell-report\.json/u);
  assert.doesNotMatch(ratchetStep, /\$baseline_root|behavior-baseline/u);
  assert.match(body, /success,success,success,success,success,success,success/u);
});
