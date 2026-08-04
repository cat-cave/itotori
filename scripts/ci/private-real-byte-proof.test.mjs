// @itotori-meta-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  APPROVED_ZDR_PROFILE,
  EVIDENCE_SCHEMA,
  assertContentFree,
  buildEvidenceManifest,
  deriveStages,
  evaluateProofGate,
  parseProofMode,
  probeFromEnv,
  requireProtectedPrivateAgent,
  repoRoot,
} from "./private-real-byte-proof.mjs";

// A fully-present probe (all required bytes staged, content-address matches,
// ZDR profile attested) — the only shape that passes.
function presentProbe(overrides = {}) {
  return {
    corpora: [
      {
        id: "reallive-alpha-corpus",
        rootPresent: true,
        hashListPresent: true,
        contentAddressExpected: "a".repeat(64),
        contentAddressActual: "a".repeat(64),
        ...overrides.corpus,
      },
    ],
    zdr: {
      profilePresent: true,
      profileValue: APPROVED_ZDR_PROFILE,
      expected: APPROVED_ZDR_PROFILE,
      ...overrides.zdr,
    },
  };
}

test("gate passes only when required bytes are present, content-addressed, and ZDR is attested", () => {
  const result = evaluateProofGate(presentProbe());
  assert.equal(result.ok, true, `unexpected failures: ${JSON.stringify(result.failures)}`);
});

// --- THE KEY INVERSION: missing required bytes = FAIL, never skip ------------
test("a MISSING required corpus FAILS the gate (fail, not skip)", () => {
  const result = evaluateProofGate(presentProbe({ corpus: { rootPresent: false } }));
  assert.equal(result.ok, false);
  const f = result.failures.find((x) => x.id === "reallive-alpha-corpus");
  assert.equal(f.kind, "missing-required-bytes");
  assert.match(f.reason, /not skip/);
});

test("a present corpus with NO hash list cannot content-address and FAILS", () => {
  const result = evaluateProofGate(
    presentProbe({ corpus: { hashListPresent: false, contentAddressActual: null } }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((x) => x.kind === "no-content-address"));
});

test("an UNPINNED content-address FAILS the gate", () => {
  const result = evaluateProofGate(presentProbe({ corpus: { contentAddressExpected: null } }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((x) => x.kind === "unpinned-content-address"));
});

test("a content-address MISMATCH (wrong staged bytes) FAILS the gate", () => {
  const result = evaluateProofGate(
    presentProbe({ corpus: { contentAddressActual: "b".repeat(64) } }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((x) => x.kind === "content-address-mismatch"));
});

test("a missing ZDR profile FAILS the gate", () => {
  const result = evaluateProofGate(
    presentProbe({ zdr: { profilePresent: false, profileValue: null } }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((x) => x.kind === "zdr-profile-missing"));
});

test("a DRIFTED ZDR profile FAILS the gate", () => {
  const result = evaluateProofGate(presentProbe({ zdr: { profileValue: "openai/gpt-4o" } }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((x) => x.kind === "zdr-profile-drift"));
});

// --- probeFromEnv wiring: env + fs → gate probes ----------------------------
test("probeFromEnv treats an absent inventory row as a missing corpus (no skip path)", () => {
  const probes = probeFromEnv(
    {},
    { isDir: () => false, isFile: () => false, sha256File: () => "x" },
  );
  const result = evaluateProofGate(probes);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((x) => x.kind === "missing-required-bytes"));
  assert.ok(result.failures.some((x) => x.id === "zdr"));
});

test("probeFromEnv computes the content-address from the staged hash list", () => {
  const inventory = `schema = "inventory/v1"

[[corpus]]
id = "corpus-reallive-1-encrypted"
engine = "engine-reallive"
variant = "variant-encrypted"
root = "/staged/private-engine-corpus"
content_address = "deadbeef"
tags = ["strict"]
access = "read-only"
`;
  const probes = probeFromEnv(
    {
      ITOTORI_ZDR_PROFILE: APPROVED_ZDR_PROFILE,
    },
    { isDir: () => true, isFile: () => true, sha256File: () => "deadbeef" },
    inventory,
  );
  const result = evaluateProofGate(probes);
  assert.equal(result.ok, true);
});

// --- CONTENT-FREE manifest ---------------------------------------------------
test("a well-formed evidence manifest is content-free and correctly shaped", () => {
  const manifest = buildEvidenceManifest({
    generatedAt: "2026-07-20T00:00:00.000Z",
    zdrProfile: APPROVED_ZDR_PROFILE,
    corpora: [
      {
        id: "reallive-alpha-corpus",
        contentAddress: "a".repeat(64),
        rawFileCount: 129,
        byteCount: 4000000,
      },
    ],
    stages: {
      extract: { executed: true, passed: true, itemCount: 129, artifactHash: "c".repeat(64) },
      structure: { executed: true, passed: true, itemCount: 2031, artifactHash: "d".repeat(64) },
      patch: { executed: true, passed: true, itemCount: 129, artifactHash: "e".repeat(64) },
      replay: { executed: true, passed: true, itemCount: 129, artifactHash: "f".repeat(64) },
    },
  });
  assert.equal(manifest.schema, EVIDENCE_SCHEMA);
  assert.equal(manifest.stages.patch.itemCount, 129);
  assert.equal(manifest.corpora[0].byteCount, 4000000);
  // Round-trips through assertContentFree without throwing.
  assert.doesNotThrow(() => assertContentFree(manifest));
});

test("assertContentFree REJECTS a text-bearing key (no smuggled source/target text)", () => {
  assert.throws(() => assertContentFree({ id: "x", sourceText: "こんにちは" }), /text-bearing key/);
  assert.throws(
    () => assertContentFree({ nested: { translation: "hello there" } }),
    /text-bearing key/,
  );
});

test("assertContentFree REJECTS a long non-hash string (a pasted paragraph)", () => {
  const paragraph = "x ".repeat(80);
  assert.throws(() => assertContentFree({ id: "x", note: paragraph }), /long non-hash string/);
});

test("assertContentFree ALLOWS long hex hashes (they are not text)", () => {
  assert.doesNotThrow(() => assertContentFree({ hash: "0123456789abcdef".repeat(8) }));
});

test("buildEvidenceManifest drops any extra stage keys (only counts/hash/exec survive)", () => {
  const manifest = buildEvidenceManifest({
    generatedAt: "2026-07-20T00:00:00.000Z",
    zdrProfile: APPROVED_ZDR_PROFILE,
    corpora: [
      {
        id: "reallive-alpha-corpus",
        contentAddress: "a".repeat(64),
        rawFileCount: 1,
        byteCount: 1,
      },
    ],
    stages: {
      extract: {
        executed: true,
        passed: true,
        itemCount: 1,
        artifactHash: "a".repeat(64),
        sourceText: "LEAK",
      },
    },
  });
  assert.ok(!("sourceText" in manifest.stages.extract));
});

test("deriveStages defaults absent stages to not-executed (never fabricates a pass)", () => {
  const stages = deriveStages({ extract: { executed: true, passed: true, itemCount: 5 } });
  assert.equal(stages.replay.executed, false);
  assert.equal(stages.replay.passed, false);
});

// --- workflow quarantine: external protected path is not installed ----------
const wf = readFileSync(join(repoRoot, ".github/workflows/real-bytes-private-proof.yml"), "utf8");

test("the private-proof workflow has only a manual fail-closed trigger", () => {
  assert.match(wf, /workflow_dispatch:/);
  assert.doesNotMatch(wf, /pull_request:|merge_group:|push:/u);
  assert.match(wf, /external-private-evidence-agent-unavailable/u);
  assert.match(wf, /exit 1/u);
});

test("the quarantined workflow cannot reach candidate code, private runners, inputs, or uploads", () => {
  assert.doesNotMatch(wf, /self-hosted|itotori-corpora|actions\/checkout|setup-itotori/u);
  assert.doesNotMatch(wf, /upload-artifact|ITOTORI_ZDR_PROFILE|pull_request/u);
});

test("the local private lane cannot claim acceptance without the protected agent", () => {
  assert.throws(requireProtectedPrivateAgent, /external-private-evidence-agent-unavailable/u);
  assert.equal(parseProofMode(["--accepted"]), "--accepted");
  assert.throws(
    () => parseProofMode(["--accepted", "--preflight"]),
    /private-proof-mode-must-be-exactly-one/u,
  );
  const conflicting = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/ci/private-real-byte-proof.mjs"), "--accepted", "--preflight"],
    { encoding: "utf8" },
  );
  assert.equal(conflicting.status, 2);
  assert.equal(conflicting.stdout, "");
  assert.match(conflicting.stderr, /^usage: private-real-byte-proof\.mjs/u);
  assert.doesNotMatch(conflicting.stderr, /proof gate passed/u);
  const dispatcher = readFileSync(join(repoRoot, "scripts/developer-command.mjs"), "utf8");
  assert.match(dispatcher, /private-real-byte-proof\.mjs", "--accepted"/u);
});

test("a passing local preflight still fails accepted proof without the protected agent", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "itotori-private-proof-"));
  const configRoot = join(fixtureRoot, "config");
  const corpusRoot = join(fixtureRoot, "corpus");
  const hashList = `${JSON.stringify({ path: "fixture.bin", bytes: 1 })}\n`;
  const contentAddress = createHash("sha256").update(hashList).digest("hex");
  mkdirSync(join(configRoot, "itotori"), { recursive: true });
  mkdirSync(corpusRoot, { recursive: true });
  writeFileSync(join(corpusRoot, "private-hash-list.local.jsonl"), hashList);
  writeFileSync(
    join(configRoot, "itotori", "inventory.toml"),
    `[[corpus]]\nid = "corpus-reallive-1-encrypted"\nroot = ${JSON.stringify(corpusRoot)}\ncontent_address = "${contentAddress}"\n`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts/ci/private-real-byte-proof.mjs"), "--accepted"],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configRoot,
          ITOTORI_ZDR_PROFILE: APPROVED_ZDR_PROFILE,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /gate ok:/u);
    assert.equal(result.stderr, "external-private-evidence-agent-unavailable\n");
    assert.deepEqual(readdirSync(fixtureRoot).sort(), ["config", "corpus"]);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

// --- the required merge-queue checks are UNCHANGED --------------------------
test("pr-tiers still exposes exactly the tier0+tier1 required checks (private proof is not one)", () => {
  const prTiers = readFileSync(join(repoRoot, ".github/workflows/pr-tiers.yml"), "utf8");
  assert.match(prTiers, /uses:\s*\.\/\.github\/workflows\/_tier0\.yml/);
  assert.match(prTiers, /uses:\s*\.\/\.github\/workflows\/_tier1\.yml/);
  assert.ok(
    !prTiers.includes("real-bytes-private-proof"),
    "pr-tiers must not reference the private proof lane",
  );
  const tier0 = readFileSync(join(repoRoot, ".github/workflows/_tier0.yml"), "utf8");
  const tier1 = readFileSync(join(repoRoot, ".github/workflows/_tier1.yml"), "utf8");
  assert.match(tier0, /name:\s*Tier 0 \/ required/);
  assert.match(tier1, /name:\s*Tier 1 \/ required/);
});
