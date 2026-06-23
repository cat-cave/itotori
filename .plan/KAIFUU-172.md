# KAIFUU-172 Implementation Plan — RealLive engine detector

| Field     | Value                                                                |
| --------- | -------------------------------------------------------------------- |
| Node id   | KAIFUU-172                                                           |
| Title     | RealLive engine detector                                             |
| Branch    | `spec/kaifuu-172`                                                    |
| Worktree  | `/scratch/worktrees/itotori-spec-kaifuu-172`                         |
| Author    | orchestrator (planner)                                               |
| Date      | 2026-06-23                                                           |
| Status    | planning — implementation worker not yet dispatched                  |
| Depends   | KAIFUU-006 (engine detection CLI), KAIFUU-034 (archive/encryption detection matrix) |
| Unblocks  | KAIFUU-173 (Scene/SEEN parser-boundary), KAIFUU-174 (text inventory adapter), UTSUSHI-146 (native runtime port) |

This plan is **planning only**. No Rust feature code is included; illustrative
sketches use `// pseudo-code` comments and short signatures. The implementation
worker who picks up this scope must follow `docs/kaifuu-engine-playbook.md` and
`docs/kaifuu-fixture-policy.md` end-to-end, then satisfy the audit focus listed
in the DAG node.

---

## 1. Module placement

The detector follows the **KAIFUU-006 registry pattern** that already hosts
`FixtureAdapter`, `Xp3ProfileDetectorAdapter`, and `SiglusProfileDetectorAdapter`
in `crates/kaifuu-engine-fixture/src/lib.rs`. RealLive joins as a sibling
detector adapter; the archive-matrix row joins the `ArchiveDetectionReport`
fan-out in `crates/kaifuu-core/src/lib.rs`.

Concrete placements:

- `crates/kaifuu-engine-fixture/src/lib.rs`
  - New struct `RealLiveProfileDetectorAdapter` next to
    `SiglusProfileDetectorAdapter` (around the existing trailing
    `impl EngineAdapter for SiglusProfileDetectorAdapter` block).
  - New constants alongside existing fixture constants:
    - `pub const REALLIVE_DETECTOR_ADAPTER_ID: &str = "kaifuu.reallive";`
    - `REALLIVE_GAMEEXE_PATH = "Gameexe.ini"` (case-insensitive lookup)
    - `REALLIVE_SEEN_TXT_PATH = "SEEN.TXT"`
    - `REALLIVE_SEEN_GAN_PATH = "SEEN.GAN"` (optional; absence is allowed)
    - Synthetic fixture magics, e.g. `REALLIVE_SCENE_MAGIC = b"REALLIVE-SCENE"`,
      `REALLIVE_GAMEEXE_INI_MAGIC = b"# RealLive Gameexe.ini fixture"`,
      `REALLIVE_SEEN_TXT_MAGIC = b"SEEN\x01"` (see §3 for the signature
      catalog and §8 for fixture rules).
    - `REALLIVE_PROFILE_ID = "019ed000-0000-7000-8000-000000172001"` (UUIDv7
      seed style matching KAIFUU-091 Siglus pattern).
    - `REALLIVE_GAME_ID = "kaifuu-reallive-synthetic-scene-seen"`.
    - `REALLIVE_SUPPORT_BOUNDARY = "RealLive detector profile identifies synthetic SEEN.TXT/Gameexe.ini/Scene fixtures for identify and (in a single later slice) profile/asset-inventory only; parser, extraction, decryption, patch-back, and runtime support are not claimed."`
  - Adapter struct: `pub struct RealLiveProfileDetectorAdapter;`
  - `pub fn registry()` (existing) appends
    `registry.register(RealLiveProfileDetectorAdapter);`.

- `crates/kaifuu-core/src/lib.rs`
  - Extend the `ArchiveEngineFamily` enum with `RealLive` (snake-case
    `reallive`).
  - Add a sibling free function `fn detect_reallive(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow`
    next to `detect_siglus`, and add it to the row vec in
    `ArchiveDetectionReport::scan()`.
  - Extend `ArchiveDetectionScan` with whatever lightweight aggregates the
    RealLive row needs (`seen_txt_count`, `gameexe_ini_count`, RealLive-specific
    archive extension counts) — see §3.

- Reason for the split: KAIFUU-034 owns the **aggregate, no-claim
  archive-detection matrix row** (counts + signals + diagnostics, no parsing).
  KAIFUU-006 owns the **`EngineAdapter` detector entry** that reads
  per-file signatures and emits a per-adapter `DetectionResult`. Both must
  exist for parity with Siglus / XP3, both must agree on RealLive identity,
  and both must remain "identify only" — no extraction / parser claims.

No new crate. Adding a `kaifuu-reallive` crate is a KAIFUU-173/174 concern;
KAIFUU-172 stays inside the established `kaifuu-engine-fixture` /
`kaifuu-core` boundary so the detector ships without a workspace re-layout.

---

## 2. Signature catalog

All signals are observable from public format documentation and from any owned
RealLive game's file layout. **rlvm is read only as a research anchor** to
confirm a hypothesis after it's been independently derived from observable
behavior (see §9, clean-room provenance).

### 2.1 SEEN.TXT — primary RealLive script archive

- **Filename**: `SEEN.TXT` at the game root (sometimes `Seen.txt`; lookup is
  case-insensitive on lowercased file-name buckets, matching the existing
  `ArchiveDetectionScan.file_name_count` pattern).
- **Header magic**: `SEEN.TXT` is itself an archive that begins with the
  ASCII bytes `SEEN` followed by a little-endian table-of-contents header.
  Reference: AVG32/RealLive `SEEN.TXT` format is publicly documented at
  the RLDEV / Haeleth's RealLive site
  (`https://dev.haeleth.net/rldev.shtml` and the RLDEV source tarball, which
  is research-only; cite as format observation, never copy expression). RLVM
  also documents the format in its `src/libreallive/archive.h` header — read
  for confirmation only, do not copy expression.
- **Decisive evidence**: presence of a file named `SEEN.TXT` whose first
  bytes look like a RealLive scene-index header (specifically the
  little-endian count + offset table shape). The detector does NOT parse the
  index; it only confirms the first 8 bytes can be read as a non-zero
  scene count below an observed sanity ceiling, and that the count×N + base
  fits inside the file length.
- **Synthetic fixture marker**: for public CI we use
  `REALLIVE_SEEN_TXT_MAGIC = b"SEEN\x01"` followed by a single scene entry
  pointing at a tiny payload (see §8). The signature check accepts both the
  generic real-shape envelope AND the synthetic envelope for public CI;
  real-game evidence is exercised at the ALPHA-006 vertical.

### 2.2 SEEN.GAN — RealLive animation script archive (optional, but RealLive-specific)

- **Filename**: `SEEN.GAN` at game root. Optional (some titles omit it);
  presence is **corroborating**, not decisive.
- **Provenance**: the `.GAN` extension is the documented RealLive animation
  script format. AVG32 (the lineage predecessor) does **not** ship a
  `SEEN.GAN`; Siglus uses `Scene.pck` / `Gameexe.dat` / `*.g00` and has no
  `SEEN.*` files at all.
- **Decisive role**: SEEN.GAN presence + SEEN.TXT presence is **highly
  RealLive-specific**, used to disambiguate from AVG32 in the rare overlapping
  case where AVG32 might also expose a `SEEN.TXT`-shaped archive (see §4).

### 2.3 Gameexe.ini — RealLive configuration manifest

- **Filename**: `Gameexe.ini` at game root (case-insensitive). This is plain
  ASCII / Shift-JIS INI-style content. (Distinct from Siglus's
  `Gameexe.dat`, which is binary.)
- **Header signal**: ASCII text starting with `#` comment lines or a
  `#GAMEEXE_VERSION=...` line. Public format reference: RLDEV's
  `gameexe.txt` documentation and the RealLive engine documentation
  archived on Haeleth's site enumerate the canonical key set.
- **RealLive-specific keys** to look for in the first ~64 KiB (sampled, not
  parsed exhaustively at detection time):
  - `#REGNAME=` — registry path used by the RealLive Windows launcher.
  - `#GAMEEXE_VERSION=` — version marker; RealLive titles set this. AVG32
    has its own `Gameexe.dat` lineage and does not consistently emit
    `#GAMEEXE_VERSION` in a plaintext INI.
  - `#SEEN_PATH=` (or `#SEEN.TXT=`) — explicit RealLive archive reference.
  - `#G00BUF=` / `#G00CACHE=` — references to RealLive's `.g00` image
    format (RealLive-specific).
  - `#KOEPAC=` / `#KOEDIR=` — RealLive voice-archive references.
  - `#TITLE=` and `#CAPTION=` in Shift-JIS — present in RealLive Gameexe.ini
    but not decisive on their own (Siglus and others use similar keys).
- **Decisiveness**: `#GAMEEXE_VERSION=`, `#REGNAME=`, or any `#G00*=` /
  `#KOE*=` key is **decisive RealLive evidence** when combined with at
  least one of {SEEN.TXT envelope, SEEN.GAN, `.g00` extension presence}.
  Plain `Gameexe.ini` alone (no keys, no SEEN.TXT) is **ambiguous**.

### 2.4 Engine-specific archive markers

- **`.g00` extension** — RealLive's image format. AVG32 used `.PDT`; Siglus
  uses `.g00` only in narrow legacy cases and prefers packed containers.
  `.g00` is corroborating evidence, decisive when combined with SEEN.TXT.
- **`.ovk` and `.koe` (or `.nwk`)** — RealLive voice/koe archives.
  RealLive-specific. AVG32 does not ship `.ovk`/`.koe`/`.nwk`; Siglus uses
  `.OVK` rarely but typically routes voice through `.pck`.
- **`.GAN` extension** — RealLive animation; present in SEEN.GAN archive
  index but also as standalone files in some titles.
- **`.PDT`** — AVG32 image format. Presence of `.PDT` alongside a SEEN-shaped
  archive shifts identification toward AVG32, not RealLive. (RealLive titles
  do not ship `.PDT`.)
- **`Scene.pck` / `Gameexe.dat`** — Siglus markers (already detected by
  `detect_siglus`). Presence of either of these in the same root with
  RealLive markers triggers `kaifuu.ambiguous_engine_variant` (see §4).

### 2.5 Scene format / bytecode shape (used as a corroborating signal only)

- RealLive Scene bytecode opens with a documented header (entrypoint table,
  version word, opcode table layout) different from Siglus's RLSL/Scene.pck
  layout. The KAIFUU-172 detector does **not** decode opcodes; that belongs
  to KAIFUU-173.
- Decision: KAIFUU-172 only checks the first ~16 bytes of SEEN.TXT's
  embedded scene blob for the RealLive header magic — enough to disprove a
  Siglus mis-id without claiming any parsing capability.

### 2.6 Citations and provenance summary

| Source                                                                                     | Use                                                       | License posture                                        |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| Haeleth's RealLive / RLDEV site (`https://dev.haeleth.net/rldev.shtml`)                    | SEEN.TXT envelope, Gameexe.ini keys, opcode taxonomy      | research-only; cite as public format archaeology       |
| RLDEV source tarball                                                                       | confirm hypotheses; do not copy expression                | clean-room; GPL-incompatible — do not import any code  |
| rlvm (`https://github.com/eglaysher/rlvm`) — `src/libreallive/archive.{h,cc}`, `gameexe.cc` | confirm format observations after independent derivation | research-only; GPLv3+ — never link, never copy         |
| Owned RealLive title file listings (private-local)                                         | corroboration only                                        | private-local; only redacted aggregate notes allowed   |
| ALPHA-006 vertical fixture (Sweetie HD Remaster + Sweets) at `/archive/vault/`             | real-game validation later in the chain                   | vault read-only adapter (`docs/itotori-vault-source-adapter.md`); not invoked at KAIFUU-172 |

---

## 3. Disambiguation algorithm

The detector evaluates RealLive identity in a deterministic, evidence-counting
order. There is **no LLM-style confidence**; the algorithm is a small finite
state machine over presence/absence and signature-validity counts. The shape
matches existing `detect_siglus` / `Xp3FixtureVariant` patterns.

### 3.1 Inputs (per `Self::inspect(game_dir)`)

```
struct RealLiveFixtureState {
    seen_txt_exists: bool,
    seen_txt_envelope_ok: bool,        // first bytes look like SEEN envelope
    seen_gan_exists: bool,
    gameexe_ini_exists: bool,
    gameexe_ini_keys: GameexeIniKeyHits, // bitset of {#GAMEEXE_VERSION, #REGNAME, #G00*, #KOE*, #SEEN*}
    g00_count: u64,
    ovk_koe_nwk_count: u64,
    // Disambiguation negatives:
    siglus_scene_pck_present: bool,    // Scene.pck
    siglus_gameexe_dat_present: bool,  // Gameexe.dat
    avg32_pdt_count: u64,              // *.PDT presence count
    // Hashes for downstream profile reuse:
    seen_txt_hash: Option<String>,
    gameexe_ini_hash: Option<String>,
}
```

### 3.2 Variant resolution

```
enum RealLiveFixtureVariant {
    CompleteSyntheticTriple,    // SEEN.TXT envelope OK + Gameexe.ini with key hits + at least one corroborating archive marker
    PositiveLiveLayout,         // SEEN.TXT envelope OK + Gameexe.ini RealLive-specific key + no Siglus markers and no AVG32 PDT
    Ambiguous,                  // RealLive markers AND Siglus markers OR AVG32 PDT markers
    UnsupportedAvg32Lineage,    // SEEN.TXT envelope OK BUT *.PDT corroborates AVG32 lineage (no RealLive-specific Gameexe.ini keys)
    UnknownEngineVariant,       // SEEN.TXT envelope NOT OK; OR no Gameexe.ini; OR signature signals contradict
    NotRealLive,                // no SEEN.TXT, no Gameexe.ini, no engine-specific archive markers
}
```

### 3.3 Decision table

| State                                                                                                                                                                | Variant                       | `detected` | Diagnostic                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------- | ------------------------------------------ |
| Synthetic SEEN.TXT magic + synthetic Gameexe.ini magic present (public-CI fixture)                                                                                   | `CompleteSyntheticTriple`     | true       | none                                       |
| Real-shape SEEN.TXT envelope + Gameexe.ini contains at least one of {#GAMEEXE_VERSION, #REGNAME, #G00*, #KOE*} + no Siglus markers + no `.PDT`                       | `PositiveLiveLayout`          | true       | none                                       |
| RealLive markers present AND (Siglus `Scene.pck` or `Gameexe.dat` present)                                                                                           | `Ambiguous`                   | false      | `kaifuu.ambiguous_engine_variant`          |
| SEEN.TXT envelope present AND `.PDT` count > 0 AND no RealLive-specific Gameexe.ini keys                                                                             | `UnsupportedAvg32Lineage`     | false      | `kaifuu.unsupported_engine_variant`        |
| SEEN.TXT envelope invalid OR Gameexe.ini missing/empty but RealLive marker names exist                                                                               | `UnknownEngineVariant`        | false      | `kaifuu.unknown_engine_variant`            |
| No SEEN.TXT, no Gameexe.ini, no RealLive marker extensions                                                                                                           | `NotRealLive`                 | false      | none (silently not-detected)               |

### 3.4 Decisive vs. corroborating

- **Decisive (positive ID)**: SEEN.TXT envelope-valid + Gameexe.ini with at
  least one RealLive-specific key, AND no Siglus / AVG32 negatives. Both
  legs are required; neither alone flips `detected = true`.
- **Corroborating (raise confidence into positive when paired with one of
  the two decisive legs)**: SEEN.GAN presence, `.g00` count > 0,
  `.ovk`/`.koe`/`.nwk` presence, additional RealLive Gameexe.ini keys.
- **Disqualifying (force non-positive)**: any Siglus marker
  (`Scene.pck`/`Gameexe.dat`) co-present forces `Ambiguous`; any `.PDT`
  count > 0 without RealLive-specific Gameexe.ini keys forces
  `UnsupportedAvg32Lineage`.

### 3.5 Why this works against the Siglus / AVG32 / RealLive lineage

All three engines share VM roots, but their **on-disk shape diverges**:

- AVG32 → `.PDT` images, no Gameexe.ini in INI form, no SEEN.GAN. Some
  AVG32 titles use a `SEEN.TXT`-named archive — that overlap is exactly
  what `UnsupportedAvg32Lineage` catches.
- RealLive → `SEEN.TXT` + `Gameexe.ini` (INI) + `.g00` + (optional)
  SEEN.GAN + `.ovk`/`.koe`/`.nwk`.
- Siglus → `Scene.pck` + `Gameexe.dat` (binary) + packed voice; rarely
  `.g00`. The Siglus detector already exists; KAIFUU-172 reuses
  `ArchiveDetectionScan.file_name_count("scene.pck")` /
  `file_name_count("gameexe.dat")` to cross-check.

The detector is purely static; no helper, no Wine, no rlvm subprocess.

---

## 4. Integration with the KAIFUU-006 registry

### 4.1 `EngineAdapter` impl

`RealLiveProfileDetectorAdapter` implements `EngineAdapter` from
`kaifuu_core` with the same shape as `SiglusProfileDetectorAdapter`:

- `id()` → `"kaifuu.reallive"` (constant `REALLIVE_DETECTOR_ADAPTER_ID`).
- `name()` → `"Kaifuu RealLive detector profile fixture adapter"`.
- `capabilities()` → `AdapterCapabilities` with:
  - `Detection`, `ProfileGeneration`, `AssetListing`, `AssetInventory`
    marked `Supported`.
  - `Extraction`, `Patching`, `ContainerAccess`, `CryptoAccess`,
    `CodecAccess`, `PatchBack`, `RuntimeVm`, `EncryptedInput`,
    `AssetTextPatching`, `DeltaPatching`, `NonTextSurfaceExtraction`
    marked `Unsupported` with `REALLIVE_SUPPORT_BOUNDARY` text.
  - `KeyProfile` marked `RequiresUserInput` only if a future encrypted
    variant is detected; the alpha-vertical title (Sweetie HD) is **not
    encrypted at the script layer**, so the default capability is
    `not_required`. RealLive's `.ovk` voice archives may carry simple
    obfuscation; that's a KAIFUU-174 concern, not KAIFUU-172.
  - `access_contract` (`LayeredAccessCapabilityContract`):
    - `identify` → `Supported`, surfaces `Identity`, containers
      `LooseFile`, crypto `Unknown`, codec `Unknown`. (No new
      `ContainerTransform::RealLiveSeen` is introduced in this node; the
      identify slice doesn't need to claim a parser-level container
      variant. If KAIFUU-173 adds one, it's a follow-on.)
    - `inventory` → `Supported` with the same surfaces, limited to top-level
      file inventory.
    - `extract`, `patch` → `Unsupported`.
- `detect(request)` → fills `DetectionResult` exactly like Siglus's:
  - `adapter_id`, `detected` from the variant table, `engine_family =
    Some("reallive")` when detected, `detected_variant` set for both
    positive and diagnostic-only paths, `evidence` rows for SEEN.TXT,
    Gameexe.ini, SEEN.GAN, `.g00` count, `.ovk/.koe/.nwk` count, and the
    Siglus / AVG32 cross-check counts (Informational status), plus
    requirements list and capability reports.
- `profile`, `list_assets`, `asset_inventory` mirror the Siglus pattern:
  emit only when the variant is `CompleteSyntheticTriple` or
  `PositiveLiveLayout`; otherwise return semantic
  `AdapterFailure::semantic(...)`.
- `extract`, `patch`, `patch_preflight`, `verify` always return semantic
  unsupported failures (`SemanticErrorCode::UnsupportedLayeredTransform`
  with `Capability::CodecAccess` or `Capability::Patching`) — extraction is
  KAIFUU-174 territory.

### 4.2 Archive-detection matrix row

In `crates/kaifuu-core/src/lib.rs`:

- Add `ArchiveEngineFamily::RealLive` (serde rename: `"reallive"`).
- Add `fn detect_reallive(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow`.
- Aggregate evidence rows:
  - `FileName / "SEEN.TXT"` count
  - `FileName / "SEEN.GAN"` count
  - `FileName / "Gameexe.ini"` count
  - `FileExtension / "*.g00"` count
  - `FileExtension / "*.ovk"` + `*.koe` + `*.nwk` aggregate count
  - `FileExtension / "*.pdt"` count (informational; corroborates AVG32
    lineage)
- Signals: `Packed` when SEEN.TXT is found (it is an archive); the matrix
  row otherwise reports only aggregate counts and `UnknownVariant` when
  signals are mixed.
- `support_boundary`: `"Kaifuu detects RealLive SEEN.TXT/Gameexe.ini/Scene container signals only; extraction, Scene/SEEN decompilation, voice-archive handling, and patch-back remain outside this matrix row."`
- Add `detect_reallive(&scan)` to the row vec in
  `ArchiveDetectionReport::scan()` alongside the other detectors.

### 4.3 Registry wiring

Extend `crates/kaifuu-engine-fixture/src/lib.rs`'s `pub fn registry()`:

```rust
pub fn registry() -> kaifuu_core::AdapterRegistry {
    let mut registry = kaifuu_core::AdapterRegistry::new();
    registry.register(FixtureAdapter);
    registry.register(Xp3ProfileDetectorAdapter);
    registry.register(SiglusProfileDetectorAdapter);
    registry.register(RealLiveProfileDetectorAdapter);   // <-- new
    registry
}
```

`AdapterRegistry::register` already sorts by `id()`, so insertion order
doesn't affect determinism.

---

## 5. CLI surface

The node deliverable mentions "capability report integration via the engine
detection CLI." This **does not redesign the CLI**; it extends what already
works.

- `cargo run -p kaifuu-cli -- detect <game-dir>` already calls
  `engine_registry()` (`crates/kaifuu-cli/src/main.rs:870-871`) and walks all
  registered adapters via `AdapterRegistry::detect_all` (then
  `DetectionReport::from_results`). Registering
  `RealLiveProfileDetectorAdapter` automatically surfaces a per-adapter row
  in the detection JSON.
- The `archiveDetection` matrix already appears in the same `detect`
  output. Adding the `detect_reallive` row gives RealLive a matrix row with
  aggregate evidence, support boundary, and diagnostics next to Siglus /
  XP3 / RPG Maker / Wolf / BGI / Ren'Py / Unknown.
- `cargo run -p kaifuu-cli -- capabilities --output ...` already iterates
  `engine_registry().adapters()` and emits each adapter's
  `capabilities()` payload; the RealLive entry shows up automatically with
  the `identify`/`inventory`/`extract`/`patch` quad.
- `cargo run -p kaifuu-cli -- profile init <game-dir>` will route into the
  RealLive adapter when it detects, and return semantic failure for
  diagnostic-only states (matching Siglus's behavior at
  `crates/kaifuu-engine-fixture/src/lib.rs:3041-3083`).

The CLI surface change is **zero new subcommands, zero new flags**. The
existing dispatch path picks up the new adapter via the registry.

CLI test additions (in `crates/kaifuu-cli/src/main.rs`'s existing test
module):

- `detect_cli_reports_reallive_adapter_on_synthetic_fixture`
- `detect_cli_emits_ambiguous_engine_variant_when_reallive_and_siglus_markers_co_present`
- `detect_cli_archive_detection_matrix_contains_reallive_row`
- `capabilities_cli_lists_reallive_adapter_with_identify_only_support_boundary`

---

## 6. Readiness record draft

The implementation worker ships this readiness record alongside the code, in
`docs/kaifuu-adapters/reallive.md` (the playbook says the location may live
in adapter README, a future `docs/kaifuu-adapters/<engine>.md`, or another
tracked document; we standardize on the second form so KAIFUU-174 inherits
the file).

```md
# RealLive Adapter Readiness Record

- Roadmap node: KAIFUU-172 (detector); successor scopes KAIFUU-173 (Scene/SEEN parser-boundary smoke), KAIFUU-174 (text inventory adapter), UTSUSHI-146 (runtime port). KAIFUU-172 establishes only the identify/inventory boundary.
- Owner: kaifuu engine-research track
- Adapter id: `kaifuu.reallive`
- Crate or module: `kaifuu-engine-fixture` (struct `RealLiveProfileDetectorAdapter`); archive-matrix row in `kaifuu-core`. A dedicated `kaifuu-reallive` crate is deferred to KAIFUU-173/174 once the parser/extractor lands.
- Engine family: RealLive (VisualArt's / Key — same VM lineage as AVG32 and Siglus, but distinct on-disk shape).
- Supported versions and variants: synthetic detector fixtures only at this slice. Real-game disambiguation is exercised in CI through synthetic positive + Siglus-cross / AVG32-cross negative fixtures; real RealLive titles (including the ALPHA-006 vertical Sweetie HD Remaster + Sweets) become positive evidence after KAIFUU-172 ships and are exercised at ALPHA-006.
- Explicitly excluded versions and variants:
  - AVG32 (`.PDT`-bearing or Gameexe.dat-bearing scenes) → semantic `kaifuu.unsupported_engine_variant`.
  - Siglus (`Scene.pck`/`Gameexe.dat`) → routes to the Siglus detector; co-presence with RealLive markers → `kaifuu.ambiguous_engine_variant`.
  - Encrypted SEEN.TXT or protected Gameexe variants → outside KAIFUU-172; future encrypted RealLive support is a separate node and requires a key-profile boundary review.
- Initial support boundary: **identify and inventory only**. The detector reads top-level file presence, signature bytes for SEEN.TXT and synthetic Gameexe.ini, archive marker extension counts, and the Siglus/AVG32 cross-checks. No Scene/SEEN parsing, no extraction, no patching, no runtime.
- Unsupported or gated boundary: Scene/SEEN bytecode decode, `.koe`/`.nwk`/`.ovk` voice extraction, `.g00` image rebuild, Gameexe.ini patch-back, RealLive VM replay. All return `kaifuu.unsupported_layered_transform` until KAIFUU-173 / KAIFUU-174 / UTSUSHI-146 land.
- Public fixture ids:
  - `reallive-positive-synthetic-triple` — synthetic SEEN.TXT envelope + synthetic Gameexe.ini + optional SEEN.GAN.
  - `reallive-negative-siglus-overlap` — synthetic Scene.pck + Gameexe.dat next to SEEN.TXT-like names; expects `kaifuu.ambiguous_engine_variant`.
  - `reallive-negative-avg32-lineage` — synthetic SEEN.TXT + `.PDT` files + no RealLive-specific Gameexe.ini keys; expects `kaifuu.unsupported_engine_variant`.
  - `reallive-negative-unknown-shape` — file names suggest RealLive but signatures invalid; expects `kaifuu.unknown_engine_variant`.
  - `reallive-negative-not-reallive` — `fixtures/hello-game` re-used as a known non-match (detector returns silent non-detection, no diagnostic).
- Public fixture source class: synthetic (we generate them; license-clean).
- Fixture generation or source URL: shipped via the test module's
  `reallive_fixture_dir(...)` helper, modeled on `siglus_fixture_dir(...)`
  at `crates/kaifuu-engine-fixture/src/lib.rs:4945-4990`.
- Fixture license and attribution: synthetic, public domain. No retail
  bytes, no `/archive/vault/` access in KAIFUU-172 (vault-source adapter
  is read-only and is exercised at ALPHA-006, not at the detector node).
- Raw fixture file hashes: computed deterministically by the test helper
  and recorded in `fixtures/public/reallive-detector.manifest.json`
  through the `just fixtures-validate` gate.
- Positive fixture coverage: SEEN.TXT envelope detection, SEEN.GAN
  presence corroboration, Gameexe.ini RealLive-key detection, `.g00`
  corroboration, `.ovk`/`.koe`/`.nwk` corroboration, capability report
  shape, profile generation shape.
- Negative fixture coverage: Siglus overlap (ambiguous), AVG32 lineage
  (unsupported), unknown shape (unknown-engine-variant), not-RealLive
  (silent non-detection), missing-signal (Gameexe.ini absent but SEEN.TXT
  envelope present → unknown), corrupt SEEN.TXT envelope (envelope-invalid
  → unknown).
- Required round-trip artifacts: not applicable at KAIFUU-172 (detector
  only). Round-trip is KAIFUU-174's responsibility.
- Byte-identical or normalized equivalence rule: deferred to KAIFUU-174.
- Supported encodings and newline rules: Gameexe.ini is read as bytes,
  not decoded; detector matches ASCII prefixes only. Shift-JIS handling
  is a KAIFUU-174 concern.
- Text surfaces: deferred to KAIFUU-174.
- Patch modes: none (unsupported).
- Asset inventory surfaces: top-level files only (SEEN.TXT, SEEN.GAN,
  Gameexe.ini, `.g00`/`.ovk`/`.koe`/`.nwk` counts). No archive-entry
  inventory.
- Semantic capability errors:
  - `kaifuu.ambiguous_engine_variant` (new; see §10).
  - `kaifuu.unsupported_engine_variant` (new; see §10).
  - `kaifuu.unknown_engine_variant` (existing — used for SEEN-shaped but
    invalid envelope).
  - `kaifuu.unsupported_layered_transform` (existing — used for
    extract/patch/verify attempts on identify-only adapters, matching
    Siglus's pattern).
- Reference implementations and docs:
  - Haeleth's RealLive / RLDEV site — research anchor for format
    archaeology; **license posture**: research-only, no expression copied.
  - RLDEV source tarball — license posture: research-only, no expression
    copied; behavior-only clean-room.
  - rlvm (`https://github.com/eglaysher/rlvm`) — research anchor;
    **license posture: GPLv3+, incompatible with itotori's link/derivation
    posture. Behavior-only clean-room. No code copied, no headers
    included, no Cargo dependency.** See §9.
- License review decisions:
  - RLDEV / Haeleth site → `behavior-only-clean-room`.
  - rlvm → `behavior-only-clean-room`; explicit "do not copy / do not link"
    note in the code's module-level comment.
  - Format observations against the ALPHA-006 vault title → derived from
    publicly observable file layout; logged as `private-local-only`
    aggregate evidence at the ALPHA-006 vertical, not encoded into
    KAIFUU-172 code.
- Parser spike status: not applicable (no parsing in KAIFUU-172). Parser
  spike begins under KAIFUU-173.
- Private corpus labels and aggregate stats: Sweetie HD Remaster +
  Sweets fandisc — labels and aggregate file-count stats only; raw
  filenames, scene contents, and `.koe` bytes never leave private-local.
- Key profile requirements: none for the alpha-vertical title's SEEN.TXT
  / Gameexe.ini path. `.ovk`/`.koe` voice obfuscation is a KAIFUU-174 /
  KAIFUU-064 concern.
- Helper requirements: **none**. Per the playbook's per-game
  evidence-first rule, KAIFUU-172 ships as pure static detection. If a
  future claimed game proves static detection insufficient, that's a
  separate node — not part of KAIFUU-172.
- Remote helper status: not used; not planned for the detector.
- Local validation commands:
  - `cargo test -p kaifuu-core`
  - `cargo test -p kaifuu-cli`
  - `cargo run -p kaifuu-cli -- detect <fixture> --output .tmp/reallive/detect.json` (manual review)
  - `just fixtures-validate`
- CI validation commands: same as local, gated by `just check` / `just ci-kaifuu`.
- Known gaps and proposed P2/P3 follow-ups:
  - KAIFUU-173 — Scene/SEEN parser-boundary smoke.
  - KAIFUU-174 — text inventory adapter (Scene/SEEN/Gameexe text slots,
    protected markup, asset references, patch-back).
  - UTSUSHI-146 — native RealLive runtime port (rlvm research anchor).
  - Future encrypted RealLive variants — separate node; not in the
    alpha set.
```

---

## 7. Fixture plan

Fixtures follow `docs/kaifuu-fixture-policy.md`. They are synthetic, public,
license-clean, and small. Real-game evidence flows in at ALPHA-006, not
KAIFUU-172.

### 7.1 Layout

Under the **shared kaifuu public fixtures dir** (matching established
convention from KAIFUU-091's Siglus fixtures and KAIFUU-006's
`fixtures/hello-game`):

- `fixtures/public/reallive-detector/` — public fixture root.
  - `manifest.json` — matches `fixtures/public/manifest.schema.json`.
  - `positive-synthetic-triple/`
    - `SEEN.TXT` — starts with `REALLIVE_SEEN_TXT_MAGIC` = `SEEN\x01` + 4
      little-endian zero bytes + a single scene entry whose offset points
      inside the file; content is `"reallive synthetic fixture"`.
    - `Gameexe.ini` — starts with `REALLIVE_GAMEEXE_INI_MAGIC`
      = `# RealLive Gameexe.ini fixture` and contains
      `#GAMEEXE_VERSION=1.0` and `#REGNAME=KaifuuFixture\\RealLive` on
      subsequent lines.
    - `SEEN.GAN` — empty file with `REALLIVE_SEEN_GAN_MAGIC` = `GAN\x01`.
    - `image.g00` — single synthetic byte to trigger the `.g00`
      extension counter.
    - `voice.ovk` — single synthetic byte for `.ovk` counter.
  - `negative-siglus-overlap/`
    - `SEEN.TXT` + `Gameexe.ini` (RealLive-shape) plus `Scene.pck` and
      `Gameexe.dat` (Siglus markers) — expects `ambiguous_engine_variant`.
  - `negative-avg32-lineage/`
    - `SEEN.TXT` (synthetic envelope) plus `image.PDT` plus a Gameexe.ini
      **without RealLive-specific keys** (just comment lines, no
      `#GAMEEXE_VERSION`) — expects `unsupported_engine_variant`.
  - `negative-unknown-shape/`
    - `SEEN.TXT` whose first bytes are random non-magic bytes; Gameexe.ini
      present but empty — expects `unknown_engine_variant`.
  - `negative-not-reallive/`
    - Empty directory (or reuse `fixtures/hello-game` from the existing
      tests) — expects `detected = false` with no diagnostic (silent
      non-detection).
  - `corrupt-signals/`
    - `SEEN.TXT` truncated to 1 byte; `Gameexe.ini` present and well-formed
      — expects `unknown_engine_variant` (envelope invalid).

### 7.2 In-test fixture generation (alternative)

Following the SiglusProfileDetectorAdapter test pattern at
`crates/kaifuu-engine-fixture/src/lib.rs:4945-4990`, the detector tests
generate fixtures in `std::env::temp_dir()` via a helper
`reallive_fixture_dir(name, seen, gameexe, extras)`. This keeps tests
hermetic and matches existing convention.

**Decision**: ship **both** — temp-dir helpers for the per-test
adapter tests, AND a single `fixtures/public/reallive-detector/`
manifest with hashed positive + negative fixtures consumed by the CLI
test (`detect_cli_reports_reallive_adapter_on_synthetic_fixture`). The
public manifest is what `just fixtures-validate` validates; the temp-dir
helpers cover edge cases that don't justify dedicated public fixtures.

### 7.3 ALPHA-006 sequencing note

ALPHA-006 will exercise this detector against the real Sweetie HD bytes
from `/archive/vault/` via the read-only vault-source adapter
(`docs/itotori-vault-source-adapter.md`, KAIFUU-176). The detector must
work on synthetic fixtures **now**; real-game validation comes later in
the chain and does **not** block KAIFUU-172 acceptance. If the
real-vertical surfaces a disambiguation gap, that becomes a new node, not
a re-open of KAIFUU-172.

---

## 8. Clean-room provenance documentation

This section is **load-bearing** for both the implementation worker and the
auditor. rlvm's license (GPLv3+) is incompatible with itotori's permissive
posture **if linked or derived**. The implementation must remain
behavior-only / clean-room.

### 8.1 What we know about RealLive's on-disk format, and how

| Fact                                                          | How we know it                                                                                                                            | Where to cite                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| SEEN.TXT is an archive of scene blobs                         | Publicly archived RealLive format documentation (Haeleth's RLDEV site), confirmed by listing any RealLive title's `SEEN.TXT` size > scenes | docs only; do not lift any RLDEV code      |
| SEEN.TXT begins with a little-endian count + offset table     | Observable from raw bytes of any owned RealLive title (private-local observation only)                                                    | code comment cites publicly observable     |
| Gameexe.ini is INI-shaped with `#`-prefixed keys              | Observable from raw bytes; also documented on Haeleth's site                                                                              | code comment cites public archaeology      |
| RealLive-specific Gameexe.ini keys (#GAMEEXE_VERSION, #REGNAME, #G00*, #KOE*) | Documented on Haeleth's site; cross-verified against owned-title observation                                                              | docs/kaifuu-adapters/reallive.md citations |
| `.g00` image extension                                        | Documented on Haeleth's site; observable in any owned title                                                                               | citation in detector module comment        |
| `.ovk` / `.koe` / `.nwk` voice archive extensions             | Documented on Haeleth's site; observable in owned-title file listings                                                                     | citation in detector module comment        |
| AVG32 ships `.PDT` images and lacks Gameexe.ini in INI form   | AVG32 fan documentation and observable on owned AVG32 titles                                                                              | citation in detector module comment        |
| Siglus ships `Scene.pck` and `Gameexe.dat`                    | Already documented in this repo (`detect_siglus`, KAIFUU-091)                                                                             | in-repo cross-reference                    |

### 8.2 Implementation worker checklist (do NOT copy rlvm code)

The detector module's file header **must** include a comment with the
following clauses (verbatim or near-verbatim — wording can be polished, but
the listed clauses must all be present):

```rust
//! RealLive engine detector (KAIFUU-172).
//!
//! Clean-room provenance:
//! - All format observations are derived from publicly archived format
//!   documentation (Haeleth's RLDEV site) and from publicly observable file
//!   shape of owned RealLive titles. No source expression is copied from
//!   RLDEV or rlvm.
//! - rlvm (https://github.com/eglaysher/rlvm) is a research anchor only.
//!   Its license is GPLv3+ and is incompatible with itotori's distribution
//!   posture if linked or derived. This crate does NOT depend on rlvm,
//!   does NOT include rlvm headers, does NOT copy rlvm's structure layouts,
//!   and does NOT mechanically translate rlvm code into Rust. If a
//!   hypothesis about RealLive's format was confirmed by reading rlvm,
//!   the hypothesis is re-derived and re-tested against publicly
//!   observable bytes before being encoded here.
//! - This detector is identify-only. Extraction, decompilation, and
//!   patching live in KAIFUU-173/KAIFUU-174 (Kaifuu) and UTSUSHI-146
//!   (runtime port). All of those nodes inherit the same clean-room
//!   posture.
```

Implementation worker pre-merge checklist (auditor uses this verbatim):

- [ ] No `git submodule`, no Cargo dep, no vendored `rlvm` / RLDEV code.
- [ ] No copied opcode tables, no copied struct layouts, no copied
      lookup constants from rlvm. Constants (e.g. magic byte values, key
      names) come from public format archaeology and observable shape.
- [ ] Module-level provenance comment is present and accurate.
- [ ] No `Command::new("rlvm")`, no `std::process::Command` invocation
      of any foreign tool.
- [ ] Detector tests pass on a host with **no** rlvm installed.
- [ ] Synthetic fixtures contain no copyrighted RealLive bytes
      (no real scenes, no real Gameexe.ini values from any owned title).
- [ ] If the worker read rlvm to confirm a hypothesis, the readiness
      record's "Reference implementations and docs" entry records that
      fact with the file path that was consulted and the hypothesis that
      was confirmed, **without** importing rlvm's expression.

---

## 9. Semantic error catalog

KAIFUU-172 introduces two new semantic error codes and reuses three existing
ones. New codes follow the `kaifuu.*` convention and the
`docs/kaifuu-fixture-policy.md` shape (errorCode, engine, adapter,
detectedVariant, evidence/assetRef, supportBoundary, remediation).

### 9.1 New codes

| Code                                  | Variant trigger                                                                          | `engine`   | `adapter`         | `detectedVariant`                | `requiredCapability`  | `supportBoundary`                                                                                                     | `remediation`                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ---------- | ----------------- | -------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `kaifuu.ambiguous_engine_variant`     | RealLive markers present AND Siglus or AVG32 markers also present                        | `reallive` | `kaifuu.reallive` | `ambiguous-reallive-siglus` or `ambiguous-reallive-avg32` | `Detection`           | `RealLive detector requires unambiguous RealLive evidence; co-presence of Siglus or AVG32 markers blocks identification.` | `audit the input directory; remove or relocate cross-engine markers, or report the layout as a new engine variant.` |
| `kaifuu.unsupported_engine_variant`   | SEEN.TXT envelope present BUT `.PDT` present AND no RealLive-specific Gameexe.ini keys | `reallive` | `kaifuu.reallive` | `avg32-lineage-seen-txt`         | `Detection`           | `RealLive detector does not claim AVG32 lineage support; AVG32-shaped SEEN.TXT inputs are out of scope.`              | `add an AVG32-specific detector (separate node) before localizing this title.`           |

These two codes need entries added to `SemanticErrorCode` in
`crates/kaifuu-core/src/lib.rs` (around line 10456) and to its
`as_str()` / `to_string()` mapping. Both serde-rename to their stable
strings (`"kaifuu.ambiguous_engine_variant"` /
`"kaifuu.unsupported_engine_variant"`).

Also add string constants:
- `pub const SEMANTIC_AMBIGUOUS_ENGINE_VARIANT: &str = "kaifuu.ambiguous_engine_variant";`
- `pub const SEMANTIC_UNSUPPORTED_ENGINE_VARIANT: &str = "kaifuu.unsupported_engine_variant";`

### 9.2 Reused codes

| Code                                  | Variant trigger                                                              | Notes                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `kaifuu.unknown_engine_variant`       | SEEN.TXT envelope invalid OR Gameexe.ini missing despite RealLive marker names | Already exists; reused with `engine: "reallive"`. Matches the established pattern from Siglus's `SiglusFixtureVariant::UnknownNamedPair`. |
| `kaifuu.unsupported_layered_transform`| extract/patch/verify attempts on the identify-only adapter                   | Already exists; reused to mirror Siglus's behavior at `crates/kaifuu-engine-fixture/src/lib.rs:3137-3146`.                                  |
| `kaifuu.missing_capability.container` | profile/list-assets/asset-inventory called on a partial-fixture variant      | Already exists; reused for variants like `CompleteSyntheticTriple` failure paths where the synthetic envelope is missing one leg.          |

### 9.3 Diagnostic shape

All diagnostics flow through the existing `AdapterFailure::semantic(...)`
helper (used by Siglus / XP3 detector adapters) with
`AdapterFailureSemanticParams` carrying `engine("reallive")`,
`detected_variant(...)`, `asset_ref(...)`, `required_capability(...)`,
and `remediation(...)`. The archive-detection matrix row's
`DetectionDiagnostic` uses the same `SemanticErrorCode` enum values for
the matrix row's diagnostic vector when ambiguous / unsupported.

The auditor must verify that **no path** silently returns
`detected = true` when the variant is `Ambiguous`,
`UnsupportedAvg32Lineage`, or `UnknownEngineVariant`.

---

## 10. Test plan

Per `docs/testing-standard.md`: behavior-named tests, fixtures at the
lowest suitable layer, public fixtures with manifests, negative tests for
every meaningful failure mode, golden capability reports per fixture.

### 10.1 `crates/kaifuu-engine-fixture/src/lib.rs` (adapter tests)

Place under `#[cfg(test)] mod tests` alongside the existing Siglus tests
(`crates/kaifuu-engine-fixture/src/lib.rs:4945+`). Test naming follows
the behavior-name grammar.

- `fn detects_reallive_on_complete_synthetic_triple_fixture()`
- `fn detects_reallive_on_positive_live_layout_with_gameexe_ini_key_hits()`
- `fn rejects_reallive_when_siglus_scene_pck_co_present_with_ambiguous_engine_variant_error()`
- `fn rejects_reallive_when_gameexe_dat_co_present_with_ambiguous_engine_variant_error()`
- `fn rejects_reallive_on_avg32_pdt_layout_with_unsupported_engine_variant_error()`
- `fn rejects_reallive_on_invalid_seen_txt_envelope_with_unknown_engine_variant_error()`
- `fn does_not_detect_reallive_on_hello_game_fixture_without_emitting_diagnostic()`
- `fn does_not_detect_reallive_on_xp3_fixture_without_misclassifying()`
- `fn does_not_detect_reallive_on_siglus_only_fixture_without_misclassifying()`
- `fn rejects_reallive_extract_request_with_unsupported_layered_transform_error()`
- `fn rejects_reallive_patch_request_with_unsupported_layered_transform_error()`
- `fn rejects_reallive_verify_request_with_unsupported_layered_transform_error()`
- `fn reallive_detection_evidence_lists_seen_txt_and_gameexe_ini_and_seen_gan_and_g00_counts()`
- `fn reallive_capability_report_lists_identify_inventory_supported_and_extract_patch_unsupported()`
- `fn reallive_detection_report_redacts_game_dir_for_logs_and_reports()`
- `fn reallive_profile_emits_stable_uuidv7_profile_id_across_runs()`

### 10.2 `crates/kaifuu-core/src/lib.rs` (archive-detection matrix tests)

Extend the existing `ArchiveDetectionReport` test module:

- `fn archive_detection_matrix_includes_reallive_row()`
- `fn archive_detection_reallive_row_reports_seen_txt_and_gameexe_ini_counts_as_aggregate_evidence()`
- `fn archive_detection_reallive_row_emits_ambiguous_diagnostic_when_siglus_markers_co_present()`
- `fn archive_detection_reallive_row_does_not_claim_extraction_or_patch_support()`

### 10.3 `crates/kaifuu-cli/src/main.rs` (CLI tests)

Extend the existing test module:

- `fn detect_cli_reports_reallive_adapter_on_synthetic_fixture()`
- `fn detect_cli_emits_archive_detection_matrix_reallive_row_with_aggregate_evidence_only()`
- `fn detect_cli_emits_ambiguous_engine_variant_diagnostic_when_reallive_and_siglus_markers_co_present()`
- `fn capabilities_cli_lists_reallive_adapter_with_identify_only_support_boundary()`

### 10.4 Golden capability reports

For each public fixture in `fixtures/public/reallive-detector/<variant>/`,
ship an `expected/detection-report.json` and `expected/capabilities.json`
that are normalized (game-dir redacted, timestamps removed) and asserted
via the same `golden` test pattern Siglus uses at
`crates/kaifuu-engine-fixture/src/lib.rs` tests. Validate through
`stable_json` ordering so diffs are reviewable.

### 10.5 Public CI determinism

- No private corpora; tests must run with `fixtures/private-local/`
  absent.
- No live providers, no Wine, no Windows, no remote helpers.
- All fixture file generation is deterministic (no timestamps in payload).

---

## 11. Verification commands

Required for the audit:

```sh
cargo test -p kaifuu-core
cargo test -p kaifuu-engine-fixture
cargo test -p kaifuu-cli
just fixtures-validate
just check
```

Manual review (the DAG node calls for "RealLive detector fixture review"):

```sh
mkdir -p .tmp/reallive
cargo run -p kaifuu-cli -- detect fixtures/public/reallive-detector/positive-synthetic-triple --output .tmp/reallive/detect-positive.json
cargo run -p kaifuu-cli -- detect fixtures/public/reallive-detector/negative-siglus-overlap --output .tmp/reallive/detect-ambiguous.json
cargo run -p kaifuu-cli -- detect fixtures/public/reallive-detector/negative-avg32-lineage --output .tmp/reallive/detect-avg32.json
cargo run -p kaifuu-cli -- detect fixtures/public/reallive-detector/negative-unknown-shape --output .tmp/reallive/detect-unknown.json
cargo run -p kaifuu-cli -- capabilities --output .tmp/reallive/capabilities.json
```

Reviewer checks:

- Positive fixture: `detections[*].adapter_id == "kaifuu.reallive"` with
  `detected: true` and `engine_family: "reallive"`; `archiveDetection.rows`
  contains a `reallive` row with `detected: true`.
- Siglus-overlap fixture: RealLive detection is `false`; the
  RealLive adapter row carries a `kaifuu.ambiguous_engine_variant`
  diagnostic; the Siglus adapter does **not** report extraction support.
- AVG32-lineage fixture: RealLive detection is `false`; diagnostic is
  `kaifuu.unsupported_engine_variant`.
- Unknown fixture: RealLive detection is `false`; diagnostic is
  `kaifuu.unknown_engine_variant`.
- All outputs redact `gameDir` and contain no absolute local paths.

---

## 12. Risks and unknowns

### 12.1 Signal availability across real games

- **Risk**: `Gameexe.ini` content varies. Some RealLive titles use only a
  few documented keys; minor titles may not emit `#GAMEEXE_VERSION` even
  though they are RealLive.
- **Mitigation**: the decision table treats Gameexe.ini key hits as
  decisive **in combination** with SEEN.TXT envelope validity. A title
  with a valid SEEN.TXT envelope, RealLive marker extensions
  (`.g00`/`.ovk`), and no Siglus/AVG32 negatives passes the positive
  path even without `#GAMEEXE_VERSION`. The detector accepts **any** of
  the RealLive-specific keys (#GAMEEXE_VERSION, #REGNAME, #G00*, #KOE*,
  #SEEN*) as positive evidence — none alone is required.
- **Unknown**: the false-positive rate against very early RealLive titles
  (Kanon-era) is not measurable from synthetic fixtures alone. ALPHA-006
  will surface this; the detector can then add corroborating signals
  without breaking the API. Mitigation in the readiness record:
  "real-game evidence is gathered at ALPHA-006".

### 12.2 rlvm license boundary

- **Risk**: an implementation worker reads rlvm's
  `src/libreallive/archive.cc` to "just check a struct layout" and
  inadvertently mechanically translates a struct definition into Rust.
- **Mitigation**: §8's clean-room checklist is explicit. The module-level
  comment is mandatory. The auditor runs the checklist verbatim.
- **Unknown**: how a future contributor will handle rlvm reading. The
  readiness record names the boundary; any future contributor must
  reaffirm it in their PR description.

### 12.3 Siglus / AVG32 disambiguation strength

- **Risk**: a Siglus title that ships an empty SEEN.TXT placeholder, or
  an AVG32 title that includes a Gameexe.ini-named file, could weaken
  the disambiguation. The decisions table prefers `Ambiguous` over
  positive ID in any cross-marker case, so the risk is a false negative
  (`Ambiguous` instead of correct positive), not a false positive — that
  matches the audit focus "Ambiguous variants accepted silently" by
  inverting it: **ambiguity is loud, not silent**.
- **Mitigation**: ambiguous diagnostic includes both detected marker
  sets in the evidence, so a reviewer can manually disambiguate.

### 12.4 Public-format-archaeology drift

- **Risk**: Haeleth's site is archived but not actively maintained; URLs
  may drift to Wayback Machine snapshots. The readiness record records
  exact references with retrieval dates per the playbook.

### 12.5 Synthetic-fixture realism

- **Risk**: a synthetic SEEN.TXT envelope may not match real shape
  closely enough; a worker who passes synthetic fixtures but fails real
  ones surfaces the gap only at ALPHA-006.
- **Mitigation**: the `PositiveLiveLayout` variant accepts a generic
  SEEN-shaped envelope (count + offset table fits inside file length),
  separate from the synthetic-magic short-circuit. The synthetic short-
  circuit is only one path; the generic path is what ALPHA-006 exercises.

---

## 13. Out of scope (reminders for the implementation worker)

KAIFUU-172 is **identify only**.

- Does **NOT** extract Scene / SEEN content. That is KAIFUU-173.
- Does **NOT** inventory text slots inside scenes. That is KAIFUU-174.
- Does **NOT** parse Gameexe.ini key/value pairs into a typed
  configuration. The detector reads ASCII prefixes for marker keys; full
  parsing is KAIFUU-174.
- Does **NOT** run the RealLive engine, replay Scene/SEEN, or produce
  runtime evidence. That is UTSUSHI-146.
- Does **NOT** decrypt `.ovk`/`.koe`/`.nwk` voice archives.
- Does **NOT** rebuild `.g00` images.
- Does **NOT** patch back any text. Patch-back lives in KAIFUU-174.
- Does **NOT** call rlvm or any other foreign tool. The native crate is
  the support boundary.
- Does **NOT** read `/archive/vault/` directly. The vault-source adapter
  (KAIFUU-176) is the read-only path; KAIFUU-172 ships before that and
  works on synthetic fixtures.

The detector outputs **only** an identification claim, capability report,
asset inventory (top-level files), and structured diagnostics. Anything
beyond that is a separate node.

---

## 14. Implementation worker scoping

Recommendation: **single scope**.

The detector + fixtures + readiness record docs fit one worker's branch
cleanly:

- Code surface: ~400-600 net new Rust lines in
  `kaifuu-engine-fixture/src/lib.rs` (mirroring the Siglus structure) +
  ~80-120 lines in `kaifuu-core/src/lib.rs` (the archive-matrix row and
  the two new `SemanticErrorCode` variants).
- Fixture surface: ~6 small synthetic directories under
  `fixtures/public/reallive-detector/` + a public manifest + expected
  golden JSONs.
- Docs: `docs/kaifuu-adapters/reallive.md` readiness record + a brief
  entry in `docs/kaifuu-detection-matrix.md` (existing detection matrix
  doc).
- Tests: ~20 unit tests across the three crates + golden capability
  reports.

A split (detector + fixtures; docs separately) would slow review without
buying clarity — the readiness record is the gate for the code change,
not a follow-on. **Single PR is recommended.**

If the worker discovers during implementation that the synthetic
SEEN.TXT envelope is harder to model than expected (specifically: the
generic real-shape detector branch needs more bytes to validate than
the current §3 sketch), the worker may de-scope the
`PositiveLiveLayout` branch to a TODO with semantic
`kaifuu.unknown_engine_variant` and ship only `CompleteSyntheticTriple`
positive ID. ALPHA-006 then reopens the live-layout branch as a new node.
This de-scoping is explicitly allowed; over-promising live-layout
support is not.

---

## 15. Self-audit checklist (worker must complete before requesting review)

- [ ] No `Command::new("rlvm")`, no foreign tool invocation, no Cargo
      dep on rlvm or RLDEV.
- [ ] No copied opcode tables, struct layouts, or constants from rlvm /
      RLDEV.
- [ ] Module-level provenance comment present and accurate.
- [ ] Readiness record present at `docs/kaifuu-adapters/reallive.md`.
- [ ] All public fixture files have hashes in
      `fixtures/public/reallive-detector.manifest.json` and pass
      `just fixtures-validate`.
- [ ] Every ambiguous / unsupported / unknown variant returns the
      correct semantic error code.
- [ ] `archiveDetection` matrix row for `reallive` is present and
      claims no extraction / patch / decompile capability.
- [ ] CLI `detect`, `capabilities`, `profile init` route through the
      new adapter without new subcommands.
- [ ] `cargo test -p kaifuu-core -p kaifuu-engine-fixture -p kaifuu-cli`
      passes locally.
- [ ] `just check` passes locally.
- [ ] No private-local paths leak in any artifact.
- [ ] No retail bytes ship in `fixtures/public/`.
- [ ] If rlvm was read to confirm a hypothesis during implementation,
      the readiness record's "Reference implementations and docs"
      section names the file path consulted and the hypothesis
      confirmed.

---

## Summary for the audit

KAIFUU-172 ships a pure-Rust, identify-only RealLive detector that plugs
into the existing KAIFUU-006 `AdapterRegistry` and the KAIFUU-034 archive
matrix. Disambiguation against Siglus (`Scene.pck`/`Gameexe.dat`) and
AVG32 (`.PDT` + non-RealLive Gameexe) uses a small finite state machine
with explicit decisive / corroborating / disqualifying signals. Ambiguous
and out-of-scope inputs raise structured semantic diagnostics —
`kaifuu.ambiguous_engine_variant` and `kaifuu.unsupported_engine_variant`
are new codes added to `SemanticErrorCode`. rlvm is a research anchor
only; the implementation is clean-room with an explicit license-posture
section in the readiness record and a mandatory module-level provenance
comment. Synthetic public fixtures cover the positive path, the two
disambiguation negatives, the unknown-shape case, and the
not-RealLive case; real-game evidence flows in at ALPHA-006.
