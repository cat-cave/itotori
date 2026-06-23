# Kaifuu Engine Adapter Development Playbook

KAIFUU-020 defines the repeatable workflow for adding engine adapters with
parallel coding agents. This playbook is the operational entry point for an
adapter worker. It complements:

- [kaifuu-fixture-policy.md](kaifuu-fixture-policy.md) for fixture provenance,
  readiness records, reference review, public/private corpus boundaries, and
  semantic capability errors.
- [kaifuu-key-discovery.md](kaifuu-key-discovery.md) for key profiles, helper
  classes, encrypted corpus handling, and redaction rules.
- [kaifuu-patch-safety.md](kaifuu-patch-safety.md) for encoding, path,
  rollback, and atomic output rules.
- [testing-standard.md](testing-standard.md) for adapter tests and fixture
  round-trips.
- [worktree-lifecycle.md](worktree-lifecycle.md) for agent branch and worktree
  ownership.
- [subprojects-kaifuu.md](subprojects-kaifuu.md) for the current fixture
  adapter CLI surface.

The current public implementation is the fixture adapter. A real engine adapter
must not claim production support for protected, encrypted, packed, compiled,
or platform-assisted variants unless the readiness record, public fixtures,
tests, helper boundaries, and semantic errors prove that exact scope.

## Start Gates

An implementation agent may start adapter code only after these gates are true:

1. The roadmap node, branch, and worktree are owned by the worker that is making
   the change. Use the canonical lifecycle in
   [worktree-lifecycle.md](worktree-lifecycle.md); do not work from chat memory
   or an unclaimed branch.
2. A tracked adapter readiness record exists or is added in the first slice. Use
   the template below. The record may live in the adapter README, a future
   `docs/kaifuu-adapters/<engine>.md`, or another tracked document.
3. At least one public round-trip fixture is named in the readiness record. A
   private corpus can guide research, but it cannot unlock implementation or CI
   acceptance by itself.
4. Fixture sources and reference implementations have license decisions recorded
   before code, tables, generated data, or test oracles are ported.
5. The initial support boundary is narrow enough to test. Unsupported encrypted,
   packed, compiled, obfuscated, platform-only, key-required, or helper-required
   variants must return semantic capability errors.
6. The planned adapter fits the current Kaifuu boundary: pure detection,
   profile generation, asset listing, extraction, patching, and verification
   through `EngineAdapter`. Key discovery, Wine, Windows, and remote helper
   orchestration stay outside the pure adapter.

## Branch And Worktree Steps

For primary spec work, follow the lifecycle commands rather than inventing a
branch name:

```sh
just roadmap-ready
node scripts/spec-dag.mjs show <NODE-ID>
node scripts/spec-dag.mjs worktree <NODE-ID> --json
node scripts/spec-dag.mjs worktree <NODE-ID> --apply
node scripts/spec-dag.mjs claim <NODE-ID> --owner "<OWNER>" --json
node scripts/spec-dag.mjs claim <NODE-ID> --owner "<OWNER>" --apply
node scripts/spec-dag.mjs validate
git diff --check
git add roadmap/spec-dag.json
git commit -m "chore(roadmap): claim <NODE-ID>"
# Push the claim branch or merge this claim commit per the coordination workflow.
```

Do not start implementation, planning, or delegation until the claim has been
validated and committed, then published or merged as durable DAG ownership. If
the claim cannot be made durable, return the node to `planned` before further
work.

For parallel adapter workers, use disjoint worker branches and worktrees as
defined in [worktree-lifecycle.md](worktree-lifecycle.md). Before editing, check
the branch and dirty state from inside the assigned worktree. If unrelated
changes are present, leave them alone and keep the adapter slice scoped to the
claimed files.

## Readiness Record

The readiness record is durable context for future workers and reviewers. It is
not a marketing claim. It states the exact variants that can be implemented,
tested, and audited.

Use this template:

```md
# <Engine> Adapter Readiness Record

- Roadmap node:
- Owner:
- Adapter id:
- Crate or module:
- Engine family:
- Supported versions and variants:
- Explicitly excluded versions and variants:
- Initial support boundary:
- Unsupported or gated boundary:
- Public fixture ids:
- Public fixture source class:
- Fixture generation or source URL:
- Fixture license and attribution:
- Raw fixture file hashes:
- Positive fixture coverage:
- Negative fixture coverage:
- Required round-trip artifacts:
- Byte-identical or normalized equivalence rule:
- Supported encodings and newline rules:
- Text surfaces:
- Patch modes:
- Asset inventory surfaces:
- Semantic capability errors:
- Reference implementations and docs:
- License review decisions:
- Parser spike status:
- Private corpus labels and aggregate stats:
- Key profile requirements:
- Helper requirements:
- Remote helper status:
- Local validation commands:
- CI validation commands:
- Known gaps and proposed P2/P3 follow-ups:
```

Minimum content before adapter code starts:

- Engine family, supported versions, excluded versions, and support boundary.
- One public fixture id with source class, license, generation/source URL, and
  committed raw-file SHA-256 hashes.
- Positive and negative fixture expectations, including unsupported variants.
- Reference citations with license decisions.
- Required round-trip commands and artifacts.
- Semantic capability errors for every recognized unsupported boundary.
- Private corpus notes limited to redacted labels, aggregate stats, and local
  manifest hashes.

## Fixture Manifest Expectations

Public fixtures are the only fixtures allowed in public CI. They must be
synthetic, public domain, permissively licensed, or otherwise explicitly
redistributable, and their manifests must satisfy
`fixtures/public/manifest.schema.json`.

Every adapter PR that adds or changes support must include:

- A public fixture manifest with fixture id, source class, provenance, license
  evidence, byte lengths, and SHA-256 hashes.
- A positive fixture covering representative dialogue, choices, speaker/name
  context, UI or database text when relevant, engine markup, and protected
  spans.
- Expected extraction or golden bridge artifacts with schema versions, source
  hashes, stable unit ids, patch references, and protected spans.
- Unchanged patch input and an expected verification result.
- Translated patch input and expected patched output in a temp output directory.
- At least one negative fixture or detector case for unsupported encrypted,
  compiled, packed, obfuscated, unknown, or missing-key variants.
- Public test keys only when the archive, plaintext template, key, and
  generation script are all safe to redistribute and marked fixture-only.

Private corpora stay under `fixtures/private-local/` and remain ignored by git.
Tracked records may cite only redacted labels, aggregate stats, manifest hashes,
hash-list hashes, helper versions, proof hashes, and readiness status. Do not
commit or print raw private strings, story filenames, screenshots, local paths,
keys, decrypted scripts, memory dumps, or helper logs.

## Parser Spike Policy

Parser spikes are allowed when the format is uncertain, but they do not create
support claims.

Rules for spikes:

- Start with public format docs and public fixtures whenever possible.
- Use private-local inputs only for local observations, and record only
  redacted aggregate notes.
- Keep spike code small and removable until fixture provenance, license review,
  and support boundaries are clear.
- Do not paste, mechanically translate, or generate code from uncleared
  references.
- Do not copy lookup tables, opcode maps, signatures, keys, or bytes without an
  explicit compatible license decision.
- Produce a tracked spike outcome: format observations, fixture needs, parser
  risks, unsupported variants, and the first round-trip test plan.
- Move from spike to implementation only after the readiness record names at
  least one public round-trip fixture and the initial negative cases.

Initial implementation should usually add deterministic detection and profile
generation first, then extraction, then patching, then verification. Patch
writers come after the parser can prove stable unit identity, protected spans,
source hashes, and asset references on public fixtures.

## Reference And License Review

Every consulted reference needs a review before porting starts. Record the
upstream owner, URL, release or commit, relevant file or section, retrieval
date, SPDX id or license text path, attribution duties, and decision:
`allowed`, `allowed-with-attribution`, `behavior-only-clean-room`,
`private-local-only`, or `blocked`.

If terms are missing, incompatible, non-commercial, no-derivatives, GPL for an
incompatible target, or otherwise unclear, keep implementation behavior-only.
One worker may write high-level format observations and fixture expectations;
the implementer must not copy expression from the reference.

## Adapter Boundary

New adapters plug into the same architecture as the fixture adapter:

- Implement `EngineAdapter` methods for id, name, capabilities, detection,
  profile generation, asset listing, asset inventory, extraction, patching, and
  verification.
- Register the adapter through the existing Kaifuu CLI registry path before
  relying on CLI commands.
- Emit `CapabilityReport` entries that match the readiness record. Limited,
  unsupported, and user-input capabilities need clear limitations.
- Keep detection deterministic. `detect` should report evidence and
  requirements, not LLM-style confidence.
- Keep pure adapters portable. They may consume resolved key profiles and
  archive parameters, but they do not run Windows hooks, Wine helpers, remote
  commands, community key services, or executable bypasses.
- Asset inventory is not a patching claim. OCR, redraw, metadata rewrite, font
  substitution, video editing, archive rebuilds, and binary relocation remain
  unsupported unless tested and documented for the exact fixture profile.

## Semantic Error Code Rules

Unsupported capabilities must fail with structured semantic errors instead of
panics, raw I/O errors, silent skips, or corrupted partial output.

Use the standard capability codes from
[kaifuu-fixture-policy.md](kaifuu-fixture-policy.md#semantic-capability-errors)
for encrypted, packed, compiled, obfuscated, missing-key, helper, key
validation, protected-executable, unsupported-surface, and unknown-variant
cases. Adapter-local validation failures may use stable adapter-specific codes,
but support boundary and key/helper failures must use the shared `kaifuu.*`
codes.

Each adapter failure should include, when safely known:

- `errorCode`
- `engine`
- `adapter`
- `detectedVariant`
- `assetRef`
- `requiredCapability`
- `supportBoundary`
- `remediation`

Rules:

- Error codes are stable API strings. Do not include file paths, versions,
  hashes, or user data in the code.
- A recognized unsupported variant must be reported as unsupported, missing
  capability, missing key material, helper unavailable, validation failed, or
  unknown variant according to the shared table.
- Patching must fail before writing output when a required source asset is an
  unsupported encrypted, compiled, packed, obfuscated, or unknown variant.
- Partial capability reports are allowed during detection and extraction only
  when no files are modified.
- If a result omits secret-bearing details by design, record
  `kaifuu.secret_redacted` in the structured report rather than printing the
  hidden data.

## Key And Helper Boundaries

Key discovery is a helper workflow; extraction and patching are pure adapter
work.

Adapters may:

- Detect that a key profile is required.
- Validate that a supplied profile has the required shape.
- Consume resolved keys, archive parameters, and compression options passed
  through the agreed profile boundary.
- Return semantic errors when keys, profiles, helpers, or validation proofs are
  missing or invalid.

Adapters must not:

- Store raw key bytes in profiles, bridge bundles, logs, fixtures, reports, or
  CI artifacts.
- Depend on Wine, Windows, remote hosts, executable hooks, or community key
  databases for normal pure adapter tests.
- Dump helper logs, process memory, decrypted scripts, raw retail filenames, or
  absolute paths.
- Claim protected-engine production support from private-only helper evidence.
- Shell out to existing extraction or runtime tools (GARbro, KrkrExtract,
  SiglusExtract, UberWolf, WolfDec, RPG-Maker-MV-Decrypter, BGIKit,
  VNTranslationTools, etc.) at runtime. Even when a similar piece of logic
  already exists in one of those tools, that code is consulted as research
  only; the Kaifuu adapter implements the logic in pure Rust. The native crate
  is the support boundary — not a wrapper around a third-party binary.

## Per-game evidence-first helper determination

Helper infrastructure is not pre-spec'd speculatively. Before any
dynamic-key-discovery helper (Wine wrapper, VM-passthrough adapter, mem-scan
probe, remote Windows transport, etc.) is added for a claimed game, the worker
must first demonstrate that the in-process static-Rust extraction path is
genuinely insufficient for that specific game's protected variant.

The default for every claimed game is _no helper needed_. The rule is:

- If pure-Rust static parsing of the game's files and shipped executable yields
  the keys/profile needed to extract → decrypt → decompile → patch → verify →
  delta-apply, ship that. The adapter is complete; no helper class beyond
  `static-parser` is involved.
- If static parsing genuinely cannot recover what is needed for a specific
  claimed game's protected variant, record that evidence in the readiness
  record (what was tried, what was observed, why it is insufficient). Only
  then does the bounded helper boundary (`KAIFUU-064`) come into play, and
  only then is the appropriate per-channel adapter (Wine wrapper, local
  Windows process, remote host, etc.) added — scoped to that game's actual
  need.
- A speculative "we might need a mem-scan probe for this engine someday" is
  not a reason to add helper infrastructure. The engine may have several
  claimed games where static parsing is sufficient and one where it is not;
  the helper appears at the point where that one game proves it.

This rule applies even when a similar logic path exists in GARbro,
KrkrExtract, SiglusExtract, UberWolf, WolfDec, RPG-Maker-MV-Decrypter, BGIKit,
VNTranslationTools, or any other existing tool. Those tools are consulted as
research references; their code informs the Rust port. The Kaifuu adapter
implements the logic itself in pure Rust and never invokes the reference tool
as a binary at runtime.

## Remote Windows And Wine Helper Protocol Sketch

Remote Windows and Wine helpers are optional helper classes for local,
owned-corpus workflows. They are not part of a pure adapter and must be disabled
or absent without breaking public CI.

Safe defaults:

- Local execution first. Wine helpers run on the same machine when practical.
- Remote helper servers bind to loopback by default. Local-network access
  requires explicit configuration, and non-local network access requires an
  explicit owner-approved transport, authentication, and threat model.
- The helper accepts fixed operations such as `fingerprint`,
  `key-profile-proof`, and `archive-triage`; it must not accept arbitrary shell
  commands.
- Inputs and outputs are schema-validated JSON. Raw game files are not sent over
  the protocol by default; the Windows host should reference a locally
  configured corpus label or local profile id.
- Responses are redacted before persistence. They include hashes, byte counts,
  detected classes, helper versions, and proof hashes, not raw keys, decrypted
  text, memory dumps, raw logs, screenshots, absolute paths, or story-bearing
  filenames.
- Failures use deterministic semantic codes such as
  `kaifuu.helper_unavailable`, `kaifuu.key_validation_failed`,
  `kaifuu.helper_authorization_denied`,
  `kaifuu.protected_executable_unsupported`,
  `kaifuu.unsupported_variant.encrypted`, and `kaifuu.secret_redacted`.
  Authorization-disabled or policy-denied helper requests must fail with the
  denied code rather than falling back to a generic helper failure.
- Timeouts, helper versions, allowlisted operations, and redaction status are
  included in every result.

Example request shape:

```json
{
  "schemaVersion": "0.1.0",
  "requestId": "uuid7",
  "operation": "key-profile-proof",
  "engine": "siglus",
  "detectedVariant": "scene-pck-gameexe-dat",
  "corpusRef": "private-local:siglus-example",
  "inputManifestHash": "sha256:...",
  "requestedCapabilities": ["key_profile"],
  "redactionPolicy": "kaifuu-helper-redaction-v1",
  "clientVersion": "kaifuu-key-helper-client/0.1.0"
}
```

Example response shape:

```json
{
  "schemaVersion": "0.1.0",
  "requestId": "uuid7",
  "status": "passed",
  "errorCode": null,
  "engine": "siglus",
  "detectedVariant": "scene-pck-gameexe-dat",
  "helperKind": "remote-windows",
  "helperVersion": "kaifuu-key-helper/0.1.0",
  "keyProfile": {
    "profileId": "uuid7",
    "secretRefs": ["local-secret:siglus/example/secondary-key"],
    "validationProofHash": "sha256:..."
  },
  "evidence": {
    "redactedLogHash": "sha256:...",
    "inputManifestHash": "sha256:...",
    "proofMethod": "decrypt-header-proof"
  },
  "redactions": ["raw_key", "absolute_path", "helper_log"],
  "warnings": []
}
```

If a helper is unavailable, blocked by platform protection, or cannot redact
its output, the adapter-facing result is a semantic failure. The pure adapter
then reports the missing capability or missing key profile and stops before
writing output.

## Round-Trip Test Requirements

Every adapter PR needs a fixture and round-trip test checklist. At minimum,
tests should prove:

- Detection reports the adapter id, engine family, detected variant, evidence,
  requirements, and capabilities for the public fixture.
- `archiveDetection` rows report aggregate archive/encryption evidence and
  semantic diagnostics without claiming extraction, decryption, patching, or
  archive rebuild support.
- Detection report `gameDir` output is redacted so private-local absolute paths
  and game titles do not appear in command artifacts.
- Profile generation validates and records assets, text surfaces, capabilities,
  requirements, source hashes, and support boundary metadata.
- Extraction emits a shared bridge bundle with stable unit ids, source hashes,
  source unit keys, patch refs, speaker/name context, surfaces, and protected
  spans.
- An unchanged patch round-trip preserves byte identity or the readiness
  record's explicit normalized equivalence rule.
- A translated patch round-trip writes into a temp output directory, verifies,
  and preserves protected spans and source identity.
- Negative fixtures return semantic errors for unsupported encrypted, compiled,
  packed, obfuscated, unknown, missing-key, helper-unavailable, encoding, stale
  hash, duplicate key, path traversal, and protected-span cases as applicable.
- Asset inventory reports visible non-text surfaces without implying patch
  support.
- Public CI passes without private corpora, Wine, Windows, live network calls,
  live provider calls, or helper services.

Use the shared CLI shape for manual fixture loops:

```sh
cargo run -p kaifuu-cli -- detect <fixture> --output .tmp/<adapter>/detect.json
cargo run -p kaifuu-cli -- profile init <fixture> --output .tmp/<adapter>/profile.json
cargo run -p kaifuu-cli -- asset-inventory <fixture> --output .tmp/<adapter>/asset-inventory.json
cargo run -p kaifuu-cli -- extract <fixture> --output .tmp/<adapter>/bridge.json
cargo run -p kaifuu-cli -- golden <fixture> \
  --translated-patch .tmp/<adapter>/patch-export.translated.json \
  --translated-source-bridge .tmp/<adapter>/bridge.json \
  --work-dir .tmp/<adapter>/golden-work \
  --output .tmp/<adapter>/round-trip.json
cargo run -p kaifuu-cli -- patch <fixture> --patch .tmp/<adapter>/patch-export.json --output .tmp/<adapter>/patched
cargo run -p kaifuu-cli -- verify .tmp/<adapter>/patched --output .tmp/<adapter>/verify.json
```

Adapter-local tests should use temp directories and public fixtures. They must
not write back into `fixtures/public/` or a source game directory.

## Patch Safety Requirements

Before claiming patch support, the adapter must satisfy the relevant rules in
[kaifuu-patch-safety.md](kaifuu-patch-safety.md):

- Detect and preserve asset encodings, byte budgets, terminators, offset
  tables, protected spans, and newline conventions.
- Reject translations that cannot be encoded in the same documented encoding
  variant unless a tested rebuild path exists.
- Validate the full patch plan before the first write.
- Use temp output directories for tests and same-directory atomic writes or a
  documented multi-file staging and rollback plan.
- Reject path traversal, absolute paths, drive prefixes, NUL bytes, and unsafe
  archive paths before joining with an output root.
- Fail the entire patch on stale hashes, duplicate entries, missing entries, or
  unsupported multi-entry behavior. Silent partial success is forbidden.

## Local Validation Commands

For documentation-only adapter planning changes, run:

```sh
node scripts/spec-dag.mjs validate
pnpm exec vp check
git diff --check
just roadmap-ready
```

For adapter code or fixture changes, add the focused commands that protect the
behavior:

```sh
just fixtures-validate
cargo fmt --check
cargo test -p kaifuu-core -p kaifuu-cli -p <adapter-crate>
cargo run -p kaifuu-cli -- golden <fixture> \
  --translated-patch .tmp/<adapter>/patch-export.translated.json \
  --translated-source-bridge .tmp/<adapter>/bridge.json \
  --work-dir .tmp/<adapter>/golden-work \
  --output .tmp/<adapter>/round-trip.json
```

Use `just ci-kaifuu` or the full `just check` when the change touches shared
Kaifuu behavior, fixture validation, CLI registry code, or public contracts.
Record skipped commands with the reason.

## Adapter PR Checklist

- [ ] Roadmap node, branch, and worktree match
      [worktree-lifecycle.md](worktree-lifecycle.md).
- [ ] Readiness record is tracked and complete enough for the initial support
      boundary.
- [ ] Public fixture manifest validates and includes provenance, license,
      hashes, byte lengths, and fixture role.
- [ ] Positive fixture covers the claimed text surfaces and engine markup.
- [ ] Negative fixture or detector case covers unsupported variants.
- [ ] Private corpus notes are redacted and public CI does not depend on them.
- [ ] Reference implementation citations and license decisions are recorded.
- [ ] Parser spike outcome is recorded or marked not needed.
- [ ] Adapter capabilities match the readiness record and do not overclaim.
- [ ] Semantic `kaifuu.*` capability errors cover unsupported, key, helper,
      protected-executable, and unknown-variant cases.
- [ ] Key profiles use secret refs only; no raw key material is committed or
      printed.
- [ ] Remote Windows or Wine helper use is optional, redacted, structured, and
      outside the pure adapter.
- [ ] Extraction, unchanged round-trip, translated round-trip, verification,
      and negative tests exist for the public fixture.
- [ ] Patch safety requirements for encoding, path traversal, rollback, and
      partial writes are tested or explicitly unsupported.
- [ ] Local validation commands and outputs are recorded in the PR summary.
- [ ] P2/P3 follow-ups are proposed for production encrypted support, binary
      patching, runtime validation, unavailable public fixtures, or broad asset
      patching that is outside the current slice.

## Audit Checklist

Auditors should reject or send back an adapter PR when:

- A new agent could not identify the support boundary, fixtures, commands,
  references, or known gaps from tracked files alone.
- The PR depends on private corpora, helper logs, raw keys, retail assets, or
  chat context for acceptance.
- Remote execution is assumed to be safe without local-network defaults,
  explicit configuration, structured redaction, deterministic errors, and a
  no-arbitrary-command boundary.
- The adapter claims encrypted, packed, compiled, protected, binary patching,
  OCR, asset text, runtime VM, or broad Unity-style support without fixture
  evidence and tests for that exact variant.
- Unsupported variants panic, silently skip, corrupt output, leak raw I/O
  errors, or write partial patched files instead of returning semantic errors.
- Round-trip tests omit unchanged patching, translated patching, verification,
  protected spans, stale hashes, encoding failures, path traversal, or the
  readiness record's equivalence rule.
- Reference code or data was copied without a compatible license decision and
  attribution plan.
