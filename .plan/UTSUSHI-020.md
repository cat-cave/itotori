# UTSUSHI-020 — Runtime VFS and asset package boundary

- **Node**: UTSUSHI-020
- **Title**: Runtime VFS and asset package boundary
- **Branch**: `spec/utsushi-020`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-020`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review

## 1. Goal restatement

Build the engine-neutral, read-only runtime virtual filesystem (`RuntimeVfs`) and
the asset-package adapter boundary (`AssetPackage`) on top of which every
Utsushi runtime port loads game content. This is the substrate node for the
alpha runtime track. The trait surface must:

- Be engine-neutral (no KAG, no JSON, no RGSS3 assumptions).
- Be read-only by contract (no writers on the trait).
- Emit semantic diagnostics for every failure mode, using `kaifuu.*` codes
  where the failure is shared with extraction/decode boundaries.
- Never leak raw host paths or private corpus roots into errors, observation
  hook events, runtime evidence reports, or conformance reports.

Downstream nodes whose acceptance criteria informed this shape:

- UTSUSHI-021 (deterministic input/clock): the VFS must be callable from a
  deterministic runtime loop without leaking I/O nondeterminism into traces.
- UTSUSHI-022 (headless text/render/audio sinks): adapters open asset bytes
  through the VFS, then route them to the appropriate sink — the VFS does not
  know what kind of asset it is returning.
- UTSUSHI-023 (snapshot primitives): snapshots must reference assets by vfs
  id, never by host path; the asset id namespace is load-bearing here.
- UTSUSHI-024 (WASM embed ABI fixture): the same VFS surface must be usable
  from a wasm32 build with no host-filesystem assumptions; that forbids
  `std::path::Path` in the public API of `RuntimeVfs::open` etc.
- UTSUSHI-025 (engine port implementation map validator): the map references
  asset coverage by vfs id; the asset id grammar is the stable identifier.
- UTSUSHI-026/027/028/029/030 (conformance schema + checks + ingestion): every
  asset-related diagnostic surfaces as a stable, typed enum that the schema
  layer can validate; redaction defaults must hold through ingestion.
- UTSUSHI-056 (observation hook protocol): already enforces
  `reject_unredacted_local_paths` in `utsushi-core`. The VFS error path must
  produce strings that pass that filter unchanged.
- UTSUSHI-103 (engine-port runner template): port runners require a uniform
  asset surface; this is what they get.
- UTSUSHI-120 (substrate facade): re-exports `RuntimeVfs`, `AssetPackage`,
  and the diagnostic enum without exposing internal types.

The asset-package model also slots cleanly above KAIFUU-052's layered text
access pipeline contract: Kaifuu produces an extracted, per-surface artifact
tree; the asset-package adapter wraps that tree and exposes it to the runtime
through the VFS. The vault-source-adapter contract
(`docs/itotori-vault-source-adapter.md`) already describes an extracted tree
shape that is the natural plaintext-package case.

## 2. Crate placement

**Recommendation: keep the VFS in `utsushi-core` as a new public module
`utsushi_core::vfs`, not a new crate.**

Justification:

- `utsushi-core` already owns the `RuntimeAdapter` trait, observation hook
  event types, `RuntimeArtifactRoot`, and the redaction/local-path policy in
  `reject_unredacted_local_paths` + `looks_like_local_path`. The VFS must
  participate in that policy directly; co-locating avoids re-exporting the
  policy across a crate boundary.
- All downstream substrate nodes (021/022/023/024/025/026/103/120) depend on
  `utsushi-core` already. Adding a `utsushi-vfs` crate would force every one
  of them to add a second dependency for no real isolation gain at this
  stage.
- The current `utsushi-core` `lib.rs` is large (~5400 lines). The VFS adds
  several types but is cleanly modular and can live in `src/vfs/` (submodules
  `mod.rs`, `diagnostics.rs`, `id.rs`, `package.rs`, `runtime.rs`). Splitting
  the crate is a separate concern that can be done later (e.g. before
  UTSUSHI-120 ships the facade).
- A separate crate would also force a public dependency on `bytes` or any
  similar byte type from every downstream crate even when they only consume
  the `RuntimeAdapter` trait.

If `utsushi-core` later becomes painful (compile time, cyclic concerns), the
plan permits extracting `utsushi-vfs` in a follow-up node; the public API is
designed to be re-exportable through `utsushi_core::vfs::*` for source-level
back-compatibility.

**No new workspace member is required for this node.**

## 3. Trait surface

All types live in `utsushi_core::vfs`. Public re-exports at the crate root:
`RuntimeVfs`, `AssetPackage`, `AssetId`, `AssetMetadata`, `AssetKind`,
`VfsError`, `VfsResult`, `RequiredCapability`, `HelperId`, `TraversalKind`.

### 3.1 Asset id namespace

```rust
/// Canonical, engine-neutral asset identifier.
///
/// Wire form: `vfs://<package-id>/<normalized-path>`
/// where
///   - `package-id` is `[a-z0-9][a-z0-9._-]{0,62}` (ASCII, lowercase),
///   - `normalized-path` uses forward slashes,
///   - no segment is empty, `.`, or `..`,
///   - segments are NFC-normalized and case-folded according to the
///     package's case rule (see `AssetPackage::case_rule`),
///   - control characters (U+0000..U+001F, U+007F) are rejected,
///   - leading and trailing slash are rejected,
///   - max total length 4096 bytes.
pub struct AssetId { inner: Arc<str> }

impl AssetId {
    pub fn parse(raw: &str) -> Result<Self, VfsError>;
    pub fn package(&self) -> &str;
    pub fn path(&self) -> &str;            // package-relative, slash form
    pub fn as_str(&self) -> &str;          // full `vfs://...` form
    pub fn join(&self, child: &str) -> Result<Self, VfsError>;
    pub fn parent(&self) -> Option<Self>;
}
```

Rationale:

- A URI-shaped id is the value carried by every diagnostic, observation hook
  event, snapshot, and conformance report. It is what the existing
  `reject_unredacted_local_paths` policy treats as the safe form (it does not
  match `vfs://`).
- `Arc<str>` keeps clones cheap for use inside trace events and snapshots
  without committing the public ABI to `bytes::Bytes` outside the read path.
- Case rule is per-package because XP3 is byte-identical while RGSS3/`www/`
  is case-insensitive on Windows.

### 3.2 `RuntimeVfs` trait

```rust
pub trait RuntimeVfs: Send + Sync {
    /// List packages mounted into this VFS. Order is deterministic
    /// per-implementation (typically registration order).
    fn packages(&self) -> Vec<PackageDescriptor>;

    /// Whether the asset exists and is openable for read. Returns `Ok(false)`
    /// for `asset_missing` and `asset_outside_package`; helper-gated and
    /// encrypted assets return `Ok(true)` because their existence is
    /// observable even when their bytes are not.
    fn exists(&self, id: &AssetId) -> VfsResult<bool>;

    /// Metadata-only lookup. Does not decrypt or call helpers.
    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata>;

    /// Open an asset for read. Returns reference-counted bytes that the
    /// caller may clone cheaply across observation hooks and snapshots.
    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes>;

    /// List immediate children under a directory-shaped asset id (path
    /// must end in `/`, or be the package root `vfs://<package-id>/`).
    /// Returns asset ids, not host names.
    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>>;

    /// Resolve an engine-supplied logical path (e.g. `"data/Map001.json"`)
    /// against a package id, applying that package's case rule and
    /// traversal-rejection rules.
    fn resolve(&self, package: &str, logical: &str) -> VfsResult<AssetId>;
}

pub struct AssetBytes(bytes::Bytes);

impl AssetBytes {
    pub fn as_slice(&self) -> &[u8];
    pub fn len(&self) -> usize;
    pub fn into_bytes(self) -> bytes::Bytes;
    pub fn from_static(bytes: &'static [u8]) -> Self;
}
```

Notes:

- `bytes::Bytes` is added as a workspace dependency (it is small and lets
  packages share memory across hook payloads). `AssetBytes` is the public
  wrapper so we can swap the backing type later without an ABI break.
- No method takes or returns `std::path::Path` or `&str` paths. `AssetId` is
  the only path-shaped type on the trait.
- `Send + Sync` is required so adapters can stage runtime work on threads
  without re-architecting later (no `dyn`-incompatibility needed for now).
- No method takes `&mut self`. All read paths use interior mutability
  in concrete implementations (e.g. `Mutex` around an XP3 reader).

### 3.3 `AssetPackage` trait — the engine boundary

```rust
pub trait AssetPackage: Send + Sync {
    /// Stable package identifier used inside `AssetId`. Engines provide
    /// names like `"www"`, `"mv-mz-system"`, `"scene"`, `"xp3-main"`.
    fn id(&self) -> &str;

    fn descriptor(&self) -> PackageDescriptor;

    fn case_rule(&self) -> CaseRule;

    /// Resolve a package-relative logical path to an `AssetId`. Implementors
    /// MUST reject traversal (`..`, absolute roots, NUL, control chars) and
    /// MUST NOT touch the host filesystem here.
    fn resolve(&self, logical: &str) -> VfsResult<AssetId>;

    fn exists(&self, id: &AssetId) -> VfsResult<bool>;
    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata>;

    /// Read asset bytes. Encrypted, helper-gated, or unsupported variants
    /// MUST return the appropriate `VfsError` variant rather than partial
    /// or placeholder bytes.
    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes>;

    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>>;
}

pub enum CaseRule {
    /// Byte-identical, e.g. XP3.
    Sensitive,
    /// ASCII case-insensitive, e.g. RPG Maker `www/` on Windows hosts.
    InsensitiveAscii,
}

pub struct PackageDescriptor {
    pub id: String,
    pub kind: PackageKind,         // engine-neutral discriminant
    pub case_rule: CaseRule,
    pub source: PackageSource,     // public name only; not a host path
    pub revision: Option<String>,  // content-hash or revision id
}

pub enum PackageKind {
    Plaintext,   // unencrypted directory tree
    Archive,     // XP3, RGSS3, RPGMVP container
    Composite,   // an overlay over multiple sub-packages
}

pub enum PackageSource {
    /// A redacted public name for the source. Never a host path.
    /// e.g. `"public-fixture:hello-game"`, `"vault:cat-cave/utsushi-fixture"`.
    PublicName(String),
}
```

The mounted-VFS implementation `MountedVfs` composes packages registered in
order (later wins on id collision, with collisions rejected at registration).
The fixture adapter (and every future engine port) talks to `MountedVfs`,
never to a package directly.

Asset id grammar lookups for `MountedVfs` route by the `package-id` prefix to
the matching `AssetPackage`. Unknown ids fail with
`VfsError::AssetOutsidePackage`.

### 3.4 `AssetMetadata`

```rust
pub struct AssetMetadata {
    pub id: AssetId,
    pub kind: AssetKind,
    pub size: AssetSize,
    pub revision: Option<String>,   // content hash if cheap, else None
}

pub enum AssetKind {
    File,
    Directory,
}

pub enum AssetSize {
    Bytes(u64),
    Unknown,            // for streams or encrypted-but-unread assets
}
```

`AssetMetadata` deliberately omits modification timestamps and host paths.
Conformance reports must be deterministic and host-portable.

## 4. Semantic diagnostic enum

All variants live in `VfsError`. Every variant carries enough context to be a
stable conformance signal, and every variant carries an `AssetId` (or a
package id) — never a raw host path.

```rust
pub enum VfsError {
    /// The asset id is structurally invalid (bad scheme, bad package id,
    /// empty segment, control char, > limit).
    InvalidAssetId { raw: String, reason: AssetIdErrorReason },

    /// The asset does not exist in the requested package.
    /// Stable code: `utsushi.vfs.asset_missing`.
    AssetMissing { id: AssetId },

    /// The asset id points at a package that is not mounted, or at a path
    /// that escapes its package root.
    /// Stable code: `utsushi.vfs.asset_outside_package`.
    AssetOutsidePackage { id: AssetId, package: String },

    /// The logical path attempts a forbidden traversal pattern.
    /// Stable code: `utsushi.vfs.asset_path_unsafe`.
    AssetPathUnsafe { package: String, logical: String, kind: TraversalKind },

    /// The asset is encrypted and the required key/profile capability is
    /// not satisfied. Maps to the shared `kaifuu.missing_capability.crypto`
    /// or `kaifuu.missing_key_material` code through `kaifuu_code()`.
    AssetEncrypted { id: AssetId, required_capability: RequiredCapability },

    /// The asset can only be accessed via a bounded helper (per
    /// KAIFUU-064) and that helper is not available in this run.
    /// Maps to `kaifuu.helper_unavailable`.
    AssetHelperGated { id: AssetId, helper_id: HelperId },

    /// The package cannot decode this asset because the codec or container
    /// transform is unsupported. Maps to
    /// `kaifuu.unsupported_layered_transform` or
    /// `kaifuu.missing_capability.codec`.
    AssetTransformUnsupported { id: AssetId, transform: TransformKind },

    /// The package was queried for `list` on a non-directory id.
    AssetNotDirectory { id: AssetId },

    /// A read attempted on a directory id.
    AssetNotFile { id: AssetId },

    /// The package's underlying store reported an I/O failure that is not a
    /// missing-file case. The raw OS error message is REDACTED in the
    /// public form; only an opaque code remains.
    PackageIo { id: AssetId, summary: IoSummary },

    /// The asset id is well-formed but exceeds an implementation-imposed
    /// bound (file too large to safely buffer, list cardinality cap).
    ResourceBound { id: AssetId, bound: ResourceBoundKind },
}

pub enum TraversalKind {
    ParentEscape,        // `..` segment
    AbsoluteRoot,        // logical starts with `/` or drive letter
    ControlCharacter,
    NulByte,
    BackslashSeparator,
    EmptySegment,
    OverlongSegment,
}

pub enum RequiredCapability {
    KeyProfile,          // -> kaifuu.missing_capability.key_profile
    KeyMaterial,         // -> kaifuu.missing_key_material
    Crypto,              // -> kaifuu.missing_capability.crypto
    Container,           // -> kaifuu.missing_capability.container
}

pub enum TransformKind { Container, Crypto, Codec }

pub enum HelperId {
    /// Stable, public id of a registered helper class. Never a path.
    Named(String),
}

pub enum IoSummary {
    NotFound,
    PermissionDenied,
    UnexpectedEof,
    Other,               // intentionally opaque; raw os error is dropped
}

pub enum ResourceBoundKind { FileSizeCap, ListCardinalityCap, RecursionCap }

pub enum AssetIdErrorReason {
    MissingScheme, EmptyPackage, BadPackageChar, EmptyPath, EmptySegment,
    ParentSegment, DotSegment, ControlCharacter, NulByte, BackslashSeparator,
    OverlongSegment, OverlongTotal, NonNfc,
}
```

`VfsError` provides:

```rust
impl VfsError {
    /// Stable Utsushi semantic code, e.g. `"utsushi.vfs.asset_missing"`.
    pub fn semantic_code(&self) -> &'static str;

    /// Shared kaifuu code where applicable (None for purely VFS-level
    /// failures like AssetOutsidePackage and AssetPathUnsafe).
    pub fn kaifuu_code(&self) -> Option<&'static str>;

    /// Asset id (or synthetic placeholder for `InvalidAssetId`) suitable
    /// for inclusion in reports.
    pub fn asset_ref(&self) -> AssetRef;
}
```

`AssetRef` is a serializable struct `{ assetId, package }` consumed by
`RuntimeAdapterDiagnostic` and `ObservationErrorPayload`. It is the only
form in which an asset reference appears in error output by default.

`VfsError: std::error::Error + Send + Sync + 'static` and converts to
`Box<dyn std::error::Error>` so it fits `UtsushiResult<T>` unchanged.

## 5. Path redaction policy

Default: every public-facing string emitted from `VfsError::Display` and
`VfsError::semantic_code()` contains only:

- the stable semantic code,
- the `AssetId` (which is `vfs://` scoped and engine-neutral by
  construction),
- the package id (a registered public name).

Forbidden in default output:

- any `std::path::Path` or `PathBuf`,
- any string matching `looks_like_local_path` (the existing utsushi-core
  filter is reused),
- raw OS error strings (we keep an `IoSummary` enum, never the underlying
  `std::io::Error` message),
- key material, helper command lines, helper environment, or vault
  passphrase output.

Operator-facing debug logging:

- A `vfs_debug` cargo feature on `utsushi-core` enables a separate
  `VfsError::debug_render(&self) -> String` method that may include the
  package's local path. The default build of `utsushi-cli` does NOT enable
  this feature.
- The feature gate is documented in `docs/utsushi-fidelity-policy.md` (or
  alongside the runtime artifacts doc) as the only allowed channel for raw
  paths, and is never enabled in CI or shipped binaries.

Tests assert (a) `Display` output passes
`reject_unredacted_local_paths` after being wrapped into a JSON observation
hook payload, and (b) `debug_render` without the feature flag returns the
same output as `Display`.

## 6. Read-only enforcement

- `RuntimeVfs` and `AssetPackage` carry no `&mut` methods, no `Write`
  associated types, no return values that own a `File` or a writable buffer.
- `AssetBytes` only exposes `&[u8]` / immutable `bytes::Bytes`.
- A `compile_fail` doc test asserts that the following does not compile:

```rust
fn _wants_write(vfs: &dyn RuntimeVfs) {
    vfs.write(/* anything */); //~ ERROR no method named `write`
}
```

- The crate's public re-exports include only the immutable surface; no
  internal `AssetPackageMut` (which we deliberately do not introduce).

## 7. Integration with existing crates

### 7.1 `utsushi-core` itself

- New module `utsushi_core::vfs` re-exports the types listed above.
- `RuntimeAdapter` is not changed in this node. The VFS is reached by
  adapters via their own constructors (the fixture adapter, for example,
  will store a `MountedVfs` in its struct and accept it through a builder).
  This avoids a churny trait change before downstream nodes need it.
- A follow-up node (likely UTSUSHI-103 or UTSUSHI-120) will decide whether
  `RuntimeAdapter::run` should take a `&dyn RuntimeVfs` in its
  `RuntimeRequest`. UTSUSHI-020 only adds a `vfs:
Option<Arc<dyn RuntimeVfs>>` field to `RuntimeRequest` as an additive,
  optional handoff so downstream nodes can rely on the field existing.

```rust
pub struct RuntimeRequest<'a> {
    pub input_root: &'a Path,
    pub artifact_root: Option<&'a Path>,
    pub vfs: Option<Arc<dyn RuntimeVfs>>,
}
```

(`input_root: &'a Path` remains because UTSUSHI-021/022/023 still need it as
a config root for now; only asset access moves through the VFS.)

### 7.2 `utsushi-fixture`

This node does NOT refactor the fixture adapter to consume the VFS for
its existing `source.json` loading; that would mix substrate and adapter
churn in the same PR. It DOES:

- Add a `PlaintextDirPackage` concrete implementation of `AssetPackage`
  inside `utsushi-core::vfs` (it is engine-neutral). The fixture adapter's
  follow-up node will mount this package over the input root and replace
  `read_source` with a VFS call.
- The follow-up is tracked as a sibling slice (recommended: UTSUSHI-020b)
  for an implementation worker, not as a planning concern here.

### 7.3 Kaifuu hand-off

KAIFUU-052 (complete) produced layered text access transforms. KAIFUU-176
plus future engine adapters produce extracted asset trees on disk (the
vault-source adapter already describes this for plaintext archives). The
asset-package boundary picks up where Kaifuu leaves off:

- A Kaifuu adapter that yields a directory tree is wrapped by
  `PlaintextDirPackage`.
- A Kaifuu adapter that needs in-process decryption per asset (the layered
  pipeline of crypto/codec/container transforms) implements `AssetPackage`
  directly inside its own crate, returning `AssetEncrypted` or
  `AssetTransformUnsupported` for the boundaries the layered profile cannot
  satisfy. This keeps the support-boundary semantics from KAIFUU-052
  visible at the runtime VFS level without re-implementing the layered
  transform engine here.

No Kaifuu crate code is changed in this node.

### 7.4 `utsushi-cli`

`utsushi-cli` does not change in this node. The future composition of a
runtime VFS (mounting the input root as a `PlaintextDirPackage` and handing
it to adapters) lives with the fixture refactor follow-up.

## 8. Test plan

All tests follow `docs/testing-standard.md`: behavior names, falsifiable
claims, public fixtures or synthetic literal data only.

### 8.1 Unit (in `utsushi-core::vfs::*` modules)

Asset id parsing:

- `parse_accepts_well_formed_vfs_uri()`.
- `parse_rejects_non_vfs_scheme()`.
- `parse_rejects_empty_package_id()`.
- `parse_rejects_uppercase_in_package_id()`.
- `parse_rejects_path_segments_containing_backslash()`.
- `parse_rejects_parent_segment_anywhere()`.
- `parse_rejects_empty_segment()`.
- `parse_rejects_control_character_in_path()`.
- `parse_rejects_overlong_total_length()`.
- `parse_normalizes_nfc_in_path_segment()`.

Case rules:

- `insensitive_ascii_resolve_matches_uppercase_request()`.
- `sensitive_resolve_rejects_case_mismatch()`.

Traversal rejection (each surfaces `AssetPathUnsafe { kind: ... }`):

- `resolve_rejects_dot_dot_at_start()`.
- `resolve_rejects_dot_dot_after_segment()`.
- `resolve_rejects_absolute_unix_root()`.
- `resolve_rejects_windows_drive_root()`.
- `resolve_rejects_nul_byte()`.

Diagnostic surface:

- `asset_missing_carries_asset_id_and_stable_code()`.
- `asset_outside_package_carries_package_id()`.
- `asset_encrypted_carries_required_capability()`.
- `asset_helper_gated_carries_helper_id()`.
- `asset_transform_unsupported_maps_to_kaifuu_code()`.
- `package_io_summary_drops_raw_os_message()`.

Redaction:

- `display_output_contains_no_host_path_substrings()`.
- `display_output_passes_observation_payload_redaction_filter()`.
- `debug_render_without_feature_flag_matches_display()`.

Read-only enforcement:

- One `trybuild`/`compile_fail` doc test asserting no `write_*` method
  exists on `RuntimeVfs` or `AssetPackage`. (`trybuild` is a workspace dev
  dependency in this node; if it is already declined as policy, replace
  with a documented contract test that constructs `&dyn RuntimeVfs` and
  fails compilation if a `write` method is added.)

### 8.2 Integration

A synthetic public fixture at
`crates/utsushi-core/tests/fixtures/synthetic-package/` containing:

```
synthetic-package/
  hello/
    intro.txt          # 12 bytes plaintext
    nested/
      glyph.txt
  encrypted/
    locked.bin         # marked as encrypted by a sidecar manifest
  helper-gated/
    remote.bin         # marked as helper-gated
```

A sidecar `package.toml` declares per-path access policy (encrypted /
helper-gated) so the fixture exercises the diagnostic enum without needing
real crypto in the test crate. A `FixturePolicyPackage` test type reads
`package.toml` and produces the right `VfsError` variants on `open`.

Behavior tests (one assert each):

- `synthetic_package_open_returns_plaintext_bytes_for_intro_txt()`.
- `synthetic_package_list_root_returns_three_subdirectories()`.
- `synthetic_package_stat_directory_reports_directory_kind()`.
- `synthetic_package_open_missing_path_returns_asset_missing()`.
- `synthetic_package_open_encrypted_asset_returns_asset_encrypted_with_crypto_capability()`.
- `synthetic_package_open_helper_gated_asset_returns_asset_helper_gated_with_named_helper()`.
- `synthetic_package_resolve_outside_root_returns_asset_path_unsafe_parent_escape()`.
- `synthetic_package_resolve_drive_letter_returns_asset_path_unsafe_absolute_root()`.
- `mounted_vfs_routes_to_correct_package_by_id()`.
- `mounted_vfs_unknown_package_id_returns_asset_outside_package()`.

### 8.3 Negative / redaction

- `vfs_error_serialized_into_runtime_diagnostic_passes_observation_redaction()`
  — wraps a `VfsError` into a `RuntimeAdapterDiagnostic` and round-trips it
  through `ObservationHookEvent::validate()`; the existing
  `reject_unredacted_local_paths` filter must accept it.
- `vfs_error_for_real_host_path_input_does_not_leak_path_into_display()` —
  constructs a `FixturePolicyPackage` whose internal root is the test's
  `tempdir()` (so the host path is `/tmp/...` and would be matched by
  `looks_like_local_path`), triggers an `AssetMissing` and asserts the
  rendered string does not contain the temp dir path.
- `package_io_failure_summary_does_not_include_errno_text()`.

### 8.4 Test placement

Unit tests under `crates/utsushi-core/src/vfs/*` `#[cfg(test)] mod tests`.
Integration tests under `crates/utsushi-core/tests/vfs_synthetic_package.rs`.
No changes to `crates/utsushi-fixture/tests` in this node.

## 9. Verification commands

Per the DAG node:

```
cargo test -p utsushi-core
cargo test -p utsushi-fixture
just schema
```

Reasoning:

- `cargo test -p utsushi-core` exercises every unit and integration test
  added by this node.
- `cargo test -p utsushi-fixture` runs unchanged; it must still pass
  because the fixture adapter is not refactored here. This is the
  no-regression bar.
- `just schema` validates that no schema package references newly minted
  semantic codes without listing them. The Utsushi semantic code prefix
  `utsushi.vfs.*` is added to the registry of allowed runtime diagnostic
  codes consumed by the conformance schema (UTSUSHI-026 codifies this; the
  prefix is added here as a pre-allocation so 026 does not need to retrofit
  it).

No `cargo test -p utsushi-vfs` because no new crate is introduced.

A `just check` smoke is recommended locally; CI runs it.

## 10. Risks and unknowns

### 10.1 `Bytes` vs `&[u8]` for the read path

Decision: return `AssetBytes` (newtype wrapping `bytes::Bytes`) because:

- Observation hook events, snapshots (UTSUSHI-023), and recording slices
  (UTSUSHI-029) need to retain asset references across thread boundaries
  without re-reading; `Arc`-backed `Bytes` is cheap to clone.
- Borrowed `&[u8]` would force every consumer to lifetime-bound the read,
  which conflicts with the deterministic input/clock loop in UTSUSHI-021
  where input events may be replayed after the original `open` call has
  returned.

Trade-off: adds a `bytes` dependency to `utsushi-core`. This is low risk
(extremely stable crate, no_std-friendly).

### 10.2 Sync vs async

Decision: keep the trait sync.

- The fixture adapter and every initial real adapter are sync.
- The deterministic input/clock loop (UTSUSHI-021) is sync.
- The WASM ABI fixture (UTSUSHI-024) does not currently require async for
  asset access; the embed reads pre-staged bytes.
- Async is a significant ABI commitment, would force `Future` returns
  through the entire downstream substrate, and there is no current evidence
  that any port needs it.

Risk: if a future port (RealLive remote helper, network-backed reference
recorder) requires async, the substrate adds a parallel `async_trait`
surface in a later node. Documented in plan; not implemented now.

### 10.3 Helper-gated read paths without exposing keys

Helper-gated packages (`AssetHelperGated`) MUST NOT return key material in
their error. The diagnostic carries `HelperId::Named(String)` — the
public, stable helper id (e.g. `"wine-windows-helper"`). The package's
internal mechanism for asking the helper for bytes lives outside this node
(KAIFUU-064 owns the helper boundary). For UTSUSHI-020 the contract is
simply: helper-gated packages return `AssetHelperGated` from `open()` when
the helper is not available, and `AssetEncrypted` when the helper IS
available but the key material is missing. The `kaifuu_code()` mapping
already distinguishes these.

### 10.4 List determinism

`AssetPackage::list` MUST return ids in a deterministic order
(byte-lexicographic on path). This is what UTSUSHI-027 needs for golden
trace fixtures. Tested in 8.2 above. Risk: forgetting to sort. Mitigated
by an explicit unit test on a small ad-hoc package.

### 10.5 Public name for sources

`PackageSource::PublicName` is required to be a stable, redacted name. The
question of who chooses that name (vault adapter? Kaifuu adapter?
operator?) is delegated to the package implementor. UTSUSHI-020 only
constrains that it must not be a host path; it cannot mechanically enforce
that the name is a meaningful public identifier. This is acceptable: the
`reject_unredacted_local_paths` filter catches actual leaks.

## 11. Out of scope

The following are explicitly NOT done in this node:

- Refactoring `utsushi-fixture` to load `source.json` through the VFS.
  Follow-up: a sibling implementation slice once UTSUSHI-020 lands.
- Adding a `RuntimeAdapter` parameter that hands the VFS to adapters.
  UTSUSHI-103 (engine-port runner template) is the right place for that
  signature decision.
- Deterministic input/clock (UTSUSHI-021).
- Headless text/render/audio sinks (UTSUSHI-022).
- Snapshot primitives (UTSUSHI-023).
- WASM embed ABI (UTSUSHI-024).
- Engine port implementation map (UTSUSHI-025).
- Conformance schema / checks / ingestion (UTSUSHI-026..030).
- Real engine ports (UTSUSHI-031..039 and UTSUSHI-146).
- Encrypted-asset cryptography — this node only models the diagnostic
  surface for unsupported/missing crypto. KAIFUU-052 + future adapters own
  the implementation.
- Bounded helper transport (KAIFUU-064 and adjacent).

## 12. Implementation worker scoping

Recommendation: **two implementation slices**.

### Slice A — substrate (`UTSUSHI-020a-substrate`)

Single PR; owns the substrate work:

- `utsushi_core::vfs::{id, package, runtime, diagnostics}` modules.
- `AssetId`, `AssetBytes`, `RuntimeVfs`, `AssetPackage`, `MountedVfs`,
  `PlaintextDirPackage`, `VfsError`, all enums.
- Additive change to `RuntimeRequest` (new `vfs: Option<Arc<dyn
RuntimeVfs>>` field).
- All unit + integration + redaction tests under utsushi-core.
- Schema registry update for `utsushi.vfs.*` semantic codes (the conformance
  schema package's allowed-code list, validated by `just schema`).

Verification: `cargo test -p utsushi-core`, `cargo test -p utsushi-fixture`,
`just schema`, `just check`.

Estimated worker time: medium. Substrate code is largely well-shaped enums
and traits plus careful tests; the synthetic-package integration is the
biggest piece.

### Slice B — fixture refactor (`UTSUSHI-020b-fixture-vfs`)

Separate, smaller PR after Slice A merges:

- `utsushi-fixture` mounts a `PlaintextDirPackage` over `request.input_root`
  and replaces `read_source` with a VFS open.
- Adds one test asserting fixture-adapter loads source through the VFS and
  that an absent `source.json` returns `AssetMissing` (carrying a vfs id,
  not the temp dir path).

Verification: `cargo test -p utsushi-fixture`, `just check`.

Estimated worker time: small.

Separating these keeps Slice A reviewable as substrate (no behavioral
change to fixture output) and Slice B reviewable as a regression-free
refactor.

## Plan ends here.
