# Code Criticism — Load-Bearing vs Aspirational Shells

This audit reads every claimed-complete alpha-tier capability that the user
flagged as potentially "aspirational" and distinguishes load-bearing
implementation from minimal-pass-test or honest-prototype scaffolding.
Every verdict cites `file:line` and, where the code would in principle be
exercised against real game data, runs it against real bytes from
`/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/`
("Sweetie HD") and reports the actual command output.

No DAG or source edits are made by this audit.

Verdict legend:

- **load-bearing** — real implementation that a downstream consumer can
  rely on outside of tests, or that would behave correctly against
  arbitrary real-world inputs in the named domain;
- **aspirational** — types/traits/contracts that compile but no real
  consumer depends on; the only "implementations" are inside `#[cfg(test)]`
  or fixture/conformance modules in the same crate;
- **minimal-pass-test** — implementation exists and runs, but is just deep
  enough to make the synthetic test suite green; it does not handle the
  shape of any real game's bytes/state;
- **honest-prototype** — the scope is intentionally narrow and the code,
  tests, and `lib.rs` docstrings all agree on that narrowness without
  rhetorical inflation. The reader is not misled.

Headline tally (focus nodes, this audit):

| Verdict           | Count |
| ----------------- | ----- |
| load-bearing      | 4     |
| honest-prototype  | 9     |
| minimal-pass-test | 13    |
| aspirational      | 8     |

The "32 alpha-tier" claim in the prompt under-counts: the DAG has 165
`alpha + complete` nodes, but the user's verbatim concern was the
substrate cascade, the RealLive chain, the patching pipeline, the
workflow agents, and the vault/capability surface. Those map to the 34
nodes audited below. Other alpha-complete nodes are not contract-bearing
in the same way (DAG tooling, fixture corpora, schema-version doc nodes)
and would not gain from this style of review.

---

## A. RealLive chain (KAIFUU-172/173/174/176)

### KAIFUU-172 — RealLive engine detector

- **Acceptance (one-liner)**: deterministically distinguishes RealLive
  from Siglus/AVG32 using Scene/SEEN/Gameexe.ini signatures and engine
  archive markers; pure Rust; ambiguous variants emit semantic
  diagnostics.
- **Files**: `crates/kaifuu-engine-fixture/src/lib.rs:3290-3460` (state
  machine + variant classification), `:4672-4699` (extension counts),
  `:4709-4732` (envelope check), `:4738-4770` (Gameexe key sniff).
- **Verdict**: **minimal-pass-test**.
- **Evidence**:

  Ran `direnv exec . cargo run -p kaifuu-cli -- detect "/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/" --output /tmp/itotori-criticism/sweetie-detect.json`.
  Result: `detected: false` for the `kaifuu.reallive` adapter against a
  real RealLive game. Three concrete misclassifications come from the
  detector's structural shortcuts:
  1. `crates/kaifuu-engine-fixture/src/lib.rs:4709 reallive_seen_txt_envelope_ok`
     reads `count = u32_le(bytes[0..4])` and accepts the file only when
     `count` is in `1..=131072`. Sweetie HD's `Seen.txt` has
     `00000000 00000000` at byte 0 (the real envelope is a fixed-size
     index table where the first slot is unused), so the function returns
     `false`. Output diagnostic: `"SEEN.TXT envelope is present but does
not match the synthetic fixture signature"` — but the file is a
     valid live SEEN.TXT, not a synthetic fixture.
  2. `crates/kaifuu-engine-fixture/src/lib.rs:4672 reallive_extension_counts`
     calls `fs::read_dir(dir)` (one level deep) and counts `.g00 / .ovk /
.koe / .nwk / .pdt`. Real RealLive layouts put image assets in a
     `g00/` subdirectory and voice archives in `koe/` or `bgm/`
     subdirectories. `ls REALLIVEDATA/g00/ | head` shows hundreds of
     `.g00` files, but the detector reports `"RealLive .g00 image asset
count: 0"`.
  3. Despite `#REGNAME`, `#KOE*`, `#SEEN*` matching in Gameexe.ini
     (`"Gameexe.ini RealLive keys matched: #REGNAME, #KOE*, #SEEN*"`),
     the detector still returns `detected: false` because three of the
     four positive signals are wired AND-style; only one (Gameexe.ini)
     passes.

- **Test sanity check**: tautological. `reallive_fixture_dir` at
  `crates/kaifuu-engine-fixture/src/lib.rs:6859` builds in-memory files
  whose first four bytes are precisely the synthetic magic the detector
  recognises. Example test name:
  `reallive_detection_evidence_lists_seen_txt_gameexe_ini_seen_gan_and_g00_counts`
  (`:7158`) — it asserts the detector emits the named evidence keys, not
  that it correctly classifies a non-fixture game.
- **What would actually exercise it**: pointing the CLI at real
  RealLive bytes (Sweetie HD `REALLIVEDATA/`, or any other RealLive
  release). **Has not been run**: `grep -rn "Sweetie\|sweetie\|オシオキ"
crates/ apps/itotori/src` returns zero matches.

### KAIFUU-173 — RealLive Scene/SEEN parser-boundary smoke

- **Acceptance**: one fixture-safe scene parses end-to-end; RLDEV-style
  named opcodes (not opaque byte ranges); stable string-slot ids;
  unrecognized opcodes emit semantic diagnostics rather than silent
  skips.
- **Files**: `crates/kaifuu-reallive/src/parser.rs` (348 LOC),
  `:archive.rs` (217 LOC), `:opcodes.rs` (99 LOC), `:ast.rs` (207 LOC).
- **Verdict**: **honest-prototype** (rhetoric clear), but the surface is
  much narrower than the title suggests.
- **Evidence**:

  `crates/kaifuu-reallive/src/lib.rs:62-95` documents the bytecode shape:
  opener byte `0x23 '#'`, then opcode byte, then operand-count byte,
  then operands with tag bytes `0x69 'i' / 0x73 's' / 0x6C 'l'`. **None
  of these byte values are RealLive bytecode**. Real RealLive scene
  bytecode uses different openers (typically `$` and `\x0a`-style
  command bytes) and a binary instruction stream documented in RLDEV
  separately. The 8 "RLDEV-style named opcodes" at
  `crates/kaifuu-reallive/src/opcodes.rs` (`TextDisplay=0x01`,
  `SetSpeaker=0x02`, `Choice=0x03`, `SetVar=0x04`, `Jump=0x05`,
  `Return=0x06`, `ClearScreen=0x07`, `Pause=0x08`) are **invented
  numerical values**: they are not a clean-room re-derivation of the
  documented RLDEV table — they are author-chosen opcode bytes whose
  only purpose is to disambiguate the synthetic fixture.

  This is acknowledged in `lib.rs:60-62`: "The shape is intentionally
  narrower than the real RealLive opcode space; it is a clean-room smoke
  shape suitable for the parser boundary contract." That paragraph is
  why this is **honest-prototype** and not **aspirational** — the docstring
  does not pretend to parse real RealLive. But the DAG node title
  "RealLive Scene/SEEN parser-boundary smoke proving RLDEV-style
  instruction recognition" reads as if real RealLive bytes are being
  parsed.

  Direct probe against real bytes:

  ```
  $ cd /tmp/itotori-criticism/probe-cargo && cargo run --release -- \
      "/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Seen.txt"
  file_len = 3876496
  first 16 bytes hex = 000000000000000080380100FA050000
  parse_archive OK entries=0 schema=0.1.0
  ```

  `parse_archive` returns **false success** — `Ok(SceneIndex { entries:
vec![] })` — because `count = u32_le(0..4) = 0` matches the
  "empty archive" branch at `crates/kaifuu-reallive/src/archive.rs:78-90`.
  The parser silently treats a real 3.87 MB SEEN.TXT as an empty
  archive. There is no diagnostic, no warning.

- **Test sanity check**: tautological. `tests/smoke.rs:19-97` defines
  a `synthetic` module that _writes_ bytes with `opener = 0x23`, `opcode
= 0x01`, then the test asserts the parser parses those exact bytes.
  Example: `parses_smoke_scene_001_into_structured_ast_with_named_opcodes`
  (`tests/smoke.rs`) round-trips the encoder/decoder pair. No third-party
  bytes ever reach the parser in any test.
- **What would actually exercise it**: parsing one real `SEEN.TXT` (Sweetie
  HD's 3.87 MB scene archive, or any other RealLive release). The probe
  above demonstrates it does not.

### KAIFUU-174 — RealLive AVG32-variant text inventory adapter

- **Acceptance**: inventories Scene/SEEN/Gameexe text slots, protected
  markup, asset references for AVG32-variant RealLive titles; bridge
  schema with stable ids; patch-back round-trips without corrupting
  non-text bytes; engine-generic across AVG32-variant titles.
- **Files**: `crates/kaifuu-reallive/src/inventory.rs` (473 LOC),
  `:gameexe.rs` (229 LOC), `:patchback.rs` (534 LOC),
  `:protected_spans.rs` (589 LOC), `:encoding.rs` (271 LOC).
- **Verdict**: **minimal-pass-test** for inventory and patchback;
  **honest-prototype** for the encoding/protected-spans submodules.
- **Evidence**:

  Inventory walks the AST produced by KAIFUU-173, so it inherits the
  KAIFUU-173 inability to parse real Scene/SEEN bytes. Patch-back is
  declared length-preserving only at
  `crates/kaifuu-reallive/src/patchback.rs:33` (`FixedBudget` returns
  `kaifuu.reallive.patchback_unsupported_length_policy` Fatal), which
  rules out any real Japanese-to-English translation since byte counts
  always change. The existing audit
  `roadmap/audits/AUDIT-KAIFUU-174-20260623T201439Z.json:32-49`
  acknowledges this as `KAIFUU-174-F001` ("Length-changing patch-back via
  offset-table rewrite", P3) and explicitly notes ALPHA-006 will need it.

  Gameexe.ini parser direct probe against real bytes:

      $ cd /tmp/itotori-criticism/probe-cargo && cargo run --release -- \
          "/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Gameexe.ini"
      file_len = 51800
      first 16 bytes hex = 234D454D4F52593D3030300D0A234445
      parse_gameexe_inventory: entries=1345 warnings=1328

  **1328 of 1345 keys (98.7 %)** emit `kaifuu.reallive.inventory.unknown_gameexe_key`
  warnings. The "documented user-visible / asset catalogue" at
  `crates/kaifuu-reallive/src/gameexe.rs:71-160` recognises ~10 keys
  (`#MEMORY` would even appear there if it were classified, but it
  isn't). Real RealLive Gameexe.ini has hundreds of `#KOEONOFF.*`,
  `#NAME.*`, `#SCREEN.*`, `#DEBUG_*`, `#MOD_*` keys — almost none of
  which are catalogued. The "inventory" of a real Gameexe.ini is
  therefore overwhelmingly "unknown."

- **Test sanity check**: tautological + small. `tests/inventory.rs` has
  11 tests; each calls `synthetic::single_scene_archive(...)`
  (the same encoder used by the KAIFUU-173 smoke). Example:
  `extracts_bridge_units_with_kaifuu_173_stable_slot_ids_as_source_unit_keys`
  (`tests/inventory.rs:144`) walks the synthetic AST and asserts the
  source-unit-keys round-trip. Same for `tests/patchback.rs:46-79` —
  re-uses the synthetic byte builder.
- **What would actually exercise it**: emitting a bridge unit list for
  one real RealLive game's Seen.txt + Gameexe.ini and patching one slot
  end-to-end. None of that has been attempted.

### KAIFUU-176 — itotori vault-source localCorpus adapter

- **Acceptance**: reads owned-game bytes from `/archive/vault/` exclusively;
  queries catalog.db for claimed-engine games; resolves via
  `artifacts/by-sha/<aa>/<bb>/<hash>.7z`; extracts on demand into
  `/scratch/itotori/<game-id>/<run-id>/extracted/`; cross-checks against
  embedded `_vault/metadata.json`; never modifies the vault;
  registers as a localCorpus source.
- **Files**: `crates/kaifuu-vault-source/src/{config,discovery,paths,resolution,extraction,metadata,retention,source,findings,catalog,error}.rs`
  (~3,100 LOC total in `src/`).
- **Verdict**: **load-bearing**.
- **Evidence**: every piece of the contract has a concrete implementation
  with documented enforcement points:
  - `crates/kaifuu-vault-source/src/discovery.rs:118 discover` runs SQL
    queries against `catalog.db` for `works/producers/releases/release_artifacts/facts`;
  - `crates/kaifuu-vault-source/src/resolution.rs:1` resolves
    `artifacts/by-sha/<aa>/<bb>/<sha>.7z` from a `WorkId`;
  - `crates/kaifuu-vault-source/src/extraction.rs:66 extract_archive`
    streams entries into `/scratch/itotori/<game-id>/<run-id>/extracted/`;
  - `crates/kaifuu-vault-source/src/metadata.rs:127,160 read_and_validate
    - cross_check` runs an embedded-metadata cross-check;
  - `crates/kaifuu-vault-source/src/config.rs:157 validate_vault_root`
    enforces the vault is read-only at the configuration boundary.

  Vault present in this environment: `/archive/vault/{catalog.db, artifacts/by-sha/, ...}`.

- **Test sanity check**: `tests/discovery_test.rs`, `tests/extraction_test.rs`,
  `tests/metadata_test.rs`, `tests/resolution_test.rs` exercise SQL +
  archive + path semantics with realistic fixture catalogs. The shared
  fixture in `tests/common/mod.rs` (531 LOC) is not synthetic-encoder
  tautology — it actually creates SQLite databases and on-disk archives
  the way the discovery flow would see them.
- **What would actually exercise it**: itotori running an end-to-end
  ingest on a vault `WorkId` whose engine the rest of Kaifuu can
  actually handle. Vault discovery and extraction work; the failure
  point is downstream (RealLive parser can't parse real bytes).
  The vault adapter itself is correctly load-bearing.

---

## B. The substrate cascade (UTSUSHI-020 through UTSUSHI-120)

This was previously audited in `docs/audits/substrate-honesty.md`. The
findings below restate that doc's structural points in load-bearing
language and add `file:line` evidence for each verdict.

Across the cascade, the structural fact is that **no engine port
implements any substrate trait outside of `utsushi-core` itself**:

    $ grep -rn "impl\s\+\(RuntimeVfs\|AssetPackage\|EnginePort\|SnapshotStore\|Inspectable\|TextSurfaceSink\)" crates/ apps/
    # all results live in crates/utsushi-core/src/ or crates/utsushi-core/tests/

`crates/utsushi-fixture/` contains no impl of any of these traits — it
implements the legacy `RuntimeAdapter` (`crates/utsushi-core/src/lib.rs:3743`)
and synthesises observation events directly. `crates/kaifuu-reallive/`
has zero `utsushi-core` dependency in `Cargo.toml`.

### UTSUSHI-020 — Runtime VFS and asset package boundary

- **Files**: `crates/utsushi-core/src/vfs/{runtime.rs, package.rs, id.rs,
diagnostics.rs}` (~2,200 LOC).
- **Verdict**: **aspirational**.
- **Evidence**: trait definitions at `vfs/runtime.rs:26 RuntimeVfs`,
  `vfs/package.rs:180 AssetPackage`. Production impls:
  `MountedVfs` (`vfs/runtime.rs:106`) and `PlaintextDirPackage`
  (`vfs/runtime.rs:263`) — both engine-neutral and consumed only by the
  in-tree tests `tests/vfs_synthetic_package.rs` and
  `tests/substrate_conformance.rs`. No engine adapter consumes a
  `RuntimeVfs`. `kaifuu-engine-fixture` does its own
  `fs::read_dir(game_dir)` walking.
- **Test sanity check**: `tests/substrate_conformance.rs:135` defines
  `InMemoryFixturePackage`; `:193` defines `SinglePackageVfs`. These are
  test-internal toys, not real engines.
- **What would actually exercise it**: a RealLive port that mounts the
  `REALLIVEDATA/` tree behind a `RuntimeVfs` and reads `Seen.txt /
Gameexe.ini / g00/*.g00` through it. Has not been written.

### UTSUSHI-021 — Deterministic input clock and replay log

- **Files**: `crates/utsushi-core/src/{clock.rs, input.rs, replay.rs}`
  (~1,700 LOC).
- **Verdict**: **honest-prototype**. The replay-log schema and clock
  primitives are useful in isolation and have rich serialization, but
  again no consumer outside `tests/replay_round_trip.rs` and
  `tests/replay_log_jump_target.rs`.
- **Evidence**: `crates/utsushi-core/src/replay.rs:602` total LOC of
  builder + cursor with stable `REPLAY_LOG_SCHEMA_VERSION = "0.1.0-alpha"`.
  No engine port produces a replay log.

### UTSUSHI-022 — Headless text render and audio sink contracts

- **Files**: `crates/utsushi-core/src/sink/{text.rs, audio.rs, frame.rs,
set.rs}`.
- **Verdict**: **aspirational**.
- **Evidence**: `sink/text.rs:19 TextSurfaceSink`, `sink/frame.rs:20
FrameArtifactSink`, `sink/audio.rs:15 AudioEventSink` — sole impls are
  test-collector structs in the same files
  (`sink/text.rs:111 CollectingTextSink`, `sink/set.rs:136 StubText`).

### UTSUSHI-023 — Inspectable state and snapshot primitives

- **Files**: `crates/utsushi-core/src/snapshot/{snapshot.rs, state.rs,
store.rs, inspectable.rs, diff.rs, diagnostics.rs}` (~3,800 LOC).
- **Verdict**: **honest-prototype** as a substrate, **aspirational** in
  application. The diff/restore logic is non-trivial and well-tested,
  but every `impl Inspectable` outside `utsushi-core` test files lives
  inside `#[cfg(test)] mod` blocks (e.g.
  `crates/utsushi-core/src/snapshot/snapshot.rs:550 DummyInspect`,
  `:742 FakePort`, `:887 WrongTypePort`).

### UTSUSHI-024 — WASM embed ABI fixture

- **Files**: `crates/utsushi-core/src/embed/{state.rs, capability.rs}`
  (~1,500 LOC).
- **Verdict**: **honest-prototype**. Self-contained ABI shape with
  schema-version pinning; no embed consumer exists in `apps/runtime-web-review/`
  beyond test-time wiring.
- **Evidence**: `apps/runtime-web-review/` is a Vite app; `grep -rn
"EMBED_SCHEMA_VERSION\|EmbedState\|EmbedCapability" apps/runtime-web-review/src/` returns nothing.
  The "embed ABI" is shipped as a Rust trait set with no JS/WASM
  consumer in the repo.

### UTSUSHI-025 — Engine port implementation map validator

- **Files**: `crates/utsushi-core/src/port/impl_map/{schema.rs,
validator.rs, diagnostics.rs, store.rs, tests.rs}` (~2,700 LOC).
- **Verdict**: **load-bearing** as a validator, **aspirational** as an
  inflow of real engine ports. The validator validates documents; the
  documents themselves describe one fixture port.
- **Evidence**: `port/impl_map/validator.rs:731` lines of fixture-coverage
  rules. No real engine has published an impl-map.

### UTSUSHI-026/027/028/029/030 — Conformance manifest + checks + ingestion

- **Files**: `crates/utsushi-core/src/conformance/{manifest.rs,
result.rs, fixtures.rs, trace_branch/{trace,branch}.rs,
snapshot_check/check.rs, capture_recording/{frame,recording}_check.rs}`
  (~9,400 LOC).
- **Verdict**: **minimal-pass-test**. The conformance plumbing is real
  (checks emit typed results, schema is pinned, results validate against
  a manifest), but the only fixture exercised is
  `crates/utsushi-core/src/conformance/fixtures.rs:360
SnapshotFixturePort` (957 LOC of in-tree fixtures). Every "intentional
  mismatch" test path constructs the mismatch byte-by-byte in the same
  test file.
- **Test sanity check**: `tests/substrate_conformance.rs:802 LOC` is the
  end-to-end pass — but the port it conforms is an in-test struct
  (`FixturePort` at `:421`). The "every facade-exposed schema version is
  pinned" test (`substrate.rs:115`) is a compile-time constant assertion,
  not a behavior check.

### UTSUSHI-103 — Engine-port runner crate template and ABI conformance

- **Files**: `crates/utsushi-core/src/port/{trait_.rs, manifest.rs,
diagnostics.rs}` plus `tests/engine_port.rs` (775 LOC).
- **Verdict**: **minimal-pass-test**.
- **Evidence**: `EnginePort` trait (`port/trait_.rs:204`) plus
  `ReferencePort`, `JumpCapablePort`, `JumpUndeclaredPort`,
  `MissingObservePort` — all defined inside `tests/engine_port.rs:73-300`.
  No external crate uses `EnginePort`.

### UTSUSHI-109 — Reference capture corpus validator

- **Verdict**: **load-bearing** as a validator (it does enforce real
  hash/redaction rules on validator inputs), **aspirational** as a
  proof of runtime fidelity (the corpus is in-house synthetic).
- **Evidence**: `crates/utsushi-core/src/recorder/builder.rs:25
ReferenceRecorder` produces deterministic JSON. The "reference capture
  corpus" is a folder of fixture JSON files, not real engine captures.

### UTSUSHI-120 — Runtime substrate facade and conformance release

- **Files**: `crates/utsushi-core/src/substrate.rs` (159 LOC).
- **Verdict**: **aspirational**. The facade is a `pub use` re-export
  module with a single compile-time string-equality assertion block
  (`substrate.rs:115-141`) and zero behavior.
- **Evidence**: the facade re-exports 80+ symbols (`substrate.rs:21-103`)
  but cannot be tested for its primary acceptance criterion ("engine
  runners can use one stable API surface") because there are no engine
  runners. The conformance test
  `tests/substrate_conformance.rs every_facade_exposed_schema_version_is_pinned`
  is a re-statement of the `const _` block, not a runtime check.

---

## C. The patching pipeline (KAIFUU-010 / 011 / 084 / 174)

### KAIFUU-010 — PatchResultV02 contract

- **Verdict**: **load-bearing**. Contract types in
  `crates/kaifuu-core/src/contracts.rs` are consumed by the binary patch
  smoke (`crates/kaifuu-cli/src/binary_patch_smoke.rs`), the patch
  transaction harness (`crates/kaifuu-core/src/patch_transaction.rs`),
  the fixture engine adapter, and the itotori dashboard ingestion.
  These are not bare types — every concrete patch path emits one.

### KAIFUU-011 — Binary patcher composed smoke command

- **Files**: `crates/kaifuu-cli/src/binary_patch_smoke.rs` (~860 LOC),
  consumed by `cargo run -p kaifuu-cli -- binary-patch-smoke`.
- **Verdict**: **minimal-pass-test**.
- **Evidence**: `binary_patch_smoke.rs:251-260` — when `--fixture` is
  unset (or any read from `<fixture>/SEEN.TXT` fails) the smoke synthesises
  bytes via `build_synthetic_seen_txt`. The smoke is a closed loop:
  synthetic-encoder → parser → patcher → verify → outcome. The same
  synthetic-encoder used by the KAIFUU-173 smoke tests.
- **Test sanity check**: every smoke fixture path is a synthetic byte
  builder. No real-game bytes have ever flowed through
  `run_binary_patch_smoke`.
- **What would actually exercise it**: pointing `--fixture` at a real
  RealLive game directory and asserting outputHash matches a pre-recorded
  patched archive byte-for-byte. The smoke does not attempt this and the
  parser would fail (see KAIFUU-173 probe).

### KAIFUU-084 — Binary patch rollback and no-write preflight harness

- **Files**: `crates/kaifuu-core/src/patch_transaction.rs` (1,673 LOC).
- **Verdict**: **load-bearing** for the IO state machine,
  **aspirational** for the "real-world failure modes" framing.
- **Evidence**:
  - State machine is real: `patch_transaction.rs:239 new → :261
run_preflight → :420 stage → :574 verify → :630 promote → :713
into_outcome` with `OpenOptions::write().create_new(true)` - `file.sync_all()` (`:507-538`) — the staged write is genuinely
    atomic-with-rename-style.
  - Concurrent-write detection: the `ErrorKind::AlreadyExists` branch at
    `:474-489` records a `SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION` —
    but this only catches the case where two concurrent runs happen to
    use the same staging dir, not the general race against a third
    process editing the output path. No flock, no fd-based exclusion.
  - "Partial disk failure": the `file.sync_all()` failure path
    (`:523-538`) records a fatal — that's the only nod to disk failure.
    No fault-injection test exercises a torn write or filesystem
    full-mid-write.
  - "Abort signal": no signal handling. A SIGINT mid-promote will leave
    `.staging/` populated with no rollback unless the caller manually
    re-enters `into_outcome`. Documented as such — but the acceptance
    criterion does not flag this.
- **Test sanity check**: `tests/*` for this file use temp dirs and
  in-process state mutation; no fault-injection above sha mismatch
  (`InjectFailure::VerifyHashMismatch` in `binary_patch_smoke.rs:328-336`
  just flips the last byte).

---

## D. The workflow agents (ITOTORI-013/014/015/016/018)

### ITOTORI-013 — Scene summary agent

- **Status**: actually `in_progress` in the DAG (not complete) — out of
  scope per audit charter, but the agent code already exists at
  `apps/itotori/src/agents/scene-summary/` and is exercised in CI tests.

### ITOTORI-014 — Character relationship agent

- **Files**: `apps/itotori/src/agents/character-relationship/`
  (~1,400 LOC across agent.ts/cli.ts/persistence.ts/prompt-template.ts/
  shapes.ts/staleness.ts).
- **Verdict**: **minimal-pass-test**.
- **Evidence**:
  - `agent.ts:98 await options.provider.invoke(request)` — the provider
    is injected. Every test in `test/character-relationship-agent.test.ts`
    constructs a fake provider. A live `OpenRouterProvider`
    (`apps/itotori/src/providers/openrouter.ts:53`, 907 LOC) **exists**
    but `grep -rn "OPENROUTER_API_KEY\|live: { enabled: true" apps/itotori`
    finds no live-mode invocation outside the recorded smoke
    (`apps/itotori/test/style-guide-provider-smoke.test.ts:137`, which
    records a fixture and replays it).
  - Counting: `grep -rn "FakeModelProvider\|FakeProvider" apps/itotori`
    → 79 hits. The live providers exist but the agents have never been
    run against one.
- **What would actually exercise it**: invoking the agent with a real
  OpenRouter or local-OpenAI-compatible provider on a real bridge unit
  set (e.g. a Sweetie HD bridge bundle, once KAIFUU-174 could produce
  one). Neither half of that pipeline has been run end-to-end.

### ITOTORI-015 — Route and choice map agent

- **Files**: `apps/itotori/src/agents/route-choice-map/` (~1,500 LOC).
- **Verdict**: **minimal-pass-test**. Same provider-mock pattern.
- **Staleness invocation**: `apps/itotori/src/agents/route-choice-map/
staleness.ts markStaleRouteChoiceArtifactsForRevision` is called from
  `apps/itotori/src/cli-handlers.ts:491-509` only when `--mark-stale`
  is passed. There is no background job, no event-outbox subscriber,
  no scheduled scanner. The CLI flag is the only invocation.

### ITOTORI-016 — Terminology candidate agent

- **Files**: `apps/itotori/src/agents/terminology-candidate/` (~990 LOC).
- **Verdict**: **minimal-pass-test**. Same shape.

### ITOTORI-018 — Batch planner and context packer

- **Files**: `apps/itotori/src/batch-planner/` plus
  `apps/itotori/test/batch-planner.test.ts`.
- **Verdict**: **load-bearing** for token-budget arithmetic and
  deterministic batch boundaries (the planner output is consumed by the
  agent CLIs above). The downstream consumer is exercised in tests
  (e.g. `character-relationship` agent calls
  `estimateTokens` from `../../batch-planner/token-estimator.js` at
  `apps/itotori/src/agents/character-relationship/agent.ts:2`).

---

## E. Vault and capability surfaces (KAIFUU-053 / 176)

### KAIFUU-053 — Capability-leveled engine detector registry

- **Status**: `in_progress` in the DAG. Not subject to this audit's
  load-bearing/aspirational verdict, but the supporting plumbing for
  the leveled matrix is real and has structural test coverage:
  `crates/kaifuu-core/src/registry/mod.rs:18-56` (`level_for`,
  `adapters_supporting`, `adapters_at_least`, `matrices`).
- **Capability demotion is real**: `crates/kaifuu-engine-fixture/src/lib.rs:3137`
  applies `AdapterCapabilityMatrix::identify_only(...)` to the Siglus
  detector (declared identify-only because Scene.pck/Gameexe.dat
  parsing is unsupported); `:6256 xp3_detector_level_matrix_is_identify_and_inventory_only`
  and `:6267 siglus_detector_level_matrix_is_identify_only` are
  enforcement tests. The matrix is **not a typed enum that no one
  consumes**; the level-vs-per-capability cross-validator at `:6307`
  asserts the declared level cannot exceed the per-capability reports.

### KAIFUU-176 — Vault source adapter

Covered in §A. Load-bearing.

---

## F. Patterns of theater (cross-cutting)

Recurring rhetorical structures that suggest aspirational rather than
load-bearing implementation:

1. **"Synthetic fixture" as load-bearing input.** A `synthetic` module
   inside a test file builds bytes with the exact encoder the parser
   under test decodes (e.g. `crates/kaifuu-reallive/tests/smoke.rs:19-97`,
   `crates/kaifuu-reallive/tests/patchback.rs:20-44`,
   `crates/kaifuu-engine-fixture/src/lib.rs:6859 reallive_fixture_dir`).
   The encoder/decoder is its own oracle; no third-party byte stream
   ever shows up in any test. This pattern is everywhere in the
   RealLive chain and in the conformance fixtures.

2. **"Clean-room provenance" used to justify intentionally narrow
   shape.** `crates/kaifuu-reallive/src/lib.rs:1-99` is honest about
   what it is (a synthetic smoke shape), but the DAG node title and the
   audit summary read as if real bytes are being parsed. Compare the
   honesty of the docstring against the
   `roadmap/audits/AUDIT-KAIFUU-174-20260623T201439Z.json:19` claim that
   "Scene/SEEN/Gameexe text-slot, protected-markup, and asset-reference
   inventory still emitted by `kaifuu-reallive::inventory::build_scene_inventory`"
   — true only for the synthetic AST shape.

3. **Trait + fixture impl in same crate, no external consumer.**
   Every substrate trait in `utsushi-core` has impls only inside
   `utsushi-core` tests or `utsushi-core/src/conformance/fixtures.rs`.
   The `utsushi-fixture` crate declares no impl of any of them. No
   `kaifuu-*` crate depends on `utsushi-core`. The substrate is closed
   against the rest of the workspace.

4. **`pub use` facade with compile-time string assertions.**
   `crates/utsushi-core/src/substrate.rs` is 159 LOC of `pub use`
   re-exports plus one `const _: () = { assert!(const_str_eq(...)) }`
   block. The "conformance test" of the facade
   (`tests/substrate_conformance.rs every_facade_exposed_schema_version_is_pinned`)
   re-states the constants. There is no runtime "an engine uses the
   facade" test because there is no engine.

5. **"Live provider smoke" against a recorded fixture.**
   `apps/itotori/test/style-guide-provider-smoke.test.ts:23-49`
   `validates the recorded provider suggestion fixture without network`
   — the test name acknowledges this. But the spec node
   ITOTORI-064 is titled "Style-guide live-provider smoke spec." The
   word "live" in the title surfaces nowhere in the test that ran.

6. **Capability flag opt-in that never opts in.**
   `grep -rn "live: { enabled: true" apps/itotori` finds the string
   only in fixtures and stubs. The capability-guard at
   `apps/itotori/src/providers/capability-guard.ts` is real code, but
   nothing in the workspace asks for `enabled: true`.

7. **CLI staleness flag with no background scanner.**
   `markStale*ForRevision` is exported by every agent's `staleness.ts`,
   but the only call site outside tests is the CLI behind `--mark-stale`
   (`apps/itotori/src/cli-handlers.ts:491,583`). No outbox event, no
   queue worker, no scheduled job. The "staleness scan" is opt-in CLI.

8. **Detector that returns "ambiguous" instead of failing.**
   `crates/kaifuu-engine-fixture/src/lib.rs:3447-3452 detected_variant`
   maps to strings like `unknown-reallive-named-files`. On real Sweetie
   HD, the detector returns `detected: false / detected_variant:
"unknown-reallive-named-files"`. The "unknown-reallive-named-files"
   case is the "we recognised three of four signals but the envelope
   shape was wrong" branch — i.e. the **expected** outcome on every
   real RealLive title until the envelope check is fixed.

---

## G. Concrete suggestions for raising the bar

Verification commands that, if added as required at completion time,
would have caught the patterns in §F:

1.  **For any node claiming to parse engine bytes**, require one
    verification command of the shape:

        cargo run -p kaifuu-cli -- detect <REAL_GAME_DIR> --output <tmp>
        && jq '.detections[] | select(.adapterId=="<adapter>") | .detected' <tmp> == true

    where `<REAL_GAME_DIR>` is a path that does **not** appear in
    `tests/` or `fixtures/`. The KAIFUU-172 detector would fail this on
    Sweetie HD (`detected: false`) and the gap would have surfaced at
    completion, not in this audit.

2.  **For any substrate trait introduced in `utsushi-core`**, require
    at least one impl outside `crates/utsushi-core/`. Concretely:

        grep -rn "impl\s\+<TraitName>\b" crates apps \
          | grep -v "crates/utsushi-core/"

    must return ≥ 1. This would have flagged the UTSUSHI-020/022/023/103/120
    nodes because every impl lives inside the cascade itself.

3.  **For any node titled "smoke" that operates over bytes**, fail
    completion when the smoke's only fixture is generated by a
    `synthetic` module in the same test file. A purely structural check
    would compare the encoder-bytes and parser-bytes for byte-exact
    equality on at least one independently-sourced sample (recorded into
    `fixtures/public/`, hash-pinned to a real-world source revision).

4.  **For any agent claiming live-provider capability**, require one
    gated CI job that, given a credential, invokes the real provider
    against a deterministic prompt and asserts the response shape. The
    gate is fine; the absence of the job entirely is the issue.

5.  **For any "facade" or "release" node** (e.g. UTSUSHI-120), require
    that downstream consumers (other crates, JS app) import from the
    facade. The facade-imports-from-the-facade test is tautological.

6.  **For any patch transaction harness**, require at least one
    fault-injection test that does not control the failure (e.g. fork
    a child process that kills the parent at a random moment during
    `stage` and assert no half-promoted output remains). Synthetic
    `InjectFailure` enum cases prove the planner can be told to fail,
    not that real failures are handled.

7.  **For any node touching catalog/registry semantics**, require one
    run against the real `/archive/vault/catalog.db` (or a hash-pinned
    snapshot) with at least one real `WorkId` from a known engine. The
    KAIFUU-176 vault adapter already meets this informally because its
    tests use realistic fixture SQL; the verification command could be
    formalised.

---

## Closing

The honest part of the substrate (KAIFUU-176, KAIFUU-010, KAIFUU-084,
ITOTORI-018) is real and recoverable. The brittle part (KAIFUU-172/173/174
against real RealLive bytes, the entire UTSUSHI cascade against any
non-fixture engine, the workflow agents against any live provider)
is structurally closed against the workspace's actual game data.

Closing those gaps does not need new node design — it needs the
existing nodes' acceptance criteria to forbid synthetic-only fixtures
and require one external consumer per substrate trait, with a verification
command that points at real bytes (Sweetie HD's
`REALLIVEDATA/` is sufficient and present on disk).
