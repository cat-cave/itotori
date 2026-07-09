# BGI / Ethornell Adapter — Readiness Record (stub)

> **Stub.** This page is a placeholder scaffold for the BGI/Ethornell adapter
> readiness record. The committed capability ladder lives in
> [`crates/kaifuu-core/src/bgi_readiness.rs`](../../crates/kaifuu-core/src/bgi_readiness.rs)
> (KAIFUU-041 — the BGI/Ethornell readiness proof that combines the
> KAIFUU-126 archive/container detector and the KAIFUU-127 scenario-bytecode
> parser into a single per-capability-level readiness report).
>
> **A `bgi-ethornell-containers` matrix match is a triage surface only — not
> an adapter support claim.** A matrix row match means "looks like Buriko
> ARC20 / BSE / DSC / CompressedBG / no-header / unknown" — it does not
> mean Kaifuu can extract or patch it. See
> [`kaifuu-detection-matrix.md`](../kaifuu-detection-matrix.md) for the
> matrix's scope.

## Identity (anchor only)

- Adapter id: `kaifuu.bgi` (engine family token: `bgi`,
  `kaifuu_core::packed_engine_readiness::EngineFamily::Bgi`).
- Source modules: `crates/kaifuu-core/src/bgi_readiness.rs` (KAIFUU-041),
  `crates/kaifuu-core/src/bgi_detector_fixture.rs` (KAIFUU-126),
  `crates/kaifuu-core/src/bgi_bytecode_fixture.rs` (KAIFUU-127).
- Roadmap node: KAIFUU-013 (BGI/Ethornell adapter — readiness ladder +
  round-trip fixtures). Detection-matrix row: KAIFUU-034
  (`bgi-ethornell-containers`).
- Engine family: BGI / Ethornell (Buriko General Interpreter — Visual Art's
  BGI engine; same lineage as RealLive and AVG32, distinct on-disk shape).

## Honest capability ladder (the readiness levels)

The readiness ladder reports FIVE achieved levels and an `unsupported`
floor; the ladder is the honest ceiling — it NEVER claims `extract` or
`patch` without an explicit synthetic-fixture round-trip proof.

- `unsupported` — the outer container variant is encrypted (BSE),
  compressed (DSC), layered (CompressedBG), header-less, or unrecognized.
  The detector reports the honest `missing_capability` boundary and the
  inner content is unreachable. The honest floor; below `identify` on
  purpose. No proof lifts it.
- `identify` — the KAIFUU-126 detector recognized the Buriko ARC20
  container; no bytecode inventory backs a higher claim.
- `inventory` — the KAIFUU-127 scenario-bytecode parser enumerated the
  string-reference surfaces (character name / dialogue / backlog / ruby /
  file) inside an extensionless scenario file. Identify + list the
  translatable surfaces, nothing more.
- `extract` — an explicit synthetic EXTRACT fixture proves member
  extraction AND the outer container gate is open.
- `patch` — an explicit synthetic PATCH fixture proves patch-back AND
  extraction is proven AND the outer container gate is open AND the
  embedded bytecode profile carries a verified extract-to-patch
  round-trip (`patch_reports` non-empty and verified).

The single source of truth is `derive_bgi_readiness_level`: a pure,
total function of the detector-derived profile, whether a bytecode profile
actually parsed a string-reference inventory, and the presence of explicit
extract/patch fixture proofs. It can NEVER lift an encrypted / compressed /
layered / unknown container above `unsupported`, and it NEVER claims
`extract` or `patch` without an explicit synthetic-fixture proof — the
strict-proof honesty invariant (no aspirational "supported").

## Unsupported / gated boundary

The matrix must NOT emit `missing_key_material` merely because BGI bytes
appear transformed. Until a concrete variant proves a key is required, the
BGI rows report an unknown variant, missing crypto capability, or
unsupported layered transform. Real BGI archive decryption / decompression
/ extraction / patch-back is later adapter work; the readiness proof
reports only what the detector + bytecode parser + explicit synthetic
fixtures prove.

## Engine-general (BGI = data, no per-game branch)

Every readiness case is pure DATA: an optional embedded detector record,
an optional embedded bytecode profile, and optional synthetic extract/patch
proofs. The resolver runs the REAL detector and REAL bytecode parser over
the embedded evidence and combines their derived outputs — there is no
per-game branch and no per-brand special case.

## Evidence is synthetic, redacted, ref-only

Cases carry NO retail bytes and NO raw key material — only synthetic ids,
the detector's structured profile signal, the bytecode parser's synthetic
Shift-JIS string surfaces, and sha256 proof hashes. Every emitted report
is funnelled through `redact_for_log_or_report` / `stable_json`.

## What this stub is honest about

- The readiness ladder (identify / inventory / extract / patch) is what the
  COMMITTED `bgi_readiness.rs` proves today; real BGI archive decryption,
  decompression, and per-file patch-back are later adapter work and are
  not promised by this node.
- A commercial-BGI on-disk shape (real `.arc` files with BSE / DSC /
  CompressedBG variants) is NOT covered by the synthetic-fixture ladder
  — the readiness proof reports what the synthetic fixtures prove, and
  the dedicated commercial adapter is a separate future node.
- This page is a placeholder scaffold so the BGI engine has a parallel
  adapter-doc surface next to the RealLive / KiriKiri / TyranoScript /
  Wolf adapter records. Future contributors should expand it with the
  same "current state / per-version variants / supported surface /
  patch modes / fixture ids / validation commands" structure as the
  Reallive / Wolf records once the commercial-BGI adapter lands.

## Local validation commands

```sh
cargo test -p kaifuu-core -- bgi_readiness
cargo test -p kaifuu-core
cargo fmt --check
cargo clippy -p kaifuu-core --all-targets -- -D warnings
just check
```

## CI validation commands

Same as local, gated by `just check` / `just ci-kaifuu`.

## Related references

- [`kaifuu-detection-matrix.md`](../kaifuu-detection-matrix.md) — the
  `bgi-ethornell-containers` row is a triage surface only.
- [`crates/kaifuu-core/src/bgi_readiness.rs`](../../crates/kaifuu-core/src/bgi_readiness.rs)
  — the KAIFUU-041 readiness proof.
- [`crates/kaifuu-core/src/bgi_detector_fixture.rs`](../../crates/kaifuu-core/src/bgi_detector_fixture.rs)
  — the KAIFUU-126 archive/container detector.
- [`crates/kaifuu-core/src/bgi_bytecode_fixture.rs`](../../crates/kaifuu-core/src/bgi_bytecode_fixture.rs)
  — the KAIFUU-127 scenario-bytecode parser.
- [`subprojects-kaifuu.md`](../subprojects-kaifuu.md) §"Adapter support
  claims beyond the detection matrix" — the BGI entry in the engine-
  adapter support list.
