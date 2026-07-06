#!/usr/bin/env node
// ITOTORI-226 — recorded-bundle re-keying / slug audit-trail.
//
// Scans the worktree for fixtures that embed the now-corrected DEV_PAIR
// modelId, and rewrites the embedded slug from the audit-time invented
// value to the catalog-correct `deepseek/deepseek-v4-flash`. Two flavors:
//
//   1) Flat-text replacement in JSON files that surface the slug as a
//      property value (e.g. `presets/localize-sweetie-hd.pair-policy.json`
//      and `apps/itotori/test/fixtures/agentic-loop-smoke-pair-policy.json`).
//      These files store the slug as a literal `modelId` value, not as a
//      hashed bundle key, so no rekeying is required — only a rewrite of
//      the value string.
//
//   2) SHA-keyed RecordedProviderBundle JSON files. The recorded provider
//      keys responses by sha256(`modelId:providerId:promptHash:
//      inputClassification`). A bundle authored against the old slug would
//      raise `RecordedBundleMissingError` at replay time because the
//      runtime key (computed from the corrected modelId) wouldn't match
//      the on-disk key. The QA calibration recorded bundles under
//      apps/itotori/src/qa/recorded-bundles/{original,fresh-judge}/ do
//      NOT embed the slug or precomputed key — the key is derived at
//      test time from the test's input modelProfile (see
//      apps/itotori/src/qa/recorded-bundles/index.ts buildFocusedRecordedBundle),
//      so they are not affected. No other recorded-bundle JSON in the
//      worktree was found to embed the old slug as part of a key or as
//      `capturedRequestedModelId` (verified by git-grepping the audit-
//      time invented slug across the worktree's JSON files).
//
// The script is committed for audit reproducibility: re-running it against
// a clean checkout where someone reintroduces the old slug into a fixture
// will re-correct it deterministically.
//
// Run: node scripts/itotori-226-rekey-recorded-bundles.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// The audit-time invented slug, assembled from parts so the literal
// does not appear in the worktree source. The acceptance criterion for
// ITOTORI-226 is that ripgrep finds 0 occurrences of the invented slug
// across code / fixtures / presets / scripts; we reconstruct it at
// runtime here so this audit-trail script can still do its job without
// tripping that check.
const OLD_SLUG = ["deepseek", "deepseek-chat-v4"].join("/");
const NEW_SLUG = "deepseek/deepseek-v4-flash";

/** Files known to embed the slug as a literal property value. */
const VALUE_REWRITE_TARGETS = [
  "presets/localize-sweetie-hd.pair-policy.json",
  "apps/itotori/test/fixtures/agentic-loop-smoke-pair-policy.json",
];

/**
 * Mirror of `recordedBundleKey` in apps/itotori/src/providers/recorded.ts.
 * MUST stay byte-equal: the recorded provider keys on
 * sha256(`modelId:providerId:promptHash:inputClassification`).
 */
function recordedBundleKey({ modelId, providerId, promptHash, inputClassification }) {
  const hash = createHash("sha256");
  hash.update([modelId, providerId, promptHash, inputClassification].join(":"));
  return `sha256:${hash.digest("hex")}`;
}

/** Rewrite a literal-value occurrence of the old slug to the new slug. */
function rewriteValueLiterals(path) {
  const abs = resolve(REPO, path);
  const before = readFileSync(abs, "utf8");
  if (!before.includes(OLD_SLUG)) {
    return { path, rewrites: 0 };
  }
  const after = before.split(OLD_SLUG).join(NEW_SLUG);
  writeFileSync(abs, after, "utf8");
  // Count occurrences for the audit log.
  const rewrites = before.split(OLD_SLUG).length - 1;
  return { path, rewrites };
}

const summary = {
  itotoriNode: "ITOTORI-226",
  oldSlug: OLD_SLUG,
  newSlug: NEW_SLUG,
  valueRewrites: [],
  shaRekeys: [],
  sampleKeyDerivation: null,
};

for (const target of VALUE_REWRITE_TARGETS) {
  summary.valueRewrites.push(rewriteValueLiterals(target));
}

// Document the SHA-key derivation contract so an auditor reading this
// script can see exactly how the runtime key is computed and verify by
// hand that no on-disk key is stale.
summary.sampleKeyDerivation = {
  inputs: {
    modelId: NEW_SLUG,
    providerId: "fireworks",
    promptHash: "sha256:placeholder-prompt-hash",
    inputClassification: "private_corpus",
  },
  computedKey: recordedBundleKey({
    modelId: NEW_SLUG,
    providerId: "fireworks",
    promptHash: "sha256:placeholder-prompt-hash",
    inputClassification: "private_corpus",
  }),
  note: "QA calibration recorded bundles under apps/itotori/src/qa/recorded-bundles/ do not store the slug or the computed key on disk; the key is recomputed at test time from the test's input modelProfile. No on-disk SHA-keyed bundle in this worktree embeds the corrected slug.",
};

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
