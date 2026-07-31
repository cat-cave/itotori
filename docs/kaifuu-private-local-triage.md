# Kaifuu Private-Local Encrypted Corpus Triage

`the relevant capability` makes encrypted owned-game corpus triage a **first-class local
workflow** that produces **safe aggregate readiness evidence** while remaining
**absent from public/per-gate CI**. It lets a local operator record encrypted
corpora as redacted manifests, scan them, and emit only redacted aggregate
readiness JSON that can be cited publicly by aggregate/hash metadata.

This complements [`docs/kaifuu-encrypted-engine-research.md`](kaifuu-encrypted-engine-research.md),
the private-local policy in [`docs/fixtures-and-corpora.md`](fixtures-and-corpora.md),
and the readiness vocabulary in [`docs/kaifuu-engine-playbook.md`](kaifuu-engine-playbook.md).

## Copyright / strict-proof law

- The triage **never** reads raw keys, raw encrypted bytes, decrypted text, or
  retail assets. Its only input is the redacted manifest JSON an operator
  writes. It does **not** shell out and does **not** read corpus contents.
- Every value that reaches an emitted artifact is scanned for secrets (absolute
  local paths, raw key/hex material, `local-secret:` refs, PEM key blocks). A
  leak throws **before** anything is written — the workflow never redacts
  silently and never emits a leaking artifact.
- Output is byte-deterministic (sorted keys, no timestamps, no absolute paths),
  so the committed README-safe report is stable.

## Command

```sh
# Explicitly exercise the content-free absent-input failure (exit nonzero).
pnpm exec vp run kaifuu:private-local-triage -- --no-corpus

# Triage a single operator manifest.
pnpm exec vp run kaifuu:private-local-triage -- \
  --manifest fixtures/private-local/<corpus-id>/private-triage-manifest.local.json

# Scan a directory of private-local corpora (root manifest + one manifest per
# immediate corpus subdirectory).
pnpm exec vp run kaifuu:private-local-triage -- --corpus-dir fixtures/private-local
```

Flags: `--no-corpus`, `--manifest <path>`, `--corpus-dir <dir>`,
`--root <dir>` (private-local root to probe, default `fixtures/private-local`),
`--out <path>` (output override).

When neither `--manifest` nor `--corpus-dir` is given, the command probes the
private-local root. A missing root, empty directory, empty manifest selection,
zero-byte manifest, non-file manifest, missing option value, or explicit
`--no-corpus` request emits only a typed content-free diagnostic, writes no
evidence artifact, and exits nonzero.

Source: [`suite/scripts/kaifuu-private-local-triage/`](../suite/scripts/kaifuu-private-local-triage).

## Not wired into CI

The triage command is a private-local-only workflow. It is intentionally **not**
selected by any per-gate CI lane: `just check`/`ci` never invoke it, and neither
`scripts/affected.mjs` nor the CI workflows reference
`kaifuu:private-local-triage`. Public CI therefore never selects private work.
The hermetic test (`kaifuu:private-local-triage-test`) uses mock manifests and
absent-input cases and needs no private inputs.

## Private-local manifest conventions

An operator records encrypted corpora in a manifest under
`fixtures/private-local/<corpus-id>/private-triage-manifest.local.json` (git
ignored). It is authored **already redacted** — it holds only logical ids,
helper classes, proof **hashes**, detector results, aggregate counts, readiness
bins, and redacted command lines. Schema:
[`manifest.schema.json`](../suite/scripts/kaifuu-private-local-triage/manifest.schema.json).

Per-corpus entry fields:

| Field                  | Meaning                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `corpusId`             | Lowercase logical id (`[a-z0-9._-]`, no paths, no retail filenames).                                    |
| `engine`               | One of `rpg-maker-mv`, `rpg-maker-mz`, `kirikiri-xp3`, `siglus`, `wolf`, `rgss3-vx-ace`.                |
| `readinessBin`         | One of `ready`, `helper_required`, `key_missing`, `unsupported_variant`, `detector_unknown`, `blocked`. |
| `keyProfileIdRedacted` | Redacted key-profile logical id, or `null`.                                                             |
| `helperClass`          | One of `staticParser`, `runtimeHelper`, `patchDatabase`, `executableAnalysis`, `none`.                  |
| `helperVersion`        | Helper tool version string, or `null`.                                                                  |
| `helperAvailable`      | Whether the helper is locally available.                                                                |
| `proofHashes`          | `sha256:<64 hex>` key-validation / decrypt proof hashes.                                                |
| `detectorResults`      | Redacted detector result labels.                                                                        |
| `counts`               | `{ assets, encryptedAssets, textUnits, archives }` non-negative integers.                               |
| `commandLines`         | Redacted local command lines (paths replaced with placeholders).                                        |

README-safe example input:
[`examples/private-triage-manifest.local.example.json`](../suite/scripts/kaifuu-private-local-triage/examples/private-triage-manifest.local.example.json).

## Aggregate readiness report

The command aggregates validated entries into a safe report. Schema:
[`readiness-report.schema.json`](../suite/scripts/kaifuu-private-local-triage/readiness-report.schema.json).
Top-level fields: `schemaVersion`, `status` (`ok`), `reason`,
`command` (canonical redacted command string), `generatedBy`, `aggregateCounts`
(`corpora`, `entries`, `assets`, `encryptedAssets`, `textUnits`, `archives`),
`engineReadinessBins` (per-engine bin counts covering MV/MZ/XP3/Siglus/Wolf/RGSS3),
and `entries` (redacted per-corpus rows). README-safe example:
[`examples/aggregate-readiness-report.example.json`](../suite/scripts/kaifuu-private-local-triage/examples/aggregate-readiness-report.example.json).

## Missing input is a typed failure

Absent or invalid selection never produces a report. The command emits a stable
JSON diagnostic containing only its task, failure class, generic reason code,
and `effectOutcome: "no-effects"`, then exits nonzero. It never includes the
private path, filename, rejected value, parser message, or manifest content.

## What a report may / must not contain

Reports may be cited publicly by corpus label, redacted key-profile ids, helper
classes, proof hashes, detector results, aggregate counts, per-engine readiness
bins, and redacted command lines. They must never contain raw key material,
decrypted text, raw helper logs, retail filenames that reveal story content,
local absolute paths, or storefront/account identifiers. The secret scanner
enforces this at emit time.
