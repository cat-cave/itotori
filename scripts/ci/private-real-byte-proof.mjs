#!/usr/bin/env node
// PRIVATE REAL-BYTE PROOF LANE — gate + content-free evidence manifest.
//
// This is the OPT-IN counterpart to the public secretless lane. It runs ONLY
// on a host that stages the content-addressed Sweetie corpus and attests the
// exact approved ZDR profile, and it exercises extract → structure → patch →
// replay on ACTUAL bytes. It is NOT a merge-required check (public runners have
// no real bytes); it is triggered on demand / by label. See
// .github/workflows/real-bytes-private-proof.yml + `just ci-real-bytes-private-proof`.
//
// THE KEY INVERSION (fail, not skip): the periodic oracle may skip a corpus
// family that is legitimately absent (e.g. Softpal under its own root). This
// proof lane may NOT. When a REQUIRED real corpus is missing — or the ZDR
// profile drifts — the gate FAILS (red), it never green-skips. A run that
// cannot see the required real bytes is a failed proof, not a passed one.
//
// CONTENT-FREE EVIDENCE: the emitted manifest carries only counts, hashes, and
// ids — never copyrighted bytes or any prompt/source/target text. `assert
// ContentFree` rejects text-bearing keys and any long non-hash string, so the
// manifest cannot smuggle restricted content out of the private host. Aligns
// with the redaction toggle: what is published is counts/hashes/ids only.
//
// Usage:
//   node scripts/ci/private-real-byte-proof.mjs --preflight
//       Evaluate the gate from the environment. Exit 1 (never skip) on any
//       missing required corpus, unpinned/mismatched content-address, or ZDR
//       profile drift. Prints only content-free failure reasons.
//   node scripts/ci/private-real-byte-proof.mjs --emit-manifest \
//       --results <stage-results.json> --out <evidence.json>
//       Build + validate + write the content-free evidence manifest from the
//       staged corpus and the proof-stage results. Fails loud if results absent.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");

export const EVIDENCE_SCHEMA = "itotori.private_real_byte_proof.evidence.v0";

// The EXACT approved ZDR model/provider profile for the qualifying run. The
// runtime environment must attest this precise value; any other value (or an
// unset profile) is policy drift and FAILS the gate.
export const APPROVED_ZDR_PROFILE = "deepseek/deepseek-v4-flash:zdr";

// The canonical per-corpus raw-file hash list (docs/fixtures-and-corpora.md).
// Its sha256 is the corpus CONTENT-ADDRESS — cited publicly, never the bytes.
export const HASH_LIST_BASENAME = "private-hash-list.local.jsonl";

// REQUIRED real corpora for this proof. The content-addressed Sweetie corpus is
// the load-bearing one: extract → structure → patch → replay run on its bytes.
export const REQUIRED_CORPORA = [
  {
    id: "sweetie-reallive",
    role: "content-addressed Sweetie corpus (RealLive) — extract/structure/patch/replay ground truth",
    rootEnv: "ITOTORI_REAL_GAME_ROOT",
    contentAddressEnv: "ITOTORI_SWEETIE_CONTENT_ADDRESS",
  },
];

// ---------------------------------------------------------------------------
// GATE — pure over injected probes so the regression suite can simulate a
// missing corpus / drifted profile with no filesystem.
// ---------------------------------------------------------------------------
export function evaluateProofGate({ corpora, zdr }) {
  const failures = [];
  for (const c of corpora) {
    if (!c.rootPresent) {
      failures.push({
        id: c.id,
        kind: "missing-required-bytes",
        reason: "required corpus root absent — FAIL, not skip",
      });
    } else if (!c.hashListPresent) {
      failures.push({
        id: c.id,
        kind: "no-content-address",
        reason: "corpus staged but hash list absent — cannot content-address",
      });
    } else if (!c.contentAddressExpected) {
      failures.push({
        id: c.id,
        kind: "unpinned-content-address",
        reason: "content-address not pinned via env",
      });
    } else if (c.contentAddressActual !== c.contentAddressExpected) {
      failures.push({
        id: c.id,
        kind: "content-address-mismatch",
        reason: "staged bytes do not match the pinned content-address",
      });
    }
  }
  if (!zdr.profilePresent) {
    failures.push({ id: "zdr", kind: "zdr-profile-missing", reason: "ZDR profile not attested" });
  } else if (zdr.profileValue !== zdr.expected) {
    failures.push({
      id: "zdr",
      kind: "zdr-profile-drift",
      reason: "attested ZDR profile drifts from the approved profile",
    });
  }
  return { ok: failures.length === 0, failures };
}

// Build gate probes from the environment (+ filesystem). Impure; the pure gate
// above does the deciding.
export function probeFromEnv(env, fsOps) {
  const corpora = REQUIRED_CORPORA.map((spec) => {
    const rootPath = env[spec.rootEnv];
    const rootPresent = Boolean(rootPath) && fsOps.isDir(rootPath);
    const hashListPath = rootPath ? join(rootPath, HASH_LIST_BASENAME) : null;
    const hashListPresent = Boolean(hashListPath) && fsOps.isFile(hashListPath);
    const contentAddressExpected = env[spec.contentAddressEnv] || null;
    const contentAddressActual = hashListPresent ? fsOps.sha256File(hashListPath) : null;
    return {
      id: spec.id,
      role: spec.role,
      rootPath,
      rootPresent,
      hashListPresent,
      contentAddressExpected,
      contentAddressActual,
    };
  });
  const zdr = {
    profilePresent: Boolean(env.ITOTORI_ZDR_PROFILE),
    profileValue: env.ITOTORI_ZDR_PROFILE || null,
    expected: APPROVED_ZDR_PROFILE,
  };
  return { corpora, zdr };
}

// ---------------------------------------------------------------------------
// CONTENT-FREE VALIDATION. Reject text-bearing keys and any long non-hash
// string. This is the guarantee that no copyrighted / prompt / source / target
// text can leave the private host inside the evidence manifest.
// ---------------------------------------------------------------------------
export const FORBIDDEN_TEXT_KEYS = new Set([
  "source",
  "sourcetext",
  "target",
  "targettext",
  "text",
  "prompt",
  "prompttext",
  "dialogue",
  "translation",
  "excerpt",
  "content",
  "body",
  "message",
  "raw",
  "rawtext",
  "snippet",
  "caption",
  "line",
  "lines",
  "speech",
  "utterance",
]);
const HEX_RE = /^[0-9a-f]+$/u;
const MAX_FREEFORM_STRING = 96;

export function assertContentFree(node, path = "$") {
  if (node === null || typeof node === "number" || typeof node === "boolean") return;
  if (typeof node === "string") {
    if (node.length > MAX_FREEFORM_STRING && !(HEX_RE.test(node) && node.length >= 32)) {
      throw new Error(
        `content-free violation at ${path}: long non-hash string (possible smuggled text)`,
      );
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertContentFree(v, `${path}[${i}]`));
    return;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_TEXT_KEYS.has(key.toLowerCase())) {
        throw new Error(`content-free violation at ${path}.${key}: text-bearing key is forbidden`);
      }
      assertContentFree(value, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`content-free violation at ${path}: unsupported node type ${typeof node}`);
}

// ---------------------------------------------------------------------------
// EVIDENCE MANIFEST — counts/hashes/ids only.
// ---------------------------------------------------------------------------
export function buildEvidenceManifest({ generatedAt, zdrProfile, corpora, stages }) {
  const manifest = {
    schema: EVIDENCE_SCHEMA,
    generatedAt,
    zdrProfileVerified: zdrProfile,
    corpora: corpora.map((c) => ({
      id: c.id,
      contentAddress: c.contentAddress,
      rawFileCount: c.rawFileCount,
      byteCount: c.byteCount,
    })),
    stages: {
      extract: pickStage(stages.extract),
      structure: pickStage(stages.structure),
      patch: pickStage(stages.patch),
      replay: pickStage(stages.replay),
    },
  };
  assertContentFree(manifest);
  return manifest;
}

// The four proof stages are described by counts + an artifact hash + whether
// the stage executed and passed. Only these keys survive into the manifest.
function pickStage(stage = {}) {
  return {
    executed: Boolean(stage.executed),
    passed: Boolean(stage.passed),
    itemCount: Number.isFinite(stage.itemCount) ? stage.itemCount : 0,
    artifactHash: typeof stage.artifactHash === "string" ? stage.artifactHash : null,
  };
}

// ---------------------------------------------------------------------------
// Corpus evidence collector (impure). Reads the canonical hash list and derives
// content-address + raw-file/byte counts WITHOUT reading any raw corpus bytes.
// ---------------------------------------------------------------------------
export function collectCorpusEvidence(rootPath) {
  const hashListPath = join(rootPath, HASH_LIST_BASENAME);
  const text = readFileSync(hashListPath, "utf8");
  const contentAddress = createHash("sha256").update(text).digest("hex");
  let rawFileCount = 0;
  let byteCount = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    rawFileCount += 1;
    byteCount += Number(entry.bytes) || 0;
  }
  return { contentAddress, rawFileCount, byteCount };
}

// Derive the four proof-stage rows from a proof-stage results file. The file
// maps each stage to { executed, passed, itemCount, artifactHash }. No text.
export function deriveStages(resultsJson) {
  const out = {};
  for (const stage of ["extract", "structure", "patch", "replay"]) {
    out[stage] = resultsJson[stage] || { executed: false, passed: false };
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function preflight() {
  const fsOps = {
    isDir: (p) => existsSync(p),
    isFile: (p) => existsSync(p),
    sha256File,
  };
  const probes = probeFromEnv(process.env, fsOps);
  const result = evaluateProofGate(probes);
  for (const c of probes.corpora) {
    process.stdout.write(
      `corpus ${c.id}: root=${c.rootPresent ? "present" : "ABSENT"} content-address=${c.contentAddressActual ? "computed" : "none"}\n`,
    );
  }
  process.stdout.write(
    `zdr: ${probes.zdr.profilePresent ? "attested" : "ABSENT"} (approved=${APPROVED_ZDR_PROFILE})\n`,
  );
  if (!result.ok) {
    process.stderr.write("\nprivate real-byte proof GATE FAILED (fail, not skip):\n");
    for (const f of result.failures) process.stderr.write(`  - [${f.id}] ${f.kind}: ${f.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(
    "gate ok: required Sweetie bytes present + content-addressed, ZDR profile attested.\n",
  );
}

// Record one PASSED proof stage into the results file. The recipe calls this
// only AFTER a stage command succeeds (bash `set -e` aborts otherwise), so a
// recorded stage is provably an executed+passed stage — never fabricated.
function recordStage() {
  const stage = argValue("--record-stage");
  const resultsPath = argValue("--results");
  if (!stage || !["extract", "structure", "patch", "replay"].includes(stage) || !resultsPath) {
    process.stderr.write(
      "record-stage: need --record-stage <extract|structure|patch|replay> --results <file>\n",
    );
    process.exit(2);
  }
  const countArg = argValue("--count");
  const artifactPath = argValue("--artifact");
  const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : {};
  results[stage] = {
    executed: true,
    passed: true,
    itemCount: countArg != null && Number.isFinite(Number(countArg)) ? Number(countArg) : 0,
    artifactHash: artifactPath && existsSync(artifactPath) ? sha256File(artifactPath) : null,
  };
  mkdirSync(dirname(resolve(resultsPath)), { recursive: true });
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`recorded proof stage: ${stage}\n`);
}

function emitManifest() {
  const resultsPath = argValue("--results");
  const outPath = argValue("--out") || ".tmp/private-proof/evidence.json";
  if (!resultsPath || !existsSync(resultsPath)) {
    process.stderr.write(
      `emit-manifest: proof-stage results file missing (${resultsPath ?? "--results not given"}); refusing to emit an empty manifest.\n`,
    );
    process.exit(1);
  }
  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  const rootPath = process.env.ITOTORI_REAL_GAME_ROOT;
  if (!rootPath || !existsSync(join(rootPath, HASH_LIST_BASENAME))) {
    process.stderr.write(
      "emit-manifest: Sweetie corpus root / hash list absent; run --preflight first.\n",
    );
    process.exit(1);
  }
  const evidence = collectCorpusEvidence(rootPath);
  const manifest = buildEvidenceManifest({
    generatedAt: new Date().toISOString(),
    zdrProfile: APPROVED_ZDR_PROFILE,
    corpora: [{ id: "sweetie-reallive", ...evidence }],
    stages: deriveStages(results),
  });
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`content-free evidence manifest written: ${outPath}\n`);
}

function main() {
  if (process.argv.includes("--preflight")) return preflight();
  if (process.argv.includes("--record-stage")) return recordStage();
  if (process.argv.includes("--emit-manifest")) return emitManifest();
  process.stderr.write(
    "usage: private-real-byte-proof.mjs --preflight | --record-stage <s> --results <f> | --emit-manifest --results <f> --out <f>\n",
  );
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
