#!/usr/bin/env node
/*
 * the relevant capability — Private-local key-hunting run workflow (deterministic core).
 *
 * Pure, deterministic core for the `kaifuu:key-hunt` workflow. It ORCHESTRATES
 * the established private-local + helper + redaction patterns into a key-hunting
 * run: it PLANS which helper attempts apply to a detected engine + capability
 * level (the relevant capability Siglus known-key, XP3 key, MV/MZ key, Wolf archive key,
 * RGSS3 key — plan, never brute-force), turns operator-authored, ALREADY-REDACTED
 * key-hunt manifests into a SAFE AGGREGATE redacted report of per-attempt
 * outcomes, and produces a deterministic REDACTED no-corpus artifact when no
 * private inputs exist.
 *
 * This is a SIBLING of the relevant capability (private-local encrypted corpus triage) and
 * the relevant capability (Siglus private-local validation renderer). It REUSES their
 * redaction boundary directly — the structural secret scanner (`findSecretLeak`),
 * the recursive deep-scan (`assertNoSecrets`), and the deterministic serializer
 * (`stableStringify`) — and composes them with the the relevant capability/090/129 helper
 * result + secret-ref pattern.
 *
 * COPYRIGHT / STRICT-PROOF LAW (this module is the enforcement point):
 *   - The workflow NEVER reads raw keys, raw encrypted bytes, decrypted text, or
 *     retail assets, and NEVER shells out to a real helper (Wine/Proton/native
 *     Windows). The attempt planner RESOLVES the plan; actual helper execution is
 *     out-of-band and its OUTCOME is recorded by the operator in a redacted
 *     manifest. Its ONLY input is that redacted manifest JSON (logical corpus /
 *     helper / key-profile ids, capability levels, helper classes, tool versions,
 *     redacted command lines, per-attempt OUTCOMES, proof HASHES).
 *   - TWO redaction boundaries:
 *       * The emitted REDACTED REPORT is scanned with the the relevant capability base scanner
 *         (`assertNoSecrets`), which rejects absolute local paths, `local-secret:`
 *         refs, PEM blocks, and raw key/hex material. The report therefore carries
 *         NO secret refs and NO raw keys — only counts, profile ids, proof hashes,
 *         tool versions, and redacted command lines.
 *       * A CONFIRMED key is represented by a KEY VALIDATION RESULT record that
 *         stores ONLY a `local-secret:` ref + a `sha256:` proof hash + a logical
 *         key-profile id. That record is scanned with `assertNoRawKey`, which
 *         ALLOWS the `local-secret:` ref (its intended storage form) but rejects
 *         any raw key material, PEM block, or absolute local path in ANY field.
 *         The report surfaces ONLY the key-profile id + proof hash from it — never
 *         the secret ref.
 *   - Every value that reaches an emitted artifact is DEEP-SCANNED; a leak THROWS
 *     BEFORE anything is written (fail-loud, emit nothing — never silently
 *     redacts).
 *   - Output is byte-deterministic (sorted keys, no timestamps, no absolute
 *     paths), so the committed public-safe examples and the no-corpus artifact are
 *     stable and diffable and validate in public CI without private assets.
 */
"use strict";

// Reuse the the relevant capability redaction boundary directly.
import {
  assertNoSecrets,
  findSecretLeak,
  stableStringify,
} from "../kaifuu-private-local-triage/triage.mjs";

export { assertNoSecrets, findSecretLeak, stableStringify };

export const REPORT_SCHEMA_VERSION = "itotori.kaifuu-key-hunt-report.v0.1";
export const MANIFEST_SCHEMA_VERSION = "itotori.kaifuu-key-hunt-manifest.v0.1";
export const GENERATOR_PATH = "suite/scripts/kaifuu-key-hunt/run.mjs";
export const KEY_HUNT_TASK = "kaifuu:key-hunt";

// Canonical redacted command strings. The real argv is NEVER recorded (it can
// carry local absolute paths); the mode maps to a fixed logical command.
export const COMMANDS = {
  noCorpus: "vp run kaifuu:key-hunt -- --no-corpus",
  manifest: "vp run kaifuu:key-hunt -- --manifest <private-manifest>",
  corpusDir: "vp run kaifuu:key-hunt -- --corpus-dir <private-corpus-directory>",
};

// Per-engine outcome bins cover the encrypted engines the beta key-hunting lane
// tracks. Order is fixed so bins serialize deterministically. Matches the relevant capability.
export const ENGINES = [
  "rpg-maker-mv",
  "rpg-maker-mz",
  "kirikiri-xp3",
  "siglus",
  "wolf",
  "rgss3-vx-ace",
];

// The five per-attempt OUTCOME categories the acceptance requires. Order fixed
// for deterministic serialization.
//   - attempted   : the helper ran and produced a CANDIDATE key still pending
//                   round-trip confirmation (validation in flight).
//   - succeeded   : the helper ran and the candidate was CONFIRMED (it decrypts /
//                   round-trips); carries a key-validation result (ref + proof).
//   - failed      : the helper ran but no key was confirmed (candidate rejected).
//   - skipped     : an attempt was PLANNED but not run (helper capability/binary
//                   absent on this host, or gated).
//   - unsupported : no attempt applies (unsupported engine or corpus variant).
export const OUTCOMES = ["attempted", "succeeded", "failed", "skipped", "unsupported"];

// Helper capability levels, ordered weakest -> strongest. The attempt planner
// uses this ordering to decide whether a planned attempt is RUNNABLE at the
// detected capability (the relevant capability wine-local, the relevant capability native-windows).
export const CAPABILITY_LEVELS = [
  "detect-only",
  "static-known-key",
  "wine-local",
  "native-windows",
];

// Helper classes (mirror the relevant capability). `none` marks an unsupported engine/variant.
export const HELPER_CLASSES = [
  "staticParser",
  "runtimeHelper",
  "patchDatabase",
  "executableAnalysis",
  "none",
];

// Attempt kinds the planner can select. `none` is the sentinel for an
// unsupported engine/variant (no hunting path).
export const ATTEMPT_KINDS = [
  "siglus-known-key",
  "xp3-key",
  "mv-mz-key",
  "wolf-archive-key",
  "rgss3-key",
  "none",
];

// --- Attempt planner --------------------------------------------------------
//
// The planner SELECTS which helper attempts apply to a detected engine +
// capability level. It PLANS the canonical attempt(s) for the engine (it does
// NOT brute-force a key space) and marks each attempt RUNNABLE only when the
// detected capability meets the attempt's minimum. An unknown engine yields an
// empty plan (every attempt for it is `unsupported`).
const ENGINE_PLANS = {
  siglus: [
    {
      attemptKind: "siglus-known-key",
      helperClass: "staticParser",
      minCapability: "static-known-key",
    },
  ],
  "kirikiri-xp3": [
    { attemptKind: "xp3-key", helperClass: "staticParser", minCapability: "static-known-key" },
  ],
  "rpg-maker-mv": [
    { attemptKind: "mv-mz-key", helperClass: "staticParser", minCapability: "static-known-key" },
  ],
  "rpg-maker-mz": [
    { attemptKind: "mv-mz-key", helperClass: "staticParser", minCapability: "static-known-key" },
  ],
  wolf: [
    { attemptKind: "wolf-archive-key", helperClass: "runtimeHelper", minCapability: "wine-local" },
  ],
  "rgss3-vx-ace": [
    { attemptKind: "rgss3-key", helperClass: "staticParser", minCapability: "static-known-key" },
  ],
};

function capabilityRank(level) {
  const rank = CAPABILITY_LEVELS.indexOf(level);
  if (rank < 0) {
    throw new Error(`unknown capability level: ${JSON.stringify(level)}`);
  }
  return rank;
}

// Resolve the planned attempts for (engine, capabilityLevel). Returns a stable
// descriptor: `supportedEngine` is false for an unknown engine (its attempts are
// `unsupported`); each planned attempt is marked `runnable` when the detected
// capability meets its minimum (otherwise it must be `skipped`).
export function planAttempts(engine, capabilityLevel) {
  const rank = capabilityRank(capabilityLevel);
  const plans = ENGINE_PLANS[engine];
  if (plans === undefined) {
    return { engine, capabilityLevel, supportedEngine: false, attempts: [] };
  }
  const attempts = plans.map((plan) => ({
    attemptKind: plan.attemptKind,
    helperClass: plan.helperClass,
    minCapability: plan.minCapability,
    runnable: rank >= capabilityRank(plan.minCapability),
  }));
  return { engine, capabilityLevel, supportedEngine: true, attempts };
}

// The set of attempt kinds the planner would select for an engine (ignoring
// capability). Used to validate that a manifest attempt's declared kind belongs
// to the engine's plan.
export function plannedAttemptKinds(engine) {
  const plans = ENGINE_PLANS[engine];
  return plans === undefined ? [] : plans.map((plan) => plan.attemptKind);
}
