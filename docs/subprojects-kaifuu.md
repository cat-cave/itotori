# Kaifuu Subproject

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
variants. Matrix rows use aggregate evidence fields and semantic diagnostics;
they do not claim extraction, decryption, decompilation, patching, image
replacement, or archive rebuild support. Detection output does not include LLM-style confidence, local
absolute `gameDir` paths, or private game titles. RPG Maker encrypted asset
detection counts both MV-style `.rpgmvp`/`.rpgmvm`/`.rpgmvo` files and MZ-style
`.png_`/`.m4a_`/`.ogg_` files. Marker-only subtype evidence without a primary
archive/container match is reported as unknown-variant aggregate evidence
instead of family-specific key requirements.

`profile init` writes stable JSON profiles. The legacy `profile <game-dir>` form
is compatibility-only and delegates to the same validation, redaction, and atomic
write gate. Profiles include assets, capability reports, and explicit
requirements for files, platform constraints, and secret keys. Secret
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
