# Siglus substrate lineage notes

Status: continuous research (cross-engine substrate-conformance checklist).
Schema authority: `utsushi_core::substrate` + Appendix M of
[`reallive-engine.md`](./reallive-engine.md).

## 1. Purpose

This note is the **Siglus-side** half of the AVG32 → RealLive → Siglus
substrate-alignment claim established by:

- Appendix M of [`reallive-engine.md`](./reallive-engine.md)
  (reusable-across-engines vs RealLive-only map, engine-specific boundary notes)
- The facade contract in
  [`docs/utsushi-substrate-facade.md`](../utsushi-substrate-facade.md)
- The cross-engine fixture
  `crates/utsushi-siglus/tests/cross_engine_substrate_alignment.rs`

It is **not** free-form marketing. Every reuse claim names a concrete
substrate facade type/method and is validated by the machine-readable
checklist in
`crates/utsushi-siglus/src/substrate_conformance_checklist.rs`. A
malformed lineage note (unknown facade method, missing framework anchor,
reuse claim that does not cite the carrier) fails that module's tests.

## 2. Conformance checklist (facade method → Siglus event shape)

The committed checklist is
`utsushi_siglus::substrate_conformance_checklist::siglus_substrate_conformance_checklist()`.
Each row links a **concrete substrate facade method** to the **Siglus-side
expected event shape**.

| Facade method                | Siglus expected event shape                                                                                                                                                                               | Evidence | Siglus producer                                                                              | Lineage (framework)                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `TextSurfaceSink::emit_line` | `TextLine` with `line_id=utsushi-siglus-vm/line/{n}`, `evidence_tier=E1`, `text`, optional `speaker`, `text_surface=Some("adv")`; optional colour/bridge/source/`body_shift_jis` absent on the smoke path | E1       | `crates/utsushi-siglus/src/vm.rs` — `SiglusTraceOp::EmitText` → `TextSurfaceSink::emit_line` | Appendix M.1 headless sink pipeline (`docs/research/reallive-engine.md`); carrier `TextSurfaceSink` |
| `EnginePort::capture`        | `CaptureOutcome` whose artifact URI is under `artifacts/utsushi/runtime/.../siglus-g00-redacted`, with summary `siglus-g00 capture: {w}x{h} layers={n} redacted=true`                                     | E2       | `crates/utsushi-siglus/src/cg_port.rs` — G00 decode → edge-redacted PNG                      | Appendix M.1 port-shape (`EnginePort` + `REQUIRED_LIFECYCLE_STAGES`); carrier `EnginePort`          |
| `AssetPackage::open`         | `VfsResult<AssetBytes>`: package-relative G00 bytes via `resolve` then `open`; no host path on the VFS surface; feeds `EnginePort::capture`                                                               | E2       | `UtsushiSiglusPort::load_image`                                                              | Facade Runtime VFS row (`docs/utsushi-substrate-facade.md`); carrier `AssetPackage`                 |
| `Inspectable::inspect_state` | `StateTree` paths `port.halted`, `port.program-counter`, `port.emitted-line-count`, `port.program-digest`, `port.flag.*`, `port.int.*`                                                                    | E1       | `SiglusTraceVm` `Inspectable` impl                                                           | Appendix M.1 variable banks / snapshot row; carrier `Inspectable`                                   |

### 2.1 Minimum acceptance row (worked example)

Acceptance requires **at least one** concrete facade method plus the
Siglus-side event shape. The load-bearing minimum is:

- **Facade method:** `TextSurfaceSink::emit_line`
  (real trait method on `utsushi_core::substrate::TextSurfaceSink`;
  the historical acceptance sketch `on_text_line` is **not** a facade
  method and is rejected by checklist validation).
- **Siglus expected event shape:** one `TextLine` per
  `SiglusTraceOp::EmitText`, admitted at **E1**, with
  `text_surface = Some("adv")` and synthetic `line_id`s under
  `utsushi-siglus-vm/line/{n}`.
- **Lineage:** Appendix M.1 headless sink pipeline — `TextSurfaceSink`
  / `TextLine` are engine-neutral; RealLive `module_msg` opcode IDs do
  **not** transfer (see M.2 / M.3 boundary notes in
  `docs/research/reallive-engine.md`).

## 3. Lineage diff (RealLive vs Siglus substrate expectations)

This section is a compact lineage **diff** against Appendix M. Full prose
and tables live in `docs/research/reallive-engine.md` §M; this note only
records what Siglus has **wired**, what remains a **forward** claim, and
what is **RealLive-only**.

### 3.1 Shared substrate carriers (extend)

| Carrier                                                        | Appendix M class                   | Siglus today                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `EnginePort`, `PortManifest`, `REQUIRED_LIFECYCLE_STAGES`      | scaffold shape                     | **Wired** for Launch / Capture / Shutdown on the G00 CG slice; Observe/Snapshot/Replay are `Pending` in the parity profile   |
| `AssetPackage`                                                 | scaffold                           | **Wired** for G00 package-relative open/resolve                                                                              |
| `SinkSet`                                                      | scaffold container                 | Present on the port; text/frame sinks not yet registered on the production CG port                                           |
| `TextSurfaceSink` + `TextLine`                                 | reallive-only in M.1 (was forward) | **SiglusWired** on the synthetic VM text-trace smoke (`vm.rs`); production Scene.pck text remains Research                   |
| `Inspectable` + `StateTree` / `StatePath`                      | reallive-only in M.1 (was forward) | **SiglusWired** on the synthetic VM smoke; full 26-letter bank model remains forward                                         |
| `FrameArtifactSink` + `FrameArtifact`                          | reallive-only                      | Forward: CG path currently returns `CaptureOutcome` + managed PNG rather than announcing via `FrameArtifactSink::emit_frame` |
| `SnapshotStore`, `Restorable`, `ReplayLog`, `LogicalClockTick` | reallive-only                      | Forward / Pending                                                                                                            |

### 3.2 RealLive-only (do **not** extend)

Unchanged from Appendix M.2. A Siglus port must **not** claim reuse of:

- Seen.txt 10,000-slot directory layout
- RealLive 0x1d0 scene header / bytecode lead-byte set
- `module_msg` / `module_jmp` / `select` opcode catalogues and module IDs
- RealLive g00 type layout (Siglus G00 is a **distinct** container; the
  shared claim is the facade capture/VFS surface, not the RealLive
  decoder)
- NWA/OVK voice archives, AVG-derived save layouts, Sukara XOR-2 keys

### 3.3 Engine-specific boundary notes (pointers)

When a RealLive acceptance criterion would break under a Siglus reuse
claim, Appendix M.3 already emits the boundary note. Siglus-side
expectations that replace those criteria:

| RealLive boundary (M.3)                              | Siglus substitute surface                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `module_msg` → `TextSurfaceSink` with Shift-JIS body | Synthetic / future Siglus opcode dispatch → `TextSurfaceSink::emit_line` with UTF-8 `TextLine` (E1) |
| RealLive g00 decoder → frame PNG                     | `decode_siglus_g00` + `render_siglus_cg` + `EnginePort::capture` (E2, edge-redacted default)        |
| Seen.txt → `AssetPackage::open`                      | Siglus package + logical G00 path via `AssetPackage::resolve` / `open`                              |

## 4. Validation surface

| Check                                                         | Where                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| Checklist names ≥1 facade method + Siglus event shape         | `substrate_conformance_checklist` unit tests           |
| Lineage notes cite allowed framework anchors and carriers     | `validate_lineage_note`                                |
| Malformed / marketing-only lineage fails                      | unit tests (`malformed_lineage_note_*`)                |
| Unknown facade method (e.g. `on_text_line`) fails             | `validate_checklist_entry`                             |
| This document cross-references Appendix M + checklist methods | `lineage_doc_cross_references_framework_and_checklist` |
| Shared `EnginePort` contract across engines                   | `tests/cross_engine_substrate_alignment.rs`            |
| Per-port facade import smoke                                  | `tests/substrate_conformance.rs`                       |

## 5. Clean-room posture

Unchanged from the crate-level boundary statement
(`SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`): `siglus_rs`,
`siglus-decompile`, and SiglusExtract are research anchors only — not
linked, vendored, or mechanically translated. Format hypotheses are
re-derived against real Siglus bytes on the G00 path; the VM/text smoke
remains synthetic until Scene.pck Research lands.
