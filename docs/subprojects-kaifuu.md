# Kaifuu Subproject

Alpha readiness gates live at the top of
[`project-readiness.md`](project-readiness.md). Alpha-ready means the
architecture-proven dogfood point (substrate extensions, a non-synthetic
engine port crate, a real-bytes smoke, recorded-LLM bundle, dashboard
reachability, repo hygiene) — **not** the full claimed-support chain
(detect, extract, decrypt, decompile, patch, verify, delta-apply). The
"claimed-support" definition below is Kaifuu's long-term commitment for every
engine variant the suite eventually promotes; it remains the bar for promotion
out of readiness-tier, not the bar for the first dogfood pass.

Kaifuu owns engine detection, inventory, readiness, extraction, patching,
verification, and `.kaifuu` delta packages.

**Operating commitments.** Three rules govern every Kaifuu adapter, regardless
of engine family:

- _No shell-outs._ Kaifuu never invokes existing extraction tools (GARbro,
  KrkrExtract, SiglusExtract, UberWolf, WolfDec, RPG-Maker-MV-Decrypter, BGIKit,
  VNTranslationTools, etc.) as binaries at runtime. Their logic is ported into
  native Rust crates. Existing tools may be cited as research references in
  documentation; the code never depends on them.
- _End-to-end for claimed engines._ An engine variant enters claimed-support
  only when detect, extract, decrypt (if needed), decompile, patch, verify, and
  delta-apply all work on real owned inputs. Anything less is research-tier.
- _Cross-OS._ Kaifuu runs natively on Linux, macOS, and Windows. Platform-
  specific helper channels (Wine wrappers, VM passthrough, etc.) are device-
  specific implementations of a cross-OS trait — never baked into the core
  extraction or patching paths.

The scaffold implements fixture extraction and patch support, plus real-engine
detection/readiness slices. Real-engine extraction, key validation, decryption,
and patch-back support are tracked per engine profile; a detector match is not
an extraction or patching claim. RPG Maker MV/MZ encrypted suffix detection and
fixture-key validation have shipped as readiness slices, while MV/MZ encrypted
media decrypt/re-encrypt and broader media localization remain planned follow-up
work. The current priority is not "plaintext first"; it is a layered access
pipeline where plaintext is the identity/null-key special case.

Text access is modeled per text-bearing surface:

```txt
locate surface -> unpack container -> decrypt -> decode/decompile -> normalized text -> patch back
```

Each stage can be identity, supported, helper-gated, key-gated, research-only,
or unsupported. Adapter capability reports must distinguish `identify`,
`inventory`, `extract`, and `patch`, so a recognized packed or encrypted engine
is never presented as usable by default.

Patch writers, delta application, and future engine adapters must follow
[kaifuu-patch-safety.md](kaifuu-patch-safety.md) for encoding,
normalization, atomic output, path traversal, rollback, and partial-write
safety rules.
New engine adapter workers should start from
[kaifuu-engine-playbook.md](kaifuu-engine-playbook.md), which defines the
readiness record, fixture and round-trip test gates, semantic error rules, and
remote helper boundaries.

## Fixture Adapter CLI

The current CLI resolves game-backed commands through the adapter registry. The fixture adapter handles `fixtures/hello-game` today, and future engine adapters should plug into the same registry path instead of adding command-specific fixture logic.

Machine-readable adapter capability output is available with:

```sh
cargo run -p kaifuu-cli -- capabilities --output .tmp/kaifuu-capabilities.json
```

Asset inventory manifests report engine-neutral non-text surfaces declared by
the adapter, including image text, UI textures, song metadata, fonts, credits,
and video surfaces. A reported surface is not a patching claim: adapters must
mark OCR, redraw, metadata rewrite, font substitution, and video editing as
unsupported unless that support actually exists.

```sh
cargo run -p kaifuu-cli -- asset-inventory fixtures/hello-game --output .tmp/hello-world/asset-inventory.json
```

Fixture extraction and patch commands preserve the hello-world file contract:

```sh
cargo run -p kaifuu-cli -- detect fixtures/hello-game --output .tmp/kaifuu-detect.json
cargo run -p kaifuu-cli -- profile init fixtures/hello-game --output .tmp/kaifuu-profile.json
cargo run -p kaifuu-cli -- profile validate .tmp/kaifuu-profile.json --output .tmp/kaifuu-profile-validation.json
cargo run -p kaifuu-cli -- extract fixtures/hello-game --output .tmp/hello-world/bridge.json
cargo run -p kaifuu-cli -- patch fixtures/hello-game --patch .tmp/hello-world/patch-export.json --output .tmp/hello-world/patched-game
cargo run -p kaifuu-cli -- verify .tmp/hello-world/patched-game --output .tmp/hello-world/kaifuu-verify.json
```

`detect` emits a deterministic detection report for every registered adapter and
an `archiveDetection` matrix from `kaifuu-core`. Adapter evidence reports
matched or missing manifest files and returns `unknown` instead of failing when
no adapter matches. Top-level `status` is adapter status only; archive-only
unsupported inputs keep `status: "unknown"` while `archiveDetection.status`
reports the archive/encryption match. The archive matrix covers KiriKiri/XP3,
Siglus, RPG Maker MV/MZ encrypted assets, Wolf RPG Editor archives,
BGI/Ethornell containers, Ren'Py packed inputs, and unknown archive-like
variants. **Matrix rows use aggregate evidence fields and semantic diagnostics;
they do not claim extraction, decryption, decompilation, patching, image
replacement, or archive rebuild support** — the detection matrix is a
triage surface only, and a matrix match for a row like `wolf-rpg-editor-archives`
or `bgi-ethornell-containers` is NEVER an adapter support claim. Detection
output does not include LLM-style confidence, local absolute `gameDir` paths,
or private game titles. RPG Maker encrypted asset detection counts both
MV-style `.rpgmvp`/`.rpgmvm`/`.rpgmvo` files and MZ-style `.png_`/`.m4a_`/`.ogg_`
files. Marker-only subtype evidence without a primary archive/container match
is reported as unknown-variant aggregate evidence instead of family-specific
key requirements.

### Adapter support claims beyond the detection matrix

The no-patching / no-extraction / no-rebuild scope above applies to the
detection matrix only. **Engine-specific adapters** that prove extract + patch
document their claims on each adapter's own readiness record, not on the
matrix.

**Shipped adapters with proven extract/patch surfaces** (see each readiness
record):

- **KiriKiri KAG `.ks` plaintext adapter** (`kaifuu-kirikiri`) — null-container
  plaintext only; see [`kaifuu-adapters/kirikiri-kag.md`](kaifuu-adapters/kirikiri-kag.md).
- **TyranoScript `.ks` adapter** (`kaifuu-tyrano`) — null-key/null-container
  layered-pipeline claim at the `patch` level; see
  [`kaifuu-adapters/tyranoscript.md`](kaifuu-adapters/tyranoscript.md).
- **RealLive adapter** (`kaifuu-reallive`) — semantic decompiler on real-bytes
  corpus with length-changing patch-back; see
  [`kaifuu-adapters/reallive.md`](kaifuu-adapters/reallive.md).

**Synthetic readiness ladders only (no real-bytes coverage, no dedicated
crate):**

- **Wolf RPG Editor** — synthetic extract/patch/repack ladder over the
  encrypted-archive substrate in `kaifuu-core` (key via local SecretRef, never
  emitted). Detection-matrix row ≠ adapter support claim.
- **BGI/Ethornell** — synthetic readiness ladder (detector + bytecode parser
  smoke) in `kaifuu-core`. Detection-matrix row ≠ adapter support claim.

The matrix's "no extraction / patching / rebuild" sentence above is the
honest scope of the **detection matrix rows only**; it does NOT mean Kaifuu
cannot extract or patch any engine — it means a matched row is never, by
itself, a support claim. Each adapter's readiness record is the source of
truth for what that specific engine supports; capability ids for shipped
adapters (`kaifuu.reallive`, `kaifuu.tyranoscript`, `kaifuu.kirikiri-kag`,
etc.) are what downstream ingestion keys on.

`profile init` writes stable JSON profiles. The legacy `profile <game-dir>` form
is compatibility-only (emits a stderr warning; prefer `profile init`) and
delegates to the same validation, redaction, and atomic write gate. Profiles
include assets, capability reports, and explicit requirements for files,
platform constraints, and secret keys.

### Partial extract / profile / verify (KAIFUU-193)

`extract`, `profile`, and `verify` no longer fail closed with `"no registered
adapter detected"` when an adapter reports `detected == false` but accumulated
nonzero `EvidenceStatus::Matched` rows. They take a partial path that emits a
`PartialAdapterReport` JSON envelope (`schemaVersion: "0.1.0"`) summarising
what bytes WERE recovered, which adapter refusals fired, and at which
severity.

```json
{
  "schemaVersion": "0.1.0",
  "adapterId": "kaifuu.reallive",
  "detected": false,
  "partial": true,
  "detectedVariant": "unknown-reallive-named-files",
  "command": "extract",
  "evidence": [
    /* same DetectionEvidence rows as `detect` */
  ],
  "diagnostics": [
    {
      "code": "kaifuu.reallive.partial.gameexe_key_catalogue_mismatch",
      "severity": "P2",
      "message": "Gameexe.ini key catalogue mismatch: ...",
      "assetRef": "Gameexe.ini"
    }
  ],
  "severityCounts": { "p0": 0, "p1": 0, "p2": 1, "p3": 0 },
  "inventory": {
    "entries": 3,
    "sources": ["REALLIVEDATA/SEEN.TXT"],
    "sourceBundleHash": "..."
  }
}
```

The `partial == true` and `detected == false` fields are always serialized so
downstream ingestion (`apply` / `verify` / the dashboard) can distinguish a
partial run from a complete one without inferring it from missing keys. The
diagnostic severity routes the `verify` exit code: P0/P1 are blocking (verify
exits 1), P2/P3 are informational (verify exits 0 even with diagnostics
attached). `apply` MUST refuse to ingest any envelope whose `partial` field
is `true`.

For the RealLive adapter, the partial extractor parses `REALLIVEDATA/Seen.txt`
through `kaifuu_reallive::parse_archive` directly, counts populated scene-index
entries, classifies Gameexe.ini key-catalogue mismatch as P2, and surfaces
SEEN.TXT envelope failures (truncation, malformed directory) as P0. Adapter
families without an engine-specific partial extractor emit a generic envelope
carrying the recovered evidence plus a single P2 diagnostic noting the missing
partial path. The regression test
(`crates/kaifuu-cli/tests/partial_extract.rs`) covers extract, profile, and
both verify exit-code paths against a synthetic SEEN.TXT envelope that mirrors
a RealLive `parse_archive` success + Gameexe.ini key mismatch.

Secret
requirements use placeholders only; actual secret values must stay out of
profile files. The fixture engine marks decryption keys as `not_required`, so
missing-key handling does not block unencrypted games.
Key-bearing profiles use top-level `sourceFingerprint`, `keyRequirements`, `archiveParameters`, and `helperEvidence` fields. Required keys are referenced only through local `secretRef` ids, while adapter capability output may declare `keyRequirements` for encrypted variants without coupling pure extraction or patching to helper execution.
Encrypted game support is not deferred wholesale: local-only key profiles,
helper boundaries, detector diagnostics, redaction policy, and the first
encrypted-profile extract/patch/verify vertical are tracked in
[kaifuu-key-discovery.md](kaifuu-key-discovery.md). Broad production support for
every protected commercial variant remains scoped per adapter, but failures
inside a declared support profile are compatibility bugs, not feature requests.

## Patch result v0.2

Patch result v0.2 reports every patch outcome via a structured record. Every
failure carries six fields together — asset id, bridge unit id, adapter id,
semantic command, diagnostic code, and human-readable cause — so downstream
ingestion can never silently lose context. Failures classify into one of six
categories: `source_incompatible`, `patch_write_failed`, `protected_span_violation`,
`asset_missing`, `adapter_unsupported`, and `output_hash_mismatch`. Engine
adapters map their own internal error codes (e.g. RealLive `PatchBackError`)
onto this category enum and a verbatim `diagnosticCode`.

For successful runs the report carries a deterministic `outputHash` that is the
rollup of the per-asset hashes in `touchedAssets`. The rollup is computed as
`sha256(sorted(touchedAssets, by assetId).map(a => `${a.assetId}\n${a.outputHash}\n`).join(""))`
using UTF-8 and LF line endings. Per-asset hashes use byte-deterministic input;
no locale-formatted strings appear in the hash payload so the rollup is stable
across operating systems.

Partial-write reports must carry a `partialWrite.disposition` of `rolled_back`,
`cleaned_up`, or `retained_partial`. `retained_partial` is the explicit trap-
door for adapters that physically cannot roll back; Itotori ingestion treats
that disposition as a P0 finding requirement. Disjointness of the
`writtenAssetIds` and `skippedAssetIds` sets, fully covering
`attemptedAssetIds`, is enforced on both TS and Rust sides.

### Patch transaction harness (KAIFUU-084)

Engine adapters write patched bytes through the
`kaifuu_core::patch_transaction::PatchTransaction` harness. The harness runs a
fixed five-check preflight before any byte hits disk, then drives a
stage → verify → promote pipeline with deterministic rollback. The five
preflight checks fire in a single pass (every blocker is reported, not just
the first):

1. Transform support — every entry in the caller's `required_transforms` list
   must appear under `AdapterCapabilities.access_contract.patch` as a
   supported surface, container, crypto, codec, or patch-back transform.
2. Byte budget — the caller's `expected_payload_len` must not exceed
   `byte_budget`.
3. Source bytes — the existing file at `output_path` is read and its sha256
   must equal `expected_source_hash`. Missing files surface as
   `asset_missing`; drift surfaces as `source_incompatible`.
4. Identity relocation — the harness enforces length-preservation:
   `expected_payload_len` must equal the on-disk source length. Non-identity
   relocation is rejected as `adapter_unsupported`; engines that need
   length-changing patches must layer offset-table rewriting on top before
   calling the harness.
5. Output-hash format — `expected_output_hash` must match
   `^sha256:[0-9a-f]{64}$`.

Staged writes live at `<output_dir>/.staging/<asset_id>-<run_id>.tmp` and use
`O_CREAT | O_EXCL` so two concurrent runs with the same run id cannot corrupt
each other (the second one fails fast with `staged_collision`). Verify
re-reads the staged bytes and re-hashes them; mismatch deletes the staging
file and leaves `output_path` untouched. Promote performs an atomic
`fs::rename` of the staged file over `output_path` — on POSIX this is atomic
within the same filesystem (the staging directory is a sibling under
`output_path.parent()`, so cross-filesystem moves are impossible by
construction). A rename failure rolls back by deleting the staging file; the
original output file is untouched because rename only swaps on success.

Every harness outcome — success, preflight failure, verify failure, promote
failure, and cancellation — emits a v0.2 PatchResult JSON via
`PatchTransactionOutcome.patch_result_v02`. In debug builds the harness
asserts that JSON passes `validate_patch_result_v02` before returning. Each
failure carries the six v0.2 fields (asset id, bridge unit id, adapter id,
command, diagnostic code, cause) so downstream ingestion never silently
loses context. The harness never emits `retained_partial`; pre-promote
failures use `rolled_back` and explicit cancellation uses `cleaned_up`.

The harness is engine-neutral; `crates/kaifuu-reallive/src/patchback/` is
unchanged. KAIFUU-011 is the first consumer that wires the harness into the
binary patcher CLI.
