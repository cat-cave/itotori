/** @type {Array<object>} */
export const FIXTURE_NODES = [
  // ---- Non-RealLive fixture-needs audit (§1.6) -----------------------------
  {
    id: "capability_kaifuu_200",
    title: "MV/MZ public-licensed real-game fixture intake (profile A)",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_108"],
    summary:
      "Import one freely-redistributable RPG Maker MV/MZ project (profile A: plain `data/*.json` with `Show Text` + `Show Choices` in at least one `Map*.json`, populated `CommonEvents.json`, populated `System.json` terms) into `fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a/`, capture license SPDX, and emit a manifest matching the existing fixture-policy schema.",
    deliverables: [
      "`fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a/` directory containing the imported project's `data/*.json` plus a top-level `LICENSE` mirroring the source's verbatim license text.",
      "`fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a.manifest.json` declaring SPDX id, source URL, extraction-surface counts (`Show Text`, `Show Choices`, `CommonEvent` commands, `System.terms` fields), and SHA-256 hashes per file.",
      "Generator script `fixtures/generate-kaifuu-rpgmaker-mv-mz-profile-a.mjs` deterministically regenerating the manifest from the directory.",
      "Regression test `crates/kaifuu-core/tests/rpgmaker_profile_a.rs` asserting the manifest counts match.",
    ],
    acceptanceCriteria: [
      "`fixtures/public/kaifuu-rpgmaker-mv-mz-profile-a.manifest.json` exists with SPDX id present verbatim and `extractionSurfaces.showText >= 5`, `extractionSurfaces.showChoices >= 1`.",
      "`pnpm node fixtures/generate-kaifuu-rpgmaker-mv-mz-profile-a.mjs` regenerates the manifest with identical bytes (deterministic).",
      "`cargo test -p kaifuu-core --test rpgmaker_profile_a` passes deterministically.",
      "Each file under the fixture dir has a SHA-256 row in the manifest that matches `sha256sum` output.",
    ],
    verification: [
      {
        type: "command",
        value:
          "direnv exec . pnpm node fixtures/generate-kaifuu-rpgmaker-mv-mz-profile-a.mjs --check",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test rpgmaker_profile_a",
      },
    ],
    auditFocus: [
      "License capture must be verbatim and SPDX id must be on the OSI/SPDX approved list.",
      "Fixture file count must not include any non-`data/*.json` body that the source's license does not explicitly cover.",
      "Manifest hashes must match the on-disk bytes deterministically across machines.",
    ],
  },
  {
    id: "capability_kaifuu_201",
    title: "MV/MZ private-local owned-game readiness lane",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_036"],
    summary:
      "Wrap an owned RPG Maker MV/MZ project under `fixtures/private-local/` (path-only, body never vendored), produce a redacted readiness summary surface (counts, hashes, suffix histogram, helper requirements) emitted by a new `kaifuu rpg-maker readiness-report` subcommand. The report surface must never contain project filenames or key bytes.",
    deliverables: [
      "New `kaifuu rpg-maker readiness-report --game <PATH>` CLI subcommand in `crates/kaifuu-cli/src/main.rs` that consumes a path under `fixtures/private-local/`.",
      "`MvMzReadinessReport` schema in `crates/kaifuu-core/src/lib.rs` carrying `assetSuffixHistogram`, `systemJsonHasEncryptionKey`, `mapTextSurfaceCounts`, `helperRequirements`, and aggregate SHA-256 of `data/*.json`.",
      "Redaction regression test `crates/kaifuu-cli/tests/mvmz_readiness_redaction.rs` asserting no project filename or key byte appears in the report JSON.",
      "Manifest entry under `fixtures/private-local/README.md` documenting the contract (path lane only; bodies never committed).",
    ],
    acceptanceCriteria: [
      "`kaifuu rpg-maker readiness-report --game fixtures/private-local/<id>` emits JSON whose top-level keys are exactly `{spec, assetSuffixHistogram, systemJsonHasEncryptionKey, mapTextSurfaceCounts, helperRequirements, aggregateDataHashSha256}`.",
      "The redaction regression test asserts the emitted JSON does not contain any project filename, full path, or `System.json.encryptionKey` byte string.",
      "`encryptionKey` presence is reported as boolean only; never as the literal value.",
      "`cargo test -p kaifuu-cli --test mvmz_readiness_redaction` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-cli --test mvmz_readiness_redaction",
      },
      {
        type: "command",
        value: "direnv exec . cargo build -p kaifuu-cli",
      },
    ],
    auditFocus: [
      "Redaction test must run on synthetic-but-realistic private-local fixture seeded by the test.",
      "Report must not leak hashes that would let an attacker fingerprint the owned project (only aggregate hash is exported).",
      "Path lane contract documented in fixtures/private-local/README.md must match the CLI's expectations.",
    ],
  },
  {
    id: "capability_kaifuu_202",
    title: "MV/MZ encrypted-asset real-bytes decrypt smoke",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_115", "capability_kaifuu_116", "capability_kaifuu_200"],
    summary:
      "Run capability_kaifuu_115 (image decrypt) and capability_kaifuu_116 (audio decrypt) against profile B's fixture and assert a byte-equal round-trip against the author-provided plaintext. Composes the existing decrypt nodes with the new capability_kaifuu_200 fixture intake.",
    deliverables: [
      "Regression test `crates/kaifuu-core/tests/mvmz_encrypted_roundtrip.rs` that decrypts and re-encrypts at least one `.rpgmvp`/`.png_` and one `.rpgmvo`/`.m4a_` using the `capability_kaifuu_115`/`capability_kaifuu_116` APIs against fixture bytes vendored under `fixtures/public/kaifuu-rpgmaker-mv-mz-profile-b/`.",
      "Profile-B fixture intake under `fixtures/public/kaifuu-rpgmaker-mv-mz-profile-b/` with manifest declaring SPDX id and author-provided plaintexts for byte-equal assertions.",
      "Smoke command `kaifuu rpg-maker encrypted-smoke --fixture <id>` printing per-asset PASS/FAIL.",
      "Updated `docs/kaifuu-fixture-policy.md` cross-reference for profile B.",
    ],
    acceptanceCriteria: [
      "`cargo test -p kaifuu-core --test mvmz_encrypted_roundtrip` asserts `decrypt(encrypted_bytes) == plaintext_bytes` and `encrypt(plaintext_bytes) == encrypted_bytes` for >=1 image and >=1 audio asset.",
      "`kaifuu rpg-maker encrypted-smoke --fixture kaifuu-rpgmaker-mv-mz-profile-b` exits 0 with all per-asset rows PASS.",
      "Profile-B manifest declares SPDX id verbatim and includes SHA-256 for every encrypted and plaintext asset.",
      "Regression test runs deterministically across two consecutive invocations.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test mvmz_encrypted_roundtrip",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p kaifuu-cli -- rpg-maker encrypted-smoke --fixture kaifuu-rpgmaker-mv-mz-profile-b",
      },
    ],
    auditFocus: [
      "Encryption key handling must consume `System.json.encryptionKey` from the fixture, not an inline literal.",
      "Round-trip must be byte-equal in both directions; partial decryptions must fail loud.",
      "Profile-B license must explicitly permit re-encryption derivatives.",
    ],
  },
  {
    id: "capability_utsushi_179",
    title: "utsushi-rpgmaker-mv-mz crate scaffold + facade conformance",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["capability_utsushi_120"],
    summary:
      "Create the `utsushi-rpgmaker-mv-mz` crate (pure-Rust, MIT/Apache-2.0) wiring an `RpgMakerMvMzEnginePort` through the substrate facade conformance manifest and emitting a clean-room attestation for the browser/NW.js path. Zero opcode handlers — analogous to the proposed `146a` shape in alpha-scope-honesty.md §C.3. Depends on the capability_utsushi_120 substrate facade.",
    deliverables: [
      "`crates/utsushi-rpgmaker-mv-mz/` crate scaffold (`cargo new --lib`) with `forbid(unsafe_code)` and `deny(missing_debug_implementations)`.",
      "Crate-level doc declaring clean-room boundary; no MV/MZ source reading.",
      "`EnginePortAdapter` impl stub returning `Unimplemented` for every lifecycle stage.",
      "Conformance manifest registration entry for `utsushi.rpgmaker.mv_mz`.",
      "License + dependency-tree CI gate (license MIT-OR-Apache-2.0; no GPL transitive deps).",
    ],
    acceptanceCriteria: [
      '`crates/utsushi-rpgmaker-mv-mz/Cargo.toml` exists with `license = "MIT OR Apache-2.0"`, depends only on `utsushi-core` via `utsushi_core::substrate::*`.',
      "`cargo test -p utsushi-rpgmaker-mv-mz scaffold` exercises the `ConformanceManifest` registration and reports `Unimplemented` for every lifecycle stage.",
      "Crate-level doc contains the clean-room boundary statement verbatim, identical wording to `utsushi-reallive`.",
      "No `Show Text` / `Show Choices` opcode handler exists in the crate (grep for `handler` returns only the `Unimplemented` stubs).",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-rpgmaker-mv-mz scaffold",
      },
      {
        type: "command",
        value: "direnv exec . cargo doc -p utsushi-rpgmaker-mv-mz --no-deps",
      },
    ],
    auditFocus: [
      "Source-tree leakage from any MV/MZ engine source (must be zero opcode handlers).",
      "Facade bypass via direct `utsushi_core::vfs::*` import (forbidden).",
      "Placeholder `Ok(())` returns hiding unimplemented stages (forbidden).",
    ],
  },
  {
    id: "capability_utsushi_180",
    title: "MV/MZ browser launch fixture replay emits E1 trace",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: [
      "capability_utsushi_179",
      "capability_utsushi_031",
      "capability_utsushi_032",
      "capability_utsushi_033",
      "capability_kaifuu_200",
    ],
    summary:
      "Drive the Chromium browser launch contract against capability_kaifuu_200's fixture and emit an E1 trace recording text + choice events. The trace must contain at least one `Show Text` event id matching the capability_kaifuu_109 bridge unit id from the same fixture.",
    deliverables: [
      "New `utsushi run --adapter utsushi-rpgmaker-mv-mz --fixture kaifuu-rpgmaker-mv-mz-profile-a` driver in `crates/utsushi-cli/src/main.rs`.",
      "E1 trace writer wired through the substrate facade emitting `text_event`, `choice_event`, and `engine_family` rows.",
      "Regression test `crates/utsushi-rpgmaker-mv-mz/tests/browser_replay_e1.rs` asserting trace contains >= 1 `text_event` matching a known capability_kaifuu_109 bridge unit id.",
      "Snapshot fixture under `crates/utsushi-rpgmaker-mv-mz/tests/fixtures/profile-a-e1-trace.json` for byte-deterministic comparison.",
    ],
    acceptanceCriteria: [
      "`cargo test -p utsushi-rpgmaker-mv-mz --test browser_replay_e1` asserts the emitted trace JSON contains >= 1 `text_event.bridge_unit_id` matching a `capability_kaifuu_109` bridge unit id from `capability_kaifuu_200`'s fixture manifest.",
      'Emitted trace JSON declares `engine_family == "rpg_maker_mv_mz"` and `runtime == "browser-chromium"`.',
      "Snapshot fixture compares byte-equal across two consecutive runs (no timestamp / pid fields).",
      "`utsushi run --adapter utsushi-rpgmaker-mv-mz --fixture kaifuu-rpgmaker-mv-mz-profile-a` exits 0.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-rpgmaker-mv-mz --test browser_replay_e1",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p utsushi-cli -- run --adapter utsushi-rpgmaker-mv-mz --fixture kaifuu-rpgmaker-mv-mz-profile-a --output /tmp/itotori-probes/utsushi-mvmz.json",
      },
    ],
    auditFocus: [
      "Bridge unit id linkage must be a stable contract between `kaifuu-rpgmaker-mv-mz` extraction and the browser replay.",
      "Trace metadata fields must be stable across runtime variants (browser vs nwjs).",
      "Snapshot fixture must be byte-deterministic; CI runs from multiple platforms.",
    ],
  },
  {
    id: "capability_kaifuu_203",
    title: "Public synthetic KAG `.ks` corpus (CC0)",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_009"],
    summary:
      "Hand-author a CC0 KAG `.ks` corpus under `fixtures/public/kaifuu-kag-synthetic-corpus/` covering dialogue, choices, labels, jumps, variables, comments, and the profile-B tag inventory (`[r]`, `[l]`, `[p]`, `[cm]`, `[ct]`, `[wait]`, `[jump]`, `[call]`, `[return]`, `[if]`, `[endif]`, `[macro]`, `[endmacro]`, `[eval]`, `[image]`, `[playbgm]`). Drives capability_kaifuu_009 against author-independent author-CC0 bytes.",
    deliverables: [
      "`fixtures/public/kaifuu-kag-synthetic-corpus/` directory with >= 6 `.ks` files covering >= 6 distinct KAG tags from the profile-B inventory.",
      "`fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json` declaring `SPDX-License-Identifier: CC0-1.0`, per-file SHA-256, per-file tag inventory.",
      "Generator script `fixtures/generate-kaifuu-kag-synthetic-corpus.mjs` regenerating the manifest deterministically.",
      "Regression test `crates/kaifuu-core/tests/kag_corpus_manifest.rs` asserting manifest invariants.",
    ],
    acceptanceCriteria: [
      'Manifest declares `"SPDX-License-Identifier": "CC0-1.0"` verbatim.',
      "`tagInventory` across all files in the manifest contains >= 6 distinct KAG tag names from the profile-B inventory.",
      "`pnpm node fixtures/generate-kaifuu-kag-synthetic-corpus.mjs --check` succeeds with deterministic byte-equal regeneration.",
      "`cargo test -p kaifuu-core --test kag_corpus_manifest` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . pnpm node fixtures/generate-kaifuu-kag-synthetic-corpus.mjs --check",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test kag_corpus_manifest",
      },
    ],
    auditFocus: [
      "Author-CC0 declaration must be explicit per-file (header comment) and at the manifest level.",
      "Tag inventory must be deterministic; generator script must not record file-modification times.",
      "Corpus must include at least one label/jump pair so capability_kaifuu_009 can exercise control flow.",
    ],
  },
  {
    id: "capability_kaifuu_204",
    title: "Public licensed real-game plain-XP3 fixture intake",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_097", "capability_kaifuu_203"],
    summary:
      "Import one freely-redistributable plain (non-encrypted) XP3 archive (profile A: plain `XP3` magic, raw or zlib index encoding, >=1 `scenario/*.ks` inside) under `fixtures/public/kaifuu-xp3-plain-profile-a/`. Emit a redaction-aware manifest declaring SPDX id, `xp3-archive` row, and a `kag-scenario` row whose tag inventory intersects capability_kaifuu_203's CC0 corpus above a documented coverage ratio.",
    deliverables: [
      "`fixtures/public/kaifuu-xp3-plain-profile-a/` directory with the imported `*.xp3` (or a minimal sliced copy if the source's license permits derivative slicing).",
      "`fixtures/public/kaifuu-xp3-plain-profile-a.manifest.json` declaring SPDX id, source URL, archive SHA-256, `read_plain_xp3_inventory` entry count, KAG tag inventory, and the intersection ratio against capability_kaifuu_203.",
      "Generator script `fixtures/generate-kaifuu-xp3-plain-profile-a.mjs` regenerating the manifest.",
      "Regression test `crates/kaifuu-core/tests/xp3_profile_a.rs` asserting `read_plain_xp3_inventory` returns 0 errors and the manifest counts match.",
    ],
    acceptanceCriteria: [
      "`read_plain_xp3_inventory(<fixture>)` returns an `Ok(PlainXp3Inventory)` with `entries.len() >= 3` and zero `PlainXp3InventoryError` results.",
      "Manifest declares SPDX id verbatim and `tagInventoryIntersectionRatioAgainstKaifuu203 >= 0.5` (or a documented lower ratio with justification in the manifest).",
      "`pnpm node fixtures/generate-kaifuu-xp3-plain-profile-a.mjs --check` regenerates the manifest with identical bytes.",
      "`cargo test -p kaifuu-core --test xp3_profile_a` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . pnpm node fixtures/generate-kaifuu-xp3-plain-profile-a.mjs --check",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test xp3_profile_a",
      },
    ],
    auditFocus: [
      "License capture verbatim and SPDX id on the OSI/SPDX approved list.",
      "If the source license forbids derivative slicing, the fixture must vendor the original `*.xp3` byte-for-byte.",
      "Intersection ratio against capability_kaifuu_203 must be computed from the manifest at fixture-generation time, never from runtime KAG parsing.",
    ],
  },
  {
    id: "capability_kaifuu_205",
    title: "Plain XP3 real-bytes round-trip smoke",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_098", "capability_kaifuu_204"],
    summary:
      "Compose capability_kaifuu_098's deterministic XP3 writer with capability_kaifuu_097's reader against capability_kaifuu_204's plain-XP3 fixture and assert a byte-equal round-trip. Surfaces a `kaifuu xp3 smoke --fixture <id>` CLI subcommand.",
    deliverables: [
      "Wired `kaifuu xp3 smoke --fixture <id>` subcommand in `crates/kaifuu-cli/src/main.rs` reading the named fixture and round-tripping it through `read_plain_xp3_inventory` + capability_kaifuu_098 writer.",
      "Regression test `crates/kaifuu-core/tests/xp3_real_bytes_roundtrip.rs` asserting `repack(read(fixture)) == fixture` byte-for-byte.",
      "Per-entry adler32 + path + size assertion harness used by the round-trip test.",
      "Documentation update in `docs/kaifuu-fixture-policy.md` linking capability_kaifuu_204 and capability_kaifuu_205.",
    ],
    acceptanceCriteria: [
      "`cargo test -p kaifuu-core --test xp3_real_bytes_roundtrip` asserts `repack(read(fixture)) == fixture` byte-for-byte for the capability_kaifuu_204 fixture.",
      "`kaifuu xp3 smoke --fixture kaifuu-xp3-plain-profile-a` exits 0 and prints per-entry PASS rows.",
      "Per-entry adler32 from the recomputed archive equals the manifest-declared value for every declared entry.",
      "Per-entry path and `compressed` flag preserved across round-trip.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core --test xp3_real_bytes_roundtrip",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p kaifuu-cli -- xp3 smoke --fixture kaifuu-xp3-plain-profile-a",
      },
    ],
    auditFocus: [
      "Round-trip must include both raw and zlib index encodings if the fixture mixes them.",
      "adler32 recomputation must match the manifest exactly; mismatches must fail loud.",
      "Smoke command must not depend on capability_kaifuu_009 (KAG parsing) — pure container round-trip.",
    ],
  },
  {
    id: "capability_kaifuu_206",
    title: "Private-local KAG/XP3 owned-game readiness lane",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "engine-adapters",
    dependsOn: ["capability_kaifuu_036"],
    summary:
      "Wrap an owned KiriKiri/KAG game under `fixtures/private-local/` (path-only, body never vendored) and produce a redacted readiness summary via a new `kaifuu xp3 readiness-report` subcommand. The report surface must never contain filenames, KAG body bytes, or key material.",
    deliverables: [
      "New `kaifuu xp3 readiness-report --game <PATH>` CLI subcommand in `crates/kaifuu-cli/src/main.rs`.",
      "`XpThreeKagReadinessReport` schema in `crates/kaifuu-core/src/lib.rs` carrying `xp3VariantHistogram`, `kagTagHistogram`, `archiveCount`, `kagScenarioCount`, and aggregate SHA-256 of `.ks` bodies (not per-file).",
      "Redaction regression test `crates/kaifuu-cli/tests/xp3_readiness_redaction.rs` asserting no filename, KAG body, or key material appears in the report JSON.",
      "Manifest entry under `fixtures/private-local/README.md` documenting the contract.",
    ],
    acceptanceCriteria: [
      "`kaifuu xp3 readiness-report --game fixtures/private-local/<id>` emits JSON whose top-level keys are exactly `{spec, xp3VariantHistogram, kagTagHistogram, archiveCount, kagScenarioCount, aggregateKagBodyHashSha256}`.",
      "Redaction regression test asserts the emitted JSON does not contain any filename, KAG body byte string, or encrypted-XP3 key material.",
      "Encrypted vs plain-XP3 split is reported as histogram bucket counts, not as per-file rows.",
      "`cargo test -p kaifuu-cli --test xp3_readiness_redaction` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-cli --test xp3_readiness_redaction",
      },
      {
        type: "command",
        value: "direnv exec . cargo build -p kaifuu-cli",
      },
    ],
    auditFocus: [
      "Redaction test must run on synthetic-but-realistic private-local fixture seeded by the test.",
      "Aggregate hash must not reveal per-file structure.",
      "Path lane contract documented in fixtures/private-local/README.md must match the CLI's expectations.",
    ],
  },
  {
    id: "capability_utsushi_181",
    title: "utsushi-kirikiri-xp3 crate scaffold + facade conformance",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: ["capability_utsushi_120"],
    summary:
      "Create the `utsushi-kirikiri-xp3` crate (pure-Rust, MIT/Apache-2.0) wiring a `KirikiriXp3EnginePort` through the substrate facade conformance manifest; clean-room attestation for the KAG plaintext path. Zero opcode handlers. Depends on the capability_utsushi_120 substrate facade.",
    deliverables: [
      "`crates/utsushi-kirikiri-xp3/` crate scaffold (`cargo new --lib`) with `forbid(unsafe_code)` and `deny(missing_debug_implementations)`.",
      "Crate-level doc declaring clean-room boundary; no KiriKiri / KiriKiri Z source reading.",
      "`EnginePortAdapter` impl stub returning `Unimplemented` for every lifecycle stage.",
      "Conformance manifest registration entry for `utsushi.kirikiri.xp3`.",
      "License + dependency-tree CI gate (license MIT-OR-Apache-2.0; no GPL transitive deps).",
    ],
    acceptanceCriteria: [
      '`crates/utsushi-kirikiri-xp3/Cargo.toml` exists with `license = "MIT OR Apache-2.0"`, depends only on `utsushi-core` via `utsushi_core::substrate::*`.',
      "`cargo test -p utsushi-kirikiri-xp3 scaffold` exercises the `ConformanceManifest` registration and reports `Unimplemented` for every lifecycle stage.",
      "Crate-level doc contains the clean-room boundary statement verbatim, identical wording to `utsushi-reallive`.",
      "No KAG opcode handler exists in the crate (grep for `handler` returns only the `Unimplemented` stubs).",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-kirikiri-xp3 scaffold",
      },
      {
        type: "command",
        value: "direnv exec . cargo doc -p utsushi-kirikiri-xp3 --no-deps",
      },
    ],
    auditFocus: [
      "Source-tree leakage from any KiriKiri / TJS engine source (must be zero opcode handlers).",
      "Facade bypass via direct `utsushi_core::vfs::*` import (forbidden).",
      "Placeholder `Ok(())` returns hiding unimplemented stages (forbidden).",
    ],
  },
  {
    id: "capability_utsushi_182",
    title: "KAG plaintext fixture replay emits E0/E1 trace",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["utsushi"],
    parallelGroup: "runtime-adapters",
    dependsOn: [
      "capability_utsushi_181",
      "capability_utsushi_037",
      "capability_utsushi_038",
      "capability_kaifuu_009",
      "capability_kaifuu_203",
    ],
    summary:
      "Drive capability_utsushi_037 (KAG plaintext parser replay) and capability_utsushi_038 (macro + storage subset) against capability_kaifuu_203's CC0 synthetic corpus and emit an E0/E1 trace of text + jump events. The trace must contain at least one `text_event` id and at least one `label_jump_event` id matching capability_kaifuu_009 bridge unit ids.",
    deliverables: [
      "New `utsushi run --adapter utsushi-kirikiri-xp3 --fixture kaifuu-kag-synthetic-corpus` driver in `crates/utsushi-cli/src/main.rs`.",
      "E0/E1 trace writer emitting `text_event`, `label_jump_event`, and `engine_family` rows.",
      "Regression test `crates/utsushi-kirikiri-xp3/tests/kag_replay_e0_e1.rs` asserting the trace contains >=1 `text_event` and >=1 `label_jump_event` matching capability_kaifuu_009 bridge unit ids.",
      "Snapshot fixture under `crates/utsushi-kirikiri-xp3/tests/fixtures/kag-corpus-e0-e1-trace.json` for byte-deterministic comparison.",
    ],
    acceptanceCriteria: [
      "`cargo test -p utsushi-kirikiri-xp3 --test kag_replay_e0_e1` asserts emitted trace JSON contains >=1 `text_event.bridge_unit_id` and >=1 `label_jump_event.bridge_unit_id` matching `capability_kaifuu_009` bridge unit ids from capability_kaifuu_203's corpus manifest.",
      'Emitted trace JSON declares `engine_family == "kirikiri_xp3"` and `runtime == "kag-plaintext-interpreter"`.',
      "Snapshot fixture compares byte-equal across two consecutive runs (no timestamp / pid fields).",
      "`utsushi run --adapter utsushi-kirikiri-xp3 --fixture kaifuu-kag-synthetic-corpus` exits 0.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo test -p utsushi-kirikiri-xp3 --test kag_replay_e0_e1",
      },
      {
        type: "command",
        value:
          "direnv exec . cargo run -p utsushi-cli -- run --adapter utsushi-kirikiri-xp3 --fixture kaifuu-kag-synthetic-corpus --output /tmp/itotori-probes/utsushi-kag.json",
      },
    ],
    auditFocus: [
      "Bridge unit id linkage must be a stable contract between `capability_kaifuu_009` extraction and the KAG replay.",
      "Trace metadata fields must be stable across runtime variants.",
      "Snapshot fixture must be byte-deterministic.",
    ],
  },
];
