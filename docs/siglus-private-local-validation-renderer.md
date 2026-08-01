# Siglus Private-Local Redacted Validation Renderer

`the relevant capability` renders **optional private-local Siglus validation summaries**
through the **redacted boundary**. It is the Siglus analogue of
[`the relevant capability`'s private-local encrypted corpus triage](kaifuu-private-local-triage.md):
a local operator records the outcomes of local Siglus validation runs (the
[`the relevant capability`](../crates/kaifuu-siglus/src/known_key_smoke.rs) known-key
Scene/Gameexe extract-patch-verify smoke and the broader `Scene.pck` /
`Gameexe.dat` stack) as a redacted validation manifest, and the renderer emits
only a **safe aggregate validation summary** that can be cited publicly by
aggregate/hash metadata.

It **reuses** the the relevant capability redaction boundary — the `findSecretLeak`
structural scan, the `assertNoSecrets`-style recursive deep scan, and the
deterministic `stableStringify` serializer — and extends the leak scanner with
Siglus-specific content categories.

## Copyright / strict-proof law

- The renderer **never** reads raw keys, key material, decrypted script text,
  retail `Scene.pck` / `Gameexe.dat` bytes, story/scene filenames, or helper raw
  dumps. Its only input is the redacted validation-manifest JSON an operator
  writes. It does **not** shell out and does **not** read corpus contents.
- The rendered summary emits **only** aggregates / categories / statuses /
  profile-ids / capability-levels / counts / hashes. Every value that reaches
  the emitted artifact is deep-scanned; a leak **throws before anything is
  written** (fail-loud, emit nothing — never silently redacts).
- Output is byte-deterministic (sorted keys, no timestamps, no absolute paths),
  so the committed public-safe fixture is stable and validates without private
  local assets.

## Command

```sh
# Explicitly exercise the content-free absent-input failure (exit nonzero).
pnpm exec vp run siglus:private-local-validation-render -- --no-corpus

# Render a single operator validation manifest.
pnpm exec vp run siglus:private-local-validation-render -- \
  --manifest fixtures/private-local/<corpus-id>/siglus-validation-manifest.local.json

# Scan a directory of private-local corpora (root manifest + one manifest per
# immediate corpus subdirectory).
pnpm exec vp run siglus:private-local-validation-render -- --corpus-dir fixtures/private-local
```

Source: [`suite/scripts/siglus-private-local-validation-renderer/`](../suite/scripts/siglus-private-local-validation-renderer).

## Not wired into CI

The render command is a private-local-only workflow. It is intentionally **not**
selected by any per-gate CI lane: `just check`/`ci` never invoke it, and neither
`scripts/affected.mjs` nor the CI workflows reference
`siglus:private-local-validation-render`. Public CI therefore never selects
private work. The hermetic test
(`siglus:private-local-validation-render-test`) uses mock manifests and
absent-input cases and needs no private inputs.

## Private-local validation manifest conventions

An operator records validation runs in a manifest under
`fixtures/private-local/<corpus-id>/siglus-validation-manifest.local.json` (git
ignored). It is authored **already redacted** — it holds only logical ids,
capability levels, helper outcome categories, validation statuses, failure
categories, aggregate counts, and proof **hashes**. Schema:
[`manifest.schema.json`](../suite/scripts/siglus-private-local-validation-renderer/manifest.schema.json).

Per-run fields:

| Field                   | Meaning                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profileId`             | Lowercase logical id (`[a-z0-9._-]`, no paths, no story/scene filenames).                                                                                 |
| `capabilityLevel`       | One of `detect-only`, `known-key-extract`, `known-key-patch-verify`, `broad-unsupported`.                                                                 |
| `validationStatus`      | One of `passed`, `helper_required`, `unknown_profile`, `unsupported_variant`, `out_of_profile`, `failed`, `skipped`.                                      |
| `helperOutcomeCategory` | One of `not_required`, `available_passed`, `required_missing`, `out_of_profile`, `error`.                                                                 |
| `failureCategory`       | One of `none`, `out_of_profile_compression`, `bad_magic`, `truncated`, `invalid_utf16le`, `bad_unit_key`, `unit_not_found`, `verify_mismatch`, `unknown`. |
| `counts`                | `{ scenesValidated, unitsValidated, gameexeEntriesValidated, filesProcessed }` non-negative integers.                                                     |
| `proofHashes`           | `sha256:<64 hex>` key-validation / patch round-trip proof hashes.                                                                                         |

Public-safe example input:
[`examples/siglus-validation-manifest.local.example.json`](../suite/scripts/siglus-private-local-validation-renderer/examples/siglus-validation-manifest.local.example.json).

## Capability levels are honestly scoped

`capabilityLevel` mirrors the crate's honest scope. `known-key-extract` and
`known-key-patch-verify` are the real, narrow `the relevant capability` known-key tiers;
`broad-unsupported` marks the real broad `Scene.pck` / `Gameexe.dat` path that
remains a skeleton stub (`siglus-04`/`siglus-06`). An aggregate can therefore
**never** imply unsupported production capability, and a `helper_required` /
`out_of_profile` case is never rendered as a validation success.

## Aggregate validation summary

The command aggregates validated runs into a safe summary. Schema:
[`validation-summary.schema.json`](../suite/scripts/siglus-private-local-validation-renderer/validation-summary.schema.json).
Top-level fields: `schemaVersion`, `status` (`ok`), `reason`,
`command` (canonical redacted command string), `generatedBy`, `engineFamily`
(`siglus`), `aggregateCounts` (`profiles`, `runs`, `scenesValidated`,
`unitsValidated`, `gameexeEntriesValidated`, `filesProcessed`),
`capabilityLevelBins`, `helperOutcomeBins`, `validationStatusBins`,
`failureCategoryBins`, and `runs` (redacted per-run rows). Public-safe example:
[`examples/validation-summary.example.json`](../suite/scripts/siglus-private-local-validation-renderer/examples/validation-summary.example.json).

## Missing input is a typed failure

A missing root or manifest, empty directory or selection, zero-byte or non-file
manifest, missing option value, or explicit `--no-corpus` request emits only a
typed content-free diagnostic, writes no summary, and exits nonzero. The
diagnostic never includes private paths, filenames, rejected values, parser
messages, or manifest content.

## What a summary may / must not contain

Summaries may be cited publicly by redacted profile ids, capability levels,
helper outcome categories, validation statuses, failure categories, aggregate
counts, and proof hashes. They must **never** contain raw key material,
decrypted script text, retail source text, story/scene filenames, raw helper
dumps, screenshots, or local absolute paths. The extended secret scanner catches
each of these categories:

| Leak category                     | Detector                                                   |
| --------------------------------- | ---------------------------------------------------------- |
| `raw-key-or-hex-blob`             | 24+ hex-char runs (allowing only `sha256:` proof tails).   |
| `pem-key-block`                   | PEM `BEGIN … PRIVATE KEY`/`PGP` markers.                   |
| `local-secret-ref`                | `local-secret:` references.                                |
| `absolute-local-path`             | Absolute local path roots (`/home`, `/scratch`, `C:\` …).  |
| `story-or-scene-filename`         | Retail asset/script extensions (`.pck`, `.dat`, `.ss`, …). |
| `decrypted-script-or-source-text` | Any non-ASCII code point (redacted summary is ASCII-only). |
| `helper-raw-dump`                 | Control chars / newlines (redacted summary has none).      |

The first three, plus absolute-path detection, are **reused directly** from the
the relevant capability `findSecretLeak` structural scanner; the last three are the
Siglus-specific extensions.

## Diagnostics

The renderer distinguishes the four acceptance diagnostics:

- **Missing private corpus** — a typed content-free failure with no evidence
  effect and a nonzero exit.
- **Redaction violation** — a `siglus-redaction-violation (<category>) at <path>`
  **throw**; the summary is never emitted.
- **Unknown profile** — the `unknown_profile` validation-status bin.
- **Helper-required** — the `helper_required` validation-status bin.

## Tests

[`render.test.mjs`](../suite/scripts/siglus-private-local-validation-renderer/render.test.mjs)
is hermetic (`node --test`, no network/DB/build/private corpora). It proves
absent-input failure with no effects, the redacted aggregate summary matches
the committed example, rejected private values do not leak through command
diagnostics, per-category seeded-secret rejection, the four distinct
diagnostics, and committed-schema validation. A nested per-run `skipped` value
remains a truthful non-success observation; it is never a top-level success.
