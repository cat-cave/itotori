# Kaifuu Siglus Pure Extraction + Patching Adapter (KAIFUU-022)

The **pure Siglus adapter**
([`crates/kaifuu-siglus/src/adapter.rs`](../crates/kaifuu-siglus/src/adapter.rs))
EXTRACTS and PATCHES profiled `Scene.pck` / `Gameexe.dat` variants and OWNS the
filesystem write for patch-back — while performing **no key discovery**. It is
the KAIFUU-022 successor to the [`KAIFUU-070`](../crates/kaifuu-siglus/src/known_key_smoke.rs)
known-key smoke: the smoke resolves its own (synthetic) key internally; the
adapter is _handed_ an already-resolved key and re-validates it before use.

## The key-discovery boundary (the whole point)

The adapter **consumes** a `ResolvedSiglusKey`: a structured `secretRef`, the
`KeyValidationProof` the discovery layer (the
[`KAIFUU-069`](../crates/kaifuu-cli/tests/siglus_static_key.rs) static-key
discovery / secret store) published, and the raw key material. It does **not**
scan executables, recover keys, or contact helpers.

- **Validate-before-consume.** `ResolvedSiglusKey::consume` recomputes a one-way
  `sha256` commitment over the material and requires it to equal the supplied
  proof (`knownPlaintextProof`). A method it cannot re-check
  (`keyProofMethodUnsupported`) or a hash that does not match
  (`keyProofMismatch`) refuses the key **before any operation runs**.
- **Redaction discipline.** The raw key lives only inside the crate-private,
  zeroize-on-drop, `Debug`-redacting holder. It is never serialized, logged, or
  written. Reports carry the `secretRef` + a one-way `keyMaterialHash` + the key
  byte length + the consumed proof — never the bytes.

## What it proves (on profiled fixtures)

All operations run against profiled `Scene` / `Gameexe` containers:

- **Extract** text units / config entries with the resolved key.
- **Identity round-trip** — re-emit an unedited container **byte-identical** to
  the input (`identity.byteIdentical`, `inputHash == reemittedHash`).
- **Translated round-trip** — each edited unit/value decodes to the new text
  (**in-scope correct**) AND every non-edited record survives byte-for-byte
  (**out-of-scope byte-identical**), proven at record granularity.
- **Patch + verify to disk** via `patch_container_file` with a strict
  **reject-before-write** ordering: capability gate → read → identity + verify →
  reject-on-secret deep scan → atomic write. Any failure returns `Err` with **no
  output file written**.
- **Reject-on-secret** — before any write, the output bytes + the redacted
  report are deep-scanned; a raw key window or decrypted-plaintext substring
  (UTF-8 or UTF-16LE) fails loud (`secretLeak`).

## Capability boundary (honest scope)

- `broadSiglusSupport = false`, `doesKeyDiscovery = false`,
  `consumesResolvedKey = true`, `shellsOut = false`.
- The profiled format is the narrow **constant-key-XOR, UTF-16LE,
  uncompressed-within-profile** container. It is **not** the real Siglus
  constant-256-XOR-table + per-game second-layer strip, and **not** the
  proprietary-LZSS codec — those remain the `siglus-04` / `siglus-06` skeleton
  stubs. Out-of-profile compression / magic is a typed **capability error**
  (`unsupportedVariant`), never a silent pass.
- A failure **inside** the declared profile (an in-profile verify mismatch,
  header drift, or record reorder) is surfaced as `verifyFailed` and is a
  **bug / compat-regression**, not a feature request.

## Multi-game validation + the real-bytes gap

Per the multi-game rule, the round-trip suite
([`crates/kaifuu-siglus/tests/siglus_adapter_roundtrip.rs`](../crates/kaifuu-siglus/tests/siglus_adapter_roundtrip.rs))
validates **two** distinct profiled "games" (`gameA`, `gameB` — different keys,
scene ids, unit/entry counts).

**Real-bytes gap (filed honestly):** as of this node there are **no real Siglus
`Scene.pck` / `Gameexe.dat` bytes** in `/archive/vault` or `/scratch` to test
against (the owned Siglus titles — e.g. karetoshi / gamekoi — are copy-protected
DVD images, unrealizable under the no-Wine / no-shell-out laws; the only
`Gameexe.*` files present are RealLive `.ini` fixtures from the `rlvm` oracle,
not Siglus). Validation is therefore on **profiled synthetic fixtures**
materialised in-process with clearly-fake keys and text — no retail bytes,
signatures, or keys are committed. When a plaintext/realized Siglus tree lands
(the blocked-external `siglus-01` / `siglus-06` recon+realization nodes), the
real `Scene.pck` reader + constant-256-XOR + proprietary-LZSS stack replace the
core-stack skeleton, and this adapter's identity / translated / reject-on-secret
proofs re-run against those real bytes unchanged.
