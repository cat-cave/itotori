# RealLive Engine — Research

> **Schema authority.** Appendix M (§M) is the load-bearing cross-engine
> substrate conformance map (AVG32 → RealLive → Siglus lineage). It is cited
> by [`siglus-substrate-lineage-notes.md`](./siglus-substrate-lineage-notes.md)
> and [`docs/utsushi-substrate-facade.md`](../utsushi-substrate-facade.md), and
> enforced by `crates/utsushi-siglus` substrate_conformance checklist tests.
> **Preserve the `## M.` / `### M.N` heading labels** — checklist framework
> anchors and human cross-refs depend on them.
>
> The earlier §A–§K investigation narrative (format archaeology, per-title
> byte notes, scope estimates) is archived at
> [`archive/reallive-engine-sweetie-hd-investigation.md`](./archive/reallive-engine-sweetie-hd-investigation.md).
>
> Provenance discipline for Appendix M claims:
>
> - **[V]** verified against shipping RealLive bytes (specific file/offset)
> - **[P]** taken from a public source (rlvm, RLDEV, format discussions)
> - **[U]** unknown / requires further investigation
>
> rlvm and siglus_rs are research anchors only. No source expression from
> either is copied; no GPL-3 code is vendored.

## M. Cross-engine substrate conformance + Siglus lineage (UTSUSHI-221, extended by UTSUSHI-147)

> Scope: tie the `utsushi-reallive` port (UTSUSHI-200..UTSUSHI-220) into
> UTSUSHI-147's cross-engine substrate-alignment fixture, and document
> which sub-nodes of the decomposition are reusable through the
> `utsushi-siglus` sibling crate UTSUSHI-147 promoted from the original
> inline scaffold (the AVG32 → RealLive → Siglus lineage Visual Arts
> documents). See §M.7 for the inline-to-sibling-crate promotion notes.
>
> **Current Siglus CG scope.** `utsushi-siglus` now implements a real
> package-backed G00 capture slice: type-0 compressed BGR and type-2
> layered BGRA containers decode through `UtsushiSiglusPort`, rasterize in
> process, and emit a managed default-redacted PNG at E2/LayoutProbe.
> `siglus_g00_real_bytes.rs` drives that production lifecycle against two
> real Siglus titles when their env-gated roots are available. The full
> Siglus VM, text observation, snapshots, and replay remain research-only;
> the cross-engine fixture consequently proves the shared `EnginePort`
> contract while the real-byte fixture proves the CG path.
>
> **Boundary-aware ("reusable" is not an assertion).** The audit-focus
> block on UTSUSHI-221 calls out two failure modes the conformance
> evidence must guard against:
>
> 1. _"'Reusable' claims that haven't been proven against a Siglus
>    prototype."_ Each "reusable" entry below ties to a concrete
>    `utsushi_core::substrate::*` type or trait. Two distinct strengths
>    of claim are in play, and §M.1 marks each row accordingly:
>    - **_[scaffold]_** — the carrier is consumed by **both** the
>      `utsushi-reallive` source **and** the inert `utsushi-siglus`
>      scaffold today (the twelve scaffold-contract baseline leaves;
>      e.g. `EnginePort`, `PortManifest`, `REQUIRED_LIFECYCLE_STAGES`,
>      `SinkSet`, `AssetPackage`). The
>      `substrate_facade_leaf_baseline_matches_across_engines` test
>      fails at the source-scan if either side drifts.
>    - **_[reallive-only]_** — the carrier is consumed by
>      `utsushi-reallive` only (verified: `TextSurfaceSink`,
>      `AudioEventSink`, `FrameArtifactSink`, `SnapshotStore`,
>      `Inspectable`, `Restorable`, `ReplayLog`, `LogicalClockTick`,
>      `StateTree`, `StatePath`, `ChoiceIndex` appear in
>      `crates/utsushi-reallive/src/**` but **not** in
>      `crates/utsushi-siglus/src/lib.rs`). Reusability for these is
>      proven by RealLive's consumption **plus** the facade exporting
>      the type — **not** by any consumption inside the inert Siglus
>      scaffold, which never imports them. The "reusable for Siglus"
>      column for these rows is a forward expectation a future
>      behavioural Siglus port must satisfy, not a present-tense
>      cross-engine consumption fact.
>
>    Reusability is therefore a property of the substrate facade
>    (proven by RealLive's real consumption + the test), not of the
>    engine implementations (which remain inert scaffolds for
>    `utsushi-siglus` until a behavioural Siglus port lands;
>    `utsushi-reallive` carries behaviour through
>    UTSUSHI-201..UTSUSHI-220).
>
> 2. _"Lineage notes that just repeat marketing instead of documenting
>    actual code reuse points."_ Every reusable-anchor entry below
>    names the concrete substrate type that carries — `AssetPackage`,
>    `TextSurfaceSink`, `SnapshotStore`, `EnginePort`, etc. — and the
>    sub-node where that type is consumed **by `utsushi-reallive` (the
>    only present-day consumer of the deeper carriers)**. The reuse
>    claim is a code citation, not a brand affinity.
>
> **Clean-room posture for the `utsushi-siglus` scaffold.**
> `xmoezzz/siglus_rs` (https://github.com/xmoezzz/siglus_rs, MPL-2.0;
> the clearest bytecode reference is `bluecookies/siglus-decompile`,
> unlicensed → all-rights-reserved/documentation-only; SiglusExtract is
> xmoezzz GPLv3; plus the historical Mafia / GARbro reverse-engineering
> work) is a **research anchor only**. The `utsushi-siglus` crate does NOT
> depend on siglus_rs, does NOT include siglus_rs headers, does NOT
> copy siglus_rs's structure layouts, and does NOT mechanically
> translate siglus_rs code into Rust. The clean-room boundary
> statement (carried as
> `utsushi_siglus::SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`) is
> mirrored from the RLVM one and is asserted load-bearingly by the
> cross-engine substrate-alignment fixture.

### M.1 Reusable across engines (substrate-carried surfaces)

The lineage Visual Arts documents (AVG32 → RealLive → Siglus) lets us
predict which sub-node surfaces survive a port from RealLive to Siglus
at the substrate-facade level. The following are encoded as **trait /
type reuses** on `utsushi_core::substrate::*`; the engine's own work is
to populate the typed surface, not to redesign it.

The **Consumed today by** column is load-bearing against overclaim:
_[scaffold]_ means the carrier is imported by **both** the
`utsushi-reallive` source and the inert `utsushi-siglus` scaffold (a
scaffold-contract baseline leaf the cross-engine fixture pins);
_[reallive-only]_ means the carrier is consumed by `utsushi-reallive`
only and the inert Siglus scaffold does **not** import it (verified by
`rg` over `crates/utsushi-siglus/src/lib.rs`, which imports only
`AssetPackage`, `EnginePort`, `EnginePortError`, `EvidenceTier`,
`FidelityTier`, `LifecycleStage`, `PortCapability`, `PortManifest`,
`PortRequest`, `PortShutdownOutcome`, `REQUIRED_LIFECYCLE_STAGES`,
`SinkSet`). For _[reallive-only]_ rows the "reusable for Siglus" text
is a forward expectation, proven by RealLive's consumption + the
facade exporting the type, not by Siglus consumption.

| RealLive sub-node                                 | Substrate facade carrier                                    | Consumed today by                            | Why reusable for Siglus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UTSUSHI-205 expression encoding                   | (engine-local AST; trait-free)                              | neither (engine-local, no facade carrier)    | The expression byte-stream grammar Visual Arts shipped in AVG32 is the **direct ancestor** of the Siglus expression encoding. Same opener-byte tagging strategy (`\xFF` int literal, `\xC8` store reference, dotted-bank reference). The engine-local `ExprNode` shape ports cleanly. _[P]_                                                                                                                                                                                                                                     |
| UTSUSHI-206 variable banks                        | `Inspectable` + `Restorable` (`StateTree` / `StatePath`)    | **reallive-only**                            | RealLive ships 13 integer-bank letters (`intA`-`intZ` minus 13 unused), Siglus extends to **26 letters** plus longer index ranges. The substrate's `StateTree` + `StatePath` types are bank-shape-neutral: each bank's letter and index land as a `StatePath`, identical at the snapshot layer. The inert Siglus scaffold does not import these yet. _[P]_                                                                                                                                                                      |
| UTSUSHI-203 AVG32 LZ + XOR                        | (engine-local decompressor; trait-free)                     | neither (engine-local, no facade carrier)    | AVG32's `XOR + LZSS` first-level transform is shared substrate; the AVG32 256-byte XOR mask is the same constant in both engines per Visual Arts's compression pipeline. Siglus adds a different second-level transform on top, but the LZ+XOR foundation is reusable. _[P]_                                                                                                                                                                                                                                                    |
| UTSUSHI-207 Gameexe-style config                  | `AssetPackage` + engine-local parser                        | **scaffold** (type slot); reallive behaviour | RealLive uses `Gameexe.ini` (Shift-JIS, dotted-key); Siglus uses `Resource.txt` (UTF-16LE, also dotted) plus a per-namespace `Gameexe.dat`. Both ports carry an `Option<Arc<dyn AssetPackage>>` slot (baseline import); `utsushi-reallive` exercises it for real reads (`module_audio` / `module_obj` / `module_grp`), the inert Siglus scaffold holds it `None`. The dotted-path tree shape and the typed `get_int` / `get_tuple3` access patterns generalise; only the encoding + tokeniser differs.                          |
| (multiple) headless sink pipeline                 | `TextSurfaceSink`, `AudioEventSink`, `FrameArtifactSink`    | **reallive-only** (`SinkSet` is scaffold)    | Every text-displaying / audio-playing / frame-rendering opcode in both engines reduces to one of the three substrate `SinkSet` channels. Both ports import the `SinkSet` container (baseline), but only `utsushi-reallive` imports the three sink traits and emits through them; the inert Siglus scaffold registers no sink. `TextLine { speaker, body, evidence_tier }`, `AudioEvent { event_kind, evidence_tier }`, and `FrameArtifact { artifact_id, width, height, frame_index }` are engine-neutral payload shapes. _[V]_ |
| UTSUSHI-208 snapshot/restore contract             | `SnapshotStore` + `Inspectable` + `Restorable`              | **reallive-only**                            | The "VM snapshot at any tick boundary" round-trip contract is identical: both engines snapshot the call stack + variable banks + active longop's private state. The substrate's `take_snapshot` / `restore_snapshot` free functions consume the engine's `Inspectable` / `Restorable` impls without knowing which engine they came from. The inert Siglus scaffold does not import these yet. _[V]_                                                                                                                             |
| UTSUSHI-220 end-to-end replay (text-replay smoke) | `ReplayLog` + `ReplayLogBuilder` + `LogicalClockTick`       | **reallive-only**                            | The replay-log JSON envelope (schema `utsushi-reallive-replay-log/0.1.0-alpha` for the RealLive port; the equivalent `utsushi-siglus-replay-log/...` for the future Siglus port) consumes the same substrate `ReplayLog` builder; the per-engine schema-id is an envelope-level label, not a substrate fork. The inert Siglus scaffold does not import these yet.                                                                                                                                                               |
| (port-shape) port manifest + lifecycle            | `EnginePort` + `PortManifest` + `REQUIRED_LIFECYCLE_STAGES` | **scaffold shape** (both engines)            | Both engines declare the same four required lifecycle stages (Launch, Observe, Capture, Shutdown). RealLive declares the capabilities it wires; the inert `utsushi-siglus` scaffold declares no wired capabilities and records the peer-wired lifecycle/snapshot/replay gaps as dev-`Pending` in its parity profile. _[V — proven by `cross_engine_substrate_alignment` fixture in `crates/utsushi-siglus/tests/`]_                                                                                                             |

The conformance fixture asserts (compile-time + source-scan) that the
inert `utsushi-siglus` scaffold reaches **exactly** the twelve-leaf
baseline set of `utsushi_core::substrate::*` symbols (the _[scaffold]_
rows above) and that `utsushi-reallive` reaches that same baseline as a
**subset** of its larger behavioural import set. The _[reallive-only]_
carriers are not part of the cross-engine baseline — they are consumed
by `utsushi-reallive` and exported by the facade, awaiting a future
behavioural Siglus port. If a future change to either side breaks the
baseline-import invariant, the fixture fails before the import
asymmetry can be silently accepted.

### M.2 RealLive-only (does NOT carry to Siglus)

The following sub-node surfaces are **engine-specific to RealLive**.
A Siglus port reusing the substrate facade reuses the substrate facade
— it does NOT reuse the per-RealLive byte layouts or opcode-table
identifiers below. Any acceptance criterion that names one of these is
RealLive-only and is flagged as such in §M.3 below.

| RealLive sub-node                       | RealLive-only surface                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UTSUSHI-201 Seen.txt parser             | The 10,000-slot `(offset, size)` directory layout is RealLive's archive shape. Siglus ships `Scene.pck` with a **different** envelope (header + per-scene block table + encrypted scene blobs). The substrate's `AssetPackage::open` carries; the parser does not.                                                       |
| UTSUSHI-202 scene-header parser         | The 0x1d0-byte typed scene header (compiler_version, kidoku_offset/count, entrypoint table at 0x34, savepoint table at offset N) is RealLive-only. Siglus scene headers are a different shape with a different field set.                                                                                                |
| UTSUSHI-204 bytecode element stream     | The RealLive bytecode element lead-byte set `{0x00, 0x0a, 0x21, 0x23, 0x24, 0x2c, 0x40}` plus the 8-byte `CommandElement` header `(0x23, module_type, module_id, opcode_u16, arg_count, overload)` is the AVG32-derived RealLive shape. Siglus uses a different command-header byte layout.                              |
| UTSUSHI-209 module_msg opcodes          | The rlvm-specific opcode catalogue (`msg.text`, `msg.pause`, `msg.par`, `msg.FontColor`, `msg.FaceOpen`, etc.) and the `(module_type=0x00, module_id=0x00)` module identifiers addressing is RealLive's. Siglus uses different module identifiers and a different per-module dispatch table; opcode IDs do not transfer. |
| UTSUSHI-210 module_jmp (control-flow)   | The `goto_if` / `goto_unless` / `goto_on` / `gosub` / `farcall` opcode byte-codes are RealLive's. Siglus has structurally equivalent operations (its VM is descended from AVG32's) but different opcode bytes and a different `farcall` cross-scene addressing scheme.                                                   |
| UTSUSHI-211 select family               | `select` / `select_s` / `select_w` / `select_objbtn` and the `SELBTN.NNN.*` Gameexe styling values are RealLive-only. Siglus's choice machinery uses a different opcode family and a different per-choice styling source.                                                                                                |
| UTSUSHI-216 g00 image decoder           | The g00 format (types 0, 1, 2 with the region-list sub-format for type 2) is RealLive-exclusive. Siglus uses `.g00` filenames in some titles but with a **different** internal format; more commonly Siglus titles ship `.pna` / `.pnp` images. The decoder does not transfer.                                           |
| UTSUSHI-217 NWA + OVK voice archives    | NWA is the AVG32 audio container; while AVG32 is a shared ancestor, Siglus titles ship audio in **different containers** (e.g. `.ogg` directly, or `.ovk` with a different sub-sample addressing). The OVK voice archives format with the `(speaker, sample_id)` 16-byte entry table is RealLive's.                      |
| UTSUSHI-218 AVG_SYSTEM/GLOBAL/READ save | The `AVG_SYSTEM_SAVE` / `AVG_GLOBAL_SAVE` / `AVG-derived read flags` save-file layout is RealLive-derived. Siglus saves use a different magic and a different per-slot block structure.                                                                                                                                  |
| UTSUSHI-213 system-call dispatch        | The `9999, 10`-style `(scene_id, entrypoint)` system-call route addressing is a RealLive-only Gameexe convention. Siglus's equivalent uses dotted `Resource.txt` keys with a different routing shape.                                                                                                                    |
| UTSUSHI-219 Sukara XOR-2 key research   | The Sukara-title second-level XOR transform is a **per-publisher-per-compiler-version** RealLive concern. Siglus has its own per-title encryption scheme (Scene.pck key derivation) that is unrelated.                                                                                                                   |

### M.3 Engine-specific boundary notes per sub-node

The spec's third deliverable is to emit a documented **engine-specific
boundary note** wherever a UTSUSHI-200..UTSUSHI-220 acceptance
criterion would break under a Siglus reuse claim. The notes below pin
those criteria. Each one cross-references the substrate-carried
surface from §M.1 that DOES carry (so the boundary is narrow: the
surface generalises, the byte-layout does not).

- **UTSUSHI-201** (Seen.txt 10,000-slot parser) — _RealLive-only._ The
  acceptance criterion "parser returns exactly 198 non-zero scenes,
  scene-id range 1..=9999" is RealLive-archive-specific. Siglus's
  `Scene.pck` carries a header + block-table envelope with no
  10,000-slot reservation. The substrate carrier (`AssetPackage::open`)
  is reusable; the byte layout is not. A future Siglus port re-uses
  the substrate VFS path but ships its own `scene_index` module.

- **UTSUSHI-203** (AVG32 LZ + XOR decompressor) — _partially reusable._
  The first-level AVG32 LZSS + 256-byte XOR transform IS the shared
  Visual Arts substrate (per the lineage; `AVG32_XOR_MASK` would be
  literal-identical). The acceptance criterion "Sweetie HD scene #0001
  decompresses to exactly 1660 bytes" is RealLive-byte-specific. The
  `xor_2_key = None` posture (UTSUSHI-219) is RealLive-only; Siglus
  uses a different second-level key-derivation that has no analogue in
  the RealLive XOR-2 family.

- **UTSUSHI-207** (Gameexe.ini Shift-JIS dotted parser) — _shape
  reusable, encoding RealLive-only._ The dotted-path typed-value
  access pattern (`gameexe.get_int_array("...")`, etc.) generalises to
  Siglus's `Resource.txt` (UTF-16LE) plus per-namespace `Gameexe.dat`
  (binary, requires the Siglus-specific key profile to decrypt).
  Acceptance criteria naming Shift-JIS keys ("`CAPTION ==
"オシオキSweetie＋Sweets!! HD Edition　"`", "`FOLDNAME.G00 == ("G00",
0, "G00.PAK")`") are RealLive-encoding-specific. The substrate
  carrier (`RuntimeVfs::open` for the config asset, then engine-local
  parser) is reusable.

- **UTSUSHI-209** (module*msg text/messaging opcodes) — \_RealLive-only
  byte-codes; substrate sink carries.* The acceptance criterion "each
  implemented opcode emits exactly one TextLine through
  TextSurfaceSink with the Shift-JIS-decoded body" — the
  `TextSurfaceSink` part is reusable (substrate carrier); the opcode
  IDs (`text`, `pause`, `par`, `br`, `page`, `FontColor`, etc. with
  their RealLive-specific module-type/module-id addressing) are not.
  A Siglus port reuses `TextSurfaceSink::emit_line` but populates it
  from a different opcode dispatch table.

- **UTSUSHI-210** (`module_jmp` control-flow opcodes) — _RealLive-only
  byte-codes; substrate call-stack snapshot carries._ The acceptance
  criteria naming the `goto_if` / `goto_unless` / `goto_on` / `gosub` /
  `farcall` opcode byte-codes (and the `farcall` cross-scene
  `(scene_id, entrypoint)` addressing scheme) pin RealLive's
  `module_jmp` opcode table. Siglus has structurally equivalent
  control-flow operations (its VM descends from AVG32's) but different
  opcode bytes and a different `farcall` addressing scheme; the byte-codes
  do not transfer. The substrate carriers that DO carry are the
  call-stack round-trip — `gosub` / `farcall` push frames that the
  `SnapshotStore` + `Inspectable` / `Restorable` contract (§M.1,
  UTSUSHI-208) snapshots engine-neutrally — and the conditional-jump
  predicates, which reduce to the engine-local `ExprNode` AST (§M.1,
  UTSUSHI-205) whose AVG32-derived grammar ports cleanly. A Siglus port
  reuses those facade surfaces but populates them from its own
  control-flow opcode dispatch table.

- **UTSUSHI-211** (`select` / `select_s` / `select_w` family) —
  _RealLive-only opcodes; substrate ChoiceIndex carries._ Acceptance
  criteria naming the RealLive sel-module opcodes and the
  `SELBTN.NNN.*` Gameexe styling values are RealLive-specific. The
  substrate `ChoiceIndex` input event and the `TextLine` with
  `kind=Choice` are reusable across engines.

- **UTSUSHI-212** (string / memory / system-arithmetic ops) —
  _Shift-JIS conversion tables RealLive-only; rng determinism via
  substrate carries._ The acceptance criteria
  "`Uppercase("ＡＢＣ")` returns `"ＡＢＣ"`" and "`hantozen("abc")`
  returns `"ａｂｃ"` (full-width)" pin the RealLive `module_str`
  half/full-width semantics — these are the documented Shift-JIS
  hantozen/zentohan conversions per RLDEV and assume a Shift-JIS code
  unit. Siglus strings are UTF-16LE and its width-conversion ops live
  under a different opcode family with different IDs; the conversion
  table does not transfer. The substrate carrier that DOES carry is the
  rng-determinism path: `rnd` seeded from the substrate `LogicalClock`
  and the rng-state round-trip through `SnapshotStore` are facade
  surfaces a Siglus port reuses unchanged. The `module_str` /
  `module_mem` opcode-table identifiers themselves are RealLive-only.

- **UTSUSHI-213** (system-call dispatch) — _RealLive-only Gameexe
  route convention; substrate SnapshotStore + EnginePort lifecycle
  carry._ The acceptance criteria naming the `9999,NN`-style
  `(scene_id, entrypoint)` route addressing and the Gameexe dispatch-table
  keys (`SYSTEMCALL_SAVE=9999,20`, `SYSTEMCALL_LOAD=9999,21`,
  `CANCELCALL=9999,10`, the `WBCALL.NNN` window-button callbacks, etc.,
  per §H) pin a RealLive-only Gameexe convention: the syscom handlers
  live as real bytecode in scene `9999` and are reached through that
  `(scene_id, entrypoint)` table. Siglus's equivalent routes through
  dotted `Resource.txt` keys with a different routing shape; neither the
  key names nor the scene-id convention transfer. The substrate carriers
  that DO carry are the `SnapshotStore` backing the save/load syscom
  routes (§M.1, UTSUSHI-208) and the `EnginePort` lifecycle stages
  (Launch / Observe / Capture / Shutdown, §M.1 port-shape row) the
  system-call surface plugs into — a Siglus port reuses those facade
  surfaces but populates the dispatch table from its own config source.

- **UTSUSHI-214** (graphics object stack) — _rlvm 256-object stack
  model RealLive-only; FrameArtifactSink carries._ The acceptance
  criteria "allocating 256 objects … → deterministic PNG bytes" and
  "the render pass observes `SCREENSIZE_MOD=999,1280,720`" pin the
  rlvm-derived `GraphicsSystem` shape: a ~256-slot foreground+background
  object stack with per-object `(position, scale, alpha, colour_tone,
image_ref, layer_order)` state, and a RealLive Gameexe
  `SCREENSIZE_MOD` convention. Siglus's compositor uses a different
  object/layer model and a different framebuffer-dimension source. The
  substrate carrier (`FrameArtifactSink` + the deterministic-PNG
  `FrameArtifact` envelope carrying `frame_index`, `evidence_tier=E1`,
  and a PNG `artifact_id`) is reusable across engines; the 256-object
  stack model and the `SCREENSIZE_MOD` key are RealLive-only.

- **UTSUSHI-215** (module*grp + module_obj graphics opcodes) —
  \_RealLive-only opcode byte-codes; substrate VFS + render sink carry.*
  The acceptance criteria naming the rlvm `module_grp` /
  `module_obj_management` / `module_obj_fg_bg` opcode catalogue
  (`allocDC`, `wipe`, `shake`, `fade`, `objAlloc`, `objSetPos`,
  `objSetAlpha`, `objSetLayer`, etc.) pin RealLive's opcode-table
  byte-codes, and "`openBg("BG01A1")` reads
  `$GAME/REALLIVEDATA/g00/BG01A1.g00`" pins the RealLive
  `REALLIVEDATA/g00` asset layout. Siglus's graphics machinery uses a
  different opcode family and a different asset-tree layout; neither the
  opcode IDs nor the path transfer. The substrate carriers that DO carry
  are the VFS read path and the render/`state_snapshot` sink through
  which mutations of the (RealLive) graphics object stack are observed —
  a Siglus port reuses those facade surfaces but populates them from its
  own opcode dispatch table.

- **UTSUSHI-216** (g00 image decoder) — _RealLive-only._ g00 types 0,
  1, 2 with the type-2 region-list sub-format is a RealLive-exclusive
  asset format. A Siglus port carrying the substrate `FrameArtifactSink`
  is reusable; the image decoder is not. The acceptance criterion
  "type 2 decoded files expose a `regions: Vec<G00Region>`" does not
  port — Siglus has no equivalent region-list image format.

- **UTSUSHI-217** (NWA + OVK audio decoders) — _RealLive-only audio
  formats; substrate AudioEventSink carries._ The acceptance criteria
  "NWA decoder returns 33,818,820 sample frames" and "OVK decoder
  returns 2 entries with `(sample_num=46, sample_num=52)`" are
  RealLive-byte-specific. The substrate `AudioEvent` payload shape
  (with `event_kind`, `cue_id`, `source_asset`) is reusable; the
  decoder layer is not. Siglus's audio path emits the same
  `AudioEvent` envelope from its own (different) decoders. Sub-sample
  addressing for voice cues (`(archive_id, sample_id)` for RealLive's
  OVK) is RealLive-specific; the substrate's audio facade still has
  the open gap UTSUSHI-146 § K.3 flagged.

- **UTSUSHI-218** (`AVG_SYSTEM_SAVE` / `AVG_GLOBAL_SAVE` / read flags) —
  _RealLive-only on-disk format; substrate SnapshotStore carries._ The
  substrate `SnapshotStore` is reusable as the in-memory backing for
  save state on both engines; the on-disk serialiser differs. The
  acceptance criterion naming "`AVG_SYSTEM_SAVE` magic at byte 0x18"
  and the file sizes does not port to Siglus.

### M.4 Cross-engine conformance fixture (UTSUSHI-147)

The cross-engine conformance fixture promised by UTSUSHI-147 is
realised at the **scaffold-contract level** by
`crates/utsushi-siglus/tests/cross_engine_substrate_alignment.rs`.
The fixture co-loads `UtsushiReallivePort` and `UtsushiSiglusPort` (the
latter promoted into a real sibling crate by UTSUSHI-147 — see §M.7
below) through the substrate facade only, and:

1. **Compile-time witnesses both `EnginePort` bounds.** A generic
   helper function constrains both ports to the facade's `EnginePort`
   trait — if a future substrate refactor splits the trait, this file
   fails to compile, blocking the substrate API drift from landing
   without a paired conformance update.
2. **Pins manifest-shape equality across engines.** Both ports
   declare identical `REQUIRED_LIFECYCLE_STAGES`, identical
   `PortCapability` sets, identical `EvidenceTier::E1` /
   `FidelityTier::TraceOnly` ceilings, and identical `abi_version` —
   asserted through facade-typed accessors only.
3. **Pins shared VFS / render / snapshot facade carriers.** Both
   ports' inert contexts expose an `Option<Arc<dyn AssetPackage>>`
   slot (VFS), both `EnginePort::sink_set()` calls return the
   facade's `SinkSet` with three drains over facade-typed events
   (`TextLine`, `FrameArtifact`, `AudioEvent`), and the facade's
   `take_snapshot` free function is named through the cross-engine
   fixture so a facade-level drop fails compilation.
4. **Source-scans both scaffolds' `lib.rs` for `utsushi_core::*`
   imports.** The audit asserts (a) neither scaffold reaches a
   forbidden subsystem root (`vfs`, `port`, `clock`, etc. directly);
   (b) the `utsushi_core::CaptureOutcome` crate-root reach-around is
   symmetric across engines (omission is shared); (c) the Siglus
   scaffold's facade-leaf import set matches a hard-coded
   cross-engine baseline AND the RealLive scaffold reaches every
   baseline leaf — proving the alignment is bidirectional.
5. **Pins the substrate-API-drift regression coverage.** Any future
   change to the substrate facade that affects a symbol the
   cross-engine fixture touches will fail the identical-imports
   audit, surfacing the drift as a semantic diagnostic ("RealLive
   scaffold lost facade leaf `X` from the cross-engine baseline")
   rather than as a silent scaffold-out-of-sync regression.

### M.5 Substrate-gap candidates flagged for Siglus extension

The three substrate-gap candidates UTSUSHI-146 § K.3 flagged for the
RealLive port are revisited here under the Siglus reuse lens:

1. **Per-frame artifact emission cadence.** RealLive's text-display /
   choice-display / effect-cluster frame boundaries are scene-stream
   boundaries; Siglus has the same logical-frame concept (its `wipe`
   / `bgload` / `objSetPos` analogues map to the same
   `FrameArtifactSink::emit_frame` cadence). The gap is shared.
2. **Voice-archive sub-sample addressing.** RealLive's OVK
   `(archive_id, sample_id)` shape does NOT carry to Siglus, which
   uses a different voice-archive format. The substrate gap (a
   typed `(archive_id, sample_id)` payload on `AudioEvent`) is
   real, but the carrier semantics differ across engines — the gap
   is engine-shared in shape but not in addressing.
3. **Snapshot of the longop scheduler.** RealLive's mid-`select` /
   mid-`pause` longop save points (e.g. `SAVEPOINT_SELCOM=1`) have
   direct Siglus analogues (Siglus VMs ship with the same
   scene-stream-pausing longop concept). The substrate gap is
   engine-shared.

### M.6 Provenance

- AVG32 → RealLive lineage: documented in Visual Arts's own engine
  evolution history (publicly archived). The AVG32 LZSS + 256-byte
  XOR transform constant is identified in § E of this document and
  is the literal-shared substrate point. _[P]_
- RealLive → Siglus lineage: documented in Visual Arts's compiler
  evolution. The expression encoding, variable-bank shape (Siglus
  extends to 26 letters), `SystemCall` dispatch pattern, and choice
  family are direct descendants. The byte layouts differ; the
  shape carries. _[P]_
- Siglus-only post-RealLive additions: per-title `Scene.pck`
  encryption (engine-specific key profile), `Resource.txt`
  UTF-16LE config tree, `.pna` / `.pnp` image format family.
  _[P]_
- The `utsushi-siglus` minimal-port scaffold (promoted into a
  sibling crate by UTSUSHI-147; see §M.7) derives no source
  expression from siglus_rs or SiglusExtract or GARbro. The
  scaffold's behavioural surface is inert — every lifecycle method
  returns a typed `Unimplemented` Lifecycle error — so there is no
  reverse-engineered byte-decode logic to derive.

### M.7 Inline-scaffold-to-sibling-crate promotion (UTSUSHI-147)

UTSUSHI-221 first proved the substrate facade is engine-extensible at
the scaffold-contract level by **defining a Siglus minimal-port
scaffold inline** inside `utsushi-reallive`'s test crate. The
historical inline file
(`crates/utsushi-reallive/tests/cross_engine_facade_only_imports.rs`)
served as the alignment fixture and the substrate-API-drift regression
in the same place.

UTSUSHI-147 **promotes the inline scaffold into a real sibling crate**
at `crates/utsushi-siglus/`:

- The scaffold's `EnginePort` implementation, `UNIMPLEMENTED_MESSAGE`
  marker, `SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT` clean-room
  disclaimer, and `UtsushiSiglusPortContext` carrier all live as a
  proper `crates/utsushi-siglus/src/lib.rs` library now, with the
  same `#![forbid(unsafe_code)]` posture and the same
  `utsushi-core = { path = "../utsushi-core" }` direct dep the
  RealLive scaffold carries.
- The cross-engine conformance fixture moved to
  `crates/utsushi-siglus/tests/cross_engine_substrate_alignment.rs`.
  The fixture's dev-dep direction is `utsushi-siglus -> utsushi-reallive`
  (the second engine pulls in the first as a test-only co-loaded port)
  — never the reverse, so the project's RealLive-only alpha posture is
  not contaminated.
- The historical inline file is **deleted in the same change** as the
  sibling-crate landing, per the project's no-legacy-compat rule
  (`feedback_no_legacy_compat.md`). There is no parallel inline
  scaffold; the sibling crate is the canonical home, and the cross-engine
  fixture's name and location (UTSUSHI-147's
  `cross_engine_substrate_alignment.rs`) are the only valid anchor for
  future audits.
- Scaffold conformance and substrate-conformance tests for
  `utsushi-siglus` mirror the corresponding `utsushi-reallive` tests
  one-to-one (`tests/scaffold.rs` and `tests/substrate_conformance.rs`)
  so the per-port structural-smoke surface is identical across
  engines.

Lineage-extension port scope (AVG32 -> RealLive -> Siglus):

- **Extends:** every §M.1 reusable-across-engines surface (`AssetPackage`,
  `TextSurfaceSink`, `AudioEventSink`, `FrameArtifactSink`,
  `SnapshotStore`, `EnginePort`, `PortManifest`, `ReplayLog`,
  `Inspectable` + `Restorable`, expression encoding, variable banks
  with letter-extension to 26, AVG32 LZSS + 256-byte XOR foundation).
  The port scope therefore extends through the substrate facade and
  the AVG32-rooted format primitives that did not change across the
  Visual Arts engine generations.
- **Does NOT extend:** every §M.2 RealLive-only surface (10,000-slot
  Seen.txt directory, 0x1d0-byte scene header, RealLive bytecode
  lead-byte set, `module_msg` opcode catalogue, `module_jmp` opcode
  bytes, `select` family, g00 image format, NWA + OVK voice
  archives, AVG-derived save format, RealLive system-call route
  Gameexe convention, Sukara XOR-2 key research). A future
  behavioural Siglus port re-uses the substrate facade and ships its
  own byte-level decoders for `Scene.pck`, `Resource.txt`,
  `Gameexe.dat`, `.pna` / `.pnp`, and the per-title encryption
  scheme.
