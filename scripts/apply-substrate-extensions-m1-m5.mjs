#!/usr/bin/env node
/**
 * Materialises substrate extensions M.1–M.5 from
 * docs/audits/substrate-honesty.md §M as DAG nodes UTSUSHI-222 .. UTSUSHI-226.
 *
 * These are the prerequisites for the alpha-redefined gate "Substrate
 * extensions M.1–M.3 landed" (docs/alpha-localization-project-readiness.md
 * §1) and for the RealLive runtime decomposition's substrate-gap markers on
 * UTSUSHI-208/211/214/217 (M.4 + M.5 are runtime-port-specific).
 *
 * Both standing rules adopted 2026-06-24 are encoded into every node:
 *   1. No legacy-path preservation: the old symbol must be deleted in the
 *      same change that lands the new one. Acceptance criteria include a
 *      `git grep` invariant proving the old symbol is gone.
 *   2. Multi-game validation: substrate-level extensions validate against
 *      ≥2 engine families (RealLive Sweetie HD + at least one of MV/MZ
 *      Lust Memory, plain KiriKiri Bukkake Ranch); engine-specific
 *      extensions (M.4, M.5) require ≥2 real-world games of the engine
 *      and stay `planned` until the second corpus is sourced.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dagPath = resolve(root, "roadmap/spec-dag.json");
const schemaPath = resolve(root, "roadmap/spec-dag.schema.json");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateAgainstSchema(dag, schema, label) {
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(dag)) {
    const errors = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
      .join("\n");
    throw new Error(`schema validation failed (${label}):\n${errors}`);
  }
}

const COMMON = {
  projects: ["utsushi"],
  parallelGroup: "utsushi-core",
  status: "planned",
};

const NODES = [
  {
    id: "UTSUSHI-222",
    title: "Substrate M.1 — composite asset package + try-dir-then-archive resolver",
    priority: "P1",
    target: "alpha",
    dependsOn: ["UTSUSHI-020"],
    summary:
      'Replace the single-path VFS resolver with `CompositeAssetPackage` whose `resolve` walks an ordered source list of `(plaintext_dir | archive_reader)` first-match-wins, with case-folded O(1) directory indices. Introduces the `AssetArchiveReader` trait so PAK and XP3 archive readers can plug in later without re-architecting the resolver. Validated against ≥2 engine families\' real bytes (RealLive Sweetie HD\'s `#FOLDNAME.G00 = "G00" = 0 : "G00.PAK"` pattern + MV/MZ Lust Memory\'s `www/img/` + `www/data/`). The single-source resolver shipped with UTSUSHI-020 is removed in the same change — no shim, no #[deprecated]. From docs/audits/substrate-honesty.md §M.1.',
    deliverables: [
      "`CompositeAssetPackage` impl in `utsushi-core::vfs` with ordered source list",
      "`AssetArchiveReader` trait (sealed) with empty default impl set",
      "Case-folded directory index built lazily on first resolve, cached per source",
      "Old single-path resolver fully removed from `utsushi-core::vfs` (no shim)",
      "Integration test loading the RealLive Sweetie HD asset layout via `ITOTORI_REAL_GAME_ROOT` env-gated test",
      "Integration test loading the MV/MZ Lust Memory `www/data/` layout via `KAIFUU_REAL_LUST_MEMORY_PATH` env-gated test",
    ],
    acceptanceCriteria: [
      "`CompositeAssetPackage` resolves a `G00/BG01A1.g00` query by first checking the `G00/` plaintext dir and falling back to a registered `G00.PAK` archive reader without rebuilding the directory index between calls.",
      "Against `/scratch/itotori-research/sweetie-hd/extracted/.../REALLIVEDATA/`: resolver enumerates 13 asset folders with at least one plaintext-only folder, one archive-only folder, and one mixed folder; each enumerated entry's path is reachable via `composite.resolve(path)` in O(1) per query.",
      "Against `/scratch/itotori-research/rpg-maker-mv-mz/extracted/.../www/`: resolver enumerates `data/`, `img/`, `audio/` as plaintext sources; resolving `data/System.json` returns identical bytes to `fs::read(<path>)`.",
      "`rg -n 'fn resolve_asset' crates/utsushi-core/src/vfs/` returns zero hits for the legacy single-path resolver name; `git log -p` of the merge commit shows the old symbol deleted, not just unused.",
      "Acceptance test runs are gated on the two env vars; when unset, the tests `assert!(env::var(...).is_err())` and skip with an explicit `eprintln!` rather than silently passing.",
    ],
    verification: [
      {
        type: "command",
        value: "cargo test -p utsushi-core composite_asset_package",
      },
      {
        type: "command",
        value:
          "ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd/extracted KAIFUU_REAL_LUST_MEMORY_PATH=/scratch/itotori-research/rpg-maker-mv-mz/extracted cargo test -p utsushi-core composite_asset_package_real_bytes -- --include-ignored",
      },
      {
        type: "command",
        value: "rg -n 'fn resolve_asset' crates/utsushi-core/src/vfs/",
      },
    ],
    auditFocus: [
      "Any `#[deprecated]`, `pub use ... as ...` alias, or `mod legacy {...}` block preserving the single-path resolver — must be a P0 blocker.",
      "Acceptance criteria that exercise only synthetic fixtures — multi-game requirement not satisfied; demote to `planned` until the second corpus is exercised.",
      "Case-folded index that rebuilds per call (silent O(n) on every resolve) — must be lazily cached.",
      "`AssetArchiveReader` impls leaking outside the seal so callers can bypass the resolver's first-match policy.",
    ],
  },
  {
    id: "UTSUSHI-223",
    title: "Substrate M.2 — snapshot envelope size class (Small / Medium / Large)",
    priority: "P1",
    target: "alpha",
    dependsOn: ["UTSUSHI-023"],
    summary:
      "Replace the fixed `SNAPSHOT_MAX_SERIALIZED_BYTES = 16 KiB` constant with a three-tier `SnapshotEnvelope::{Small, Medium, Large}` enum (16 KiB / 256 KiB / 4 MiB) declared per port at manifest level. Sweetie HD's `REALLIVE.sav` is 24 876 bytes raw; the normalised snapshot of the int/str banks + graphics layer state is at least 64 KiB and likely 256 KiB. The current 16 KiB constant is below the floor and silently truncates. Bumps `SnapshotSchemaVersion`. The old fixed constant is deleted in the same change — no shim, no compat mode. Validated against ≥2 engine families' snapshot shapes. From docs/audits/substrate-honesty.md §M.2.",
    deliverables: [
      "`SnapshotEnvelope` enum in `utsushi-core::snapshot` with Small/Medium/Large variants and per-variant byte limit",
      "`SnapshotManifest::envelope_class` field; runner enforces per-port at write time",
      "`SnapshotSchemaVersion` bumped with explicit upgrade-path-not-supported note in changelog",
      "Old `SNAPSHOT_MAX_SERIALIZED_BYTES` constant fully removed (no `pub use` alias, no shim)",
      "Test that a Medium-class snapshot of RealLive Sweetie HD scene 1 state round-trips through serialize → deserialize → byte-equal compare",
      "Test that a Small-class snapshot exceeding 16 KiB returns a typed `SnapshotEnvelopeOverflow` error (not silent truncation)",
    ],
    acceptanceCriteria: [
      "`SnapshotEnvelope::Small.max_bytes() == 16 * 1024`, `Medium.max_bytes() == 256 * 1024`, `Large.max_bytes() == 4 * 1024 * 1024` — const-asserted.",
      "A Medium-class snapshot serialized from the simulated RealLive Sweetie HD scene 1 state (int bank: 1000 entries, str bank: 200 entries, graphics: 4 layers each with asset_id + transform) round-trips byte-equal through `serialize` → `deserialize` → `serialize` and is between 64 KiB and 256 KiB.",
      "A Small-class snapshot whose serialized form exceeds 16 KiB returns `Err(SnapshotEnvelopeOverflow { envelope_class: Small, observed_bytes: <n>, limit_bytes: 16384 })` and writes nothing — no partial output, no silent truncation.",
      "`rg -n 'SNAPSHOT_MAX_SERIALIZED_BYTES' crates/` returns zero hits.",
      "A second engine family's snapshot test (MV/MZ `www/save/file1.rpgsave` shape — JSON object with `$gameSystem`, `$gameMap`, `$gameVariables`) round-trips through the Medium envelope at a non-trivial byte count.",
    ],
    verification: [
      {
        type: "command",
        value: "cargo test -p utsushi-core snapshot_envelope",
      },
      {
        type: "command",
        value: "cargo test -p utsushi-core snapshot_envelope_real_shapes -- --include-ignored",
      },
      {
        type: "command",
        value: "rg -n 'SNAPSHOT_MAX_SERIALIZED_BYTES' crates/",
      },
    ],
    auditFocus: [
      "Any preserved alias for `SNAPSHOT_MAX_SERIALIZED_BYTES` — P0.",
      "Schema-version bump skipped or marked as backwards-compatible (it is not).",
      "Test that proves the envelope works at fixture scale only — multi-engine requirement not satisfied.",
      "`SnapshotEnvelope::Large` variant used where `Medium` suffices (over-allocation hiding the regression check).",
    ],
  },
  {
    id: "UTSUSHI-224",
    title: "Substrate M.3 — EnginePort → substrate-sinks bridge (legacy hooks removed)",
    priority: "P1",
    target: "alpha",
    dependsOn: ["UTSUSHI-022", "UTSUSHI-103", "UTSUSHI-120"],
    summary:
      'Refactor `EnginePort::observe` to push into the substrate sinks (`TextSurfaceSink`, `FrameArtifactSink`, `AudioEventSink`) instead of returning the legacy `ObservationHookEvent` enum. Adds `EnginePort::sink_set(&self) -> &SinkSet` (or equivalent) so the runner drains sinks per tick. The legacy `ObservationHookEvent` type and every variant of it are deleted in the same change — no compat enum, no #[deprecated], no shim trait. Migrates `utsushi-fixture` to the new path so the alpha gate "≥1 non-test consumer of each substrate subsystem" is satisfied on day one. This is the single most-fixture-shaped element of the cascade per the substrate-honesty audit. From docs/audits/substrate-honesty.md §M.3.',
    deliverables: [
      "`EnginePort` trait redefined: `observe` returns `Result<()>` (not `ObservationHookEvent`); new `sink_set(&self) -> &SinkSet` accessor",
      "`SinkSet` struct in `utsushi-core::substrate` holding `Arc<dyn TextSurfaceSink>` + `Arc<dyn FrameArtifactSink>` + `Arc<dyn AudioEventSink>`",
      "`Runner::tick` drains all three sinks per tick via the new accessor; ordering documented",
      "`ObservationHookEvent` enum + every variant + every match arm referencing it deleted from the workspace",
      "`utsushi-fixture` migrated to implement `EnginePort` via the new sinks-bridge path; its tests pass against the new trait without referencing the old enum",
      "`ITOTORI_REAL_GAME_ROOT`-gated test demonstrating a thin RealLive-shaped port pushing TextSurfaceSink + FrameArtifactSink events during a 10-tick run",
      "Equivalent test exercising `utsushi-fixture` to prove the substrate has ≥2 distinct production consumers (per the alpha gate)",
    ],
    acceptanceCriteria: [
      "`rg -n 'ObservationHookEvent' crates/` returns zero hits across the workspace (production and test code).",
      "`EnginePort::observe` signature is `fn observe(&self, ctx: &ObserveContext) -> Result<(), EnginePortError>`; no `-> ObservationHookEvent` or `-> Vec<HookEvent>` form remains.",
      "`utsushi-fixture` implements `EnginePort` and its 10-tick run pushes at least one `TextSurfaceSink::emit` call and one `FrameArtifactSink::emit` call per tick where applicable; collector test asserts the counts.",
      "A second port impl in `crates/utsushi-reallive-port-skeleton` (or similar minimal crate) pushes the same sinks against simulated RealLive Sweetie HD scene 1 state; the substrate is exercised by ≥2 distinct production consumers.",
      "Runner ordering doc: `tick()` calls `engine.observe()` first, then drains text, then frame, then audio, in that order; documented invariant matched by behaviour test.",
      "No `#[deprecated]` markers, no `pub use ... as ObservationHookEvent` re-exports, no `legacy_observe()` compat method exists anywhere.",
    ],
    verification: [
      {
        type: "command",
        value: "cargo test -p utsushi-core engine_port_sinks_bridge",
      },
      {
        type: "command",
        value: "cargo test -p utsushi-fixture",
      },
      {
        type: "command",
        value: "rg -n 'ObservationHookEvent' crates/",
      },
      {
        type: "command",
        value:
          "ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd/extracted cargo test -p utsushi-core engine_port_sinks_bridge_real_bytes -- --include-ignored",
      },
    ],
    auditFocus: [
      "Any preserved `ObservationHookEvent` symbol — P0; the audit named this as 'the single most-fixture-shaped element of the cascade'.",
      "`utsushi-fixture` migration not landed in the same commit — the alpha gate's '≥1 non-test consumer' is unmet without it.",
      "Sinks documented but never drained by `Runner::tick` (silent dead-code).",
      "Tests that exercise the sinks via a collector struct declared inside the substrate's own `#[cfg(test)]` rather than a production consumer.",
    ],
  },
  {
    id: "UTSUSHI-225",
    title: "Substrate M.4 — pixel-bound mouse area input event",
    priority: "P2",
    target: "continuous",
    dependsOn: ["UTSUSHI-021", "UTSUSHI-224"],
    summary:
      "Add `InputEvent::AreaHit { area_id: String, screen_x: u16, screen_y: u16 }` so the substrate can represent RealLive's `MOUSEACTIONCALL = AREA=x0,y0,x1,y1` semantics without falling back to `Raw` opacity. Records the hit deterministically in the replay log and surfaces a `bridge_unit_id` linkage so the hit maps to the scene-jump target. The legacy `Raw`-only mouse path stays only for engines that genuinely have no area concept (none of the alpha-claimed three); for RealLive specifically the `Raw` mouse path is replaced. Requires ≥2 real-world RealLive games to validate the area dispatch isn't Sweetie-HD-specific; until a second RealLive title is sourced this node remains `planned` with a sourcing-required note. From docs/audits/substrate-honesty.md §M.4.",
    deliverables: [
      "`InputEvent::AreaHit` variant added to `utsushi-core::input::InputEvent`",
      "Replay log writer + reader round-trip the variant deterministically (golden test)",
      "`bridge_unit_id` field on `AreaHit` populated by the engine port; conformance check can compare across two ports' replay logs",
      "RealLive-specific code paths invoking `InputEvent::Raw` for mouse clicks deleted; only non-RealLive engines retain `Raw` opacity",
      'Test against Sweetie HD\'s `MOUSEACTIONCALL = AREA=1232,0,1279,719` declaration: a synthetic click at (1255, 359) emits `AreaHit { area_id: "mouseaction_call_0", screen_x: 1255, screen_y: 359 }` and the replay log round-trips byte-equal',
      "Test against a second real RealLive title's MOUSEACTIONCALL declaration (sourcing required — node stays planned until available)",
    ],
    acceptanceCriteria: [
      "`InputEvent::AreaHit` exists with the named fields and is serialised by the replay log without falling through to `Raw`.",
      "Conformance check compares two ports' replay logs for the same scripted click and reports byte-equal `AreaHit` payloads or surfaces a typed `AreaIdMismatch` / `CoordinateMismatch` error.",
      "Against the real Sweetie HD `Gameexe.ini` `MOUSEACTIONCALL` declaration: the substrate test loads the area definition, simulates a click inside the rectangle, and asserts the emitted `AreaHit::area_id` matches the Gameexe-derived label.",
      'Sourcing-required note in the summary explicitly says "second RealLive title required before this node can complete"; orchestrator does not approve completion until the second corpus is exercised against the same code path.',
      "`rg -n 'InputEvent::Raw.*mouse|raw_mouse' crates/utsushi-reallive/` returns zero hits in production code paths once this node lands (Raw mouse remains only in `utsushi-fixture` and any non-RealLive engine).",
    ],
    verification: [
      {
        type: "command",
        value: "cargo test -p utsushi-core input_area_hit",
      },
      {
        type: "command",
        value:
          "ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd/extracted cargo test -p utsushi-core input_area_hit_real_bytes -- --include-ignored",
      },
      {
        type: "manual",
        value:
          "Second RealLive title sourced and staged at /scratch/itotori-research/<game>/extracted before completion can be approved",
      },
    ],
    auditFocus: [
      "Completion approved with only one real RealLive game exercised — violates the multi-game validation rule.",
      "`InputEvent::Raw` retained as a parallel path for RealLive mouse clicks after this lands — must be deleted on the RealLive side.",
      "`area_id` derived heuristically rather than from the Gameexe declaration — would not round-trip across two ports.",
    ],
  },
  {
    id: "UTSUSHI-226",
    title: "Substrate M.5 — frame-as-layer-composition sink",
    priority: "P2",
    target: "continuous",
    dependsOn: ["UTSUSHI-022", "UTSUSHI-224"],
    summary:
      "Extend the frame sink so a frame carries a structural `LayerComposition` (ordered Vec of `(layer_index, asset_id, transform, blend_mode)`) alongside any PNG artifact URI. Sweetie HD's `OBJECT_MAX=256` graphics layers is the ground-truth frame model — capturing only an artifact URI loses the layer-level evidence the conformance comparison wants. Adds `LayerCompositionSink::emit_composition(FrameComposition)` or extends `FrameArtifactSink` with `composition: Option<LayerComposition>`. Substrate does not render; the port produces both the composition and (separately) the PNG. E2 or E3 ceiling because the layer list is structural evidence. Legacy URI-only frame events are removed for RealLive; non-RealLive engines that don't have a layer model emit `composition: None`. Requires ≥2 real-world RealLive scenes (Sweetie HD scene 1 + one from a second title) to validate. From docs/audits/substrate-honesty.md §M.5.",
    deliverables: [
      "`LayerComposition` struct in `utsushi-core::sinks::frame` carrying `Vec<LayerEntry>` where `LayerEntry { layer_index: u16, asset_id: AssetId, transform: AffineTransform, blend_mode: BlendMode }`",
      "`FrameArtifactSink::emit` signature extended with `composition: Option<LayerComposition>` (no separate sink; one drain path)",
      "RealLive-port-skeleton produces a `Some(composition)` payload for each frame; non-RealLive paths produce `None`",
      "Conformance ceiling for layer-composition evidence raised to E2 (replay-comparable) or E3 (frame-equivalent) per port declaration",
      "Old URI-only `emit` overload removed; all consumers updated to the unified signature in the same change",
      "Test against simulated Sweetie HD scene 1 layer stack (4-8 active layers) producing a composition that round-trips through serialize → deserialize → byte-equal",
      "Second-corpus test (RealLive title TBD; node stays planned until sourced)",
    ],
    acceptanceCriteria: [
      "`FrameArtifactSink::emit(frame_id, artifact_uri, composition)` is the only frame emit method; no `emit_uri_only` overload remains.",
      "`LayerComposition` round-trips through serde JSON byte-equal across `serialize → deserialize → serialize` for a frame with ≥4 layers.",
      "Against simulated Sweetie HD scene 1 with `OBJECT_MAX=256` declared: a frame with 4 active layers (1 BG, 2 character sprites, 1 textbox) produces a `LayerComposition` whose entries are ordered ascending by `layer_index`, with each `asset_id` resolvable via the `CompositeAssetPackage` from M.1.",
      "Conformance check between two ports producing the same frame composition reports byte-equal layer lists or surfaces typed `LayerComposition::OutOfOrder` / `AssetIdMismatch` errors.",
      "`rg -n 'emit_uri_only|frame_emit_uri|fn emit_frame_uri' crates/` returns zero hits after this lands.",
      'Sourcing-required note in summary explicitly says "second RealLive title required"; completion not approved until the second corpus is exercised.',
    ],
    verification: [
      {
        type: "command",
        value: "cargo test -p utsushi-core layer_composition",
      },
      {
        type: "command",
        value:
          "ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd/extracted cargo test -p utsushi-core layer_composition_real_bytes -- --include-ignored",
      },
      {
        type: "manual",
        value: "Second RealLive title sourced and staged before completion can be approved",
      },
    ],
    auditFocus: [
      "Completion approved with only one real RealLive scene exercised — violates the multi-game validation rule.",
      "URI-only emit overload preserved for back-compat — must be deleted.",
      "`LayerComposition::None` accepted where `Some(...)` is required for RealLive ports — silent down-grade hiding the layer evidence.",
      "Conformance ceiling left at E0/E1 (smoke-only) — defeats the purpose of the structural evidence.",
    ],
  },
];

// Apply --------------------------------------------------------------------

const schema = loadJson(schemaPath);
const dag = loadJson(dagPath);

validateAgainstSchema(dag, schema, "pre-mutation");

const existingIds = new Set(dag.nodes.map((n) => n.id));
const newNodes = [];
for (const draft of NODES) {
  if (existingIds.has(draft.id)) {
    throw new Error(`${draft.id} already exists in roadmap/spec-dag.json`);
  }
  const node = { ...COMMON, ...draft };
  newNodes.push(node);
}

// Insert immediately after UTSUSHI-221 (the last decomposition sub-node) so the
// substrate-extension block is contiguous with the rest of UTSUSHI's substrate
// work.
const anchorIndex = dag.nodes.findIndex((n) => n.id === "UTSUSHI-221");
if (anchorIndex < 0) {
  throw new Error("UTSUSHI-221 not found; cannot anchor substrate-extension insertion");
}
dag.nodes.splice(anchorIndex + 1, 0, ...newNodes);

validateAgainstSchema(dag, schema, "post-mutation");

writeFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`);

console.log(
  `Inserted ${newNodes.length} substrate-extension nodes (UTSUSHI-222 .. UTSUSHI-226). DAG now has ${dag.nodes.length} nodes.`,
);
