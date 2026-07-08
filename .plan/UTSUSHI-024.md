# UTSUSHI-024 — WASM embed ABI fixture

- **Node**: UTSUSHI-024
- **Title**: WASM embed ABI fixture
- **Branch**: `spec/utsushi-024`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-024`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation slice)
- **Dependency layer landed**: UTSUSHI-020 (VFS / `AssetId`), UTSUSHI-021
  (input/clock/replay), UTSUSHI-022 (sinks / `TextLine`), UTSUSHI-023
  (snapshot / `SnapshotRef`), UTSUSHI-026 (conformance), UTSUSHI-103
  (engine port runner) all on `main`.

## 1. Goal restatement

Provide the **engine-neutral substrate ABI** for browser / WASM embeds of an
Utsushi controlled-playback session. The ABI carries four things across the
embed boundary: a **capability declaration**, a **trace** (sink-shaped text
lines, redacted), a **current-state SnapshotRef** (id-only), and a list of
**artifact refs** (managed URIs only). Nothing else — no live engine state,
no host paths, no asset bytes.

The substrate must satisfy three claims that downstream nodes can mechanically
falsify:

1. **Capability declaration is the gate.** Before a host can ask the embed to
   play anything, it MUST call `embed_capabilities()` and receive a stable,
   sorted `Vec<Capability>` listing every controlled-playback capability the
   embed supports, partially supports, or does not support. A capability mismatch
   (host asks for `Capability::Replay` against an embed that only declares
   `Capability::Trace`) surfaces as a typed `EmbedError::CapabilityNotSupported`
   **before** any playback frame ticks. This is the audit-focus "unsupported
   capabilities discovered only after silent failure" mitigation.
2. **Redacted by construction.** Every field that crosses the ABI is JSON,
   passes `reject_unredacted_local_paths` on serialize, and uses `AssetId` or
   managed `RuntimeArtifact` URIs (`artifacts/utsushi/runtime/...`) for any
   asset / artifact reference. Raw host paths, raw asset bytes, secret profile
   material, and `RuntimeRequest::input_root` are structurally impossible to
   serialize through the ABI — there are no fields shaped to hold them.
3. **Engine-neutral.** The ABI carries no engine-specific tags. It composes
   types that already exist in `utsushi-core` as engine-neutral (sink
   `TextLine`, `ObservationArtifactRef`, snapshot `SnapshotRef`, evidence
   tiers, runtime capability classes). No new "rpgm" / "siglus" / "reallive"
   variant is introduced. The embed's `adapter_id` is a public string label
   (e.g. `"utsushi-fixture"`); the ABI never inspects it.

Downstream consumers and what they need from this layer:

- **Fixture web embed** (this slice, follow-up surface): consumes
  `EmbedState`, `EmbedTrace`, `EmbedSnapshot`, `EmbedArtifactRef`,
  `EmbedCapability` JSON and renders them in the existing
  `apps/runtime-web-review/` Vite app. The web app does not need a WASM
  build to land — Slice A renders a static fixture JSON the Rust side
  produces.
- **Replay review UI** (later, separate node): the same `EmbedState`
  serializer fed by a future WASM port of the engine adapter. The ABI does
  not change between fixture and engine port; the producer changes.
- **Conformance dashboards** (later): the `EmbedCapability` list is the
  canonical answer to "what can this embed prove?" — dashboards mirror the
  fidelity / evidence ceiling rather than guess.

## 2. Module placement

**Recommendation: keep the substrate ABI in `utsushi-core` under a new public
module `utsushi_core::embed`, sibling to `utsushi_core::vfs`,
`utsushi_core::replay`, `utsushi_core::sink`, `utsushi_core::snapshot`,
`utsushi_core::port`, and `utsushi_core::conformance`.**

Justification (mirrors the UTSUSHI-020 / UTSUSHI-021 / UTSUSHI-022 /
UTSUSHI-023 / UTSUSHI-026 placement reasoning):

- `utsushi-core` already owns every shared type this module needs:
  `TextLine` and sink shapes (UTSUSHI-022), `AssetId` (UTSUSHI-020),
  `SnapshotRef` (UTSUSHI-023), `ObservationArtifactRef` (UTSUSHI-026 area),
  `EvidenceTier`, `RuntimeCapability`, `RuntimeCapabilityClass`,
  `RuntimeFeatureSupport`, `RuntimeFeatureStatus`, `RuntimePlaybackFeature`,
  `reject_unredacted_local_paths`. A standalone `utsushi-embed` crate would
  re-export all of these or take `utsushi-core` as a dep, doubling the dep
  edge on every downstream consumer for zero isolation win.
- Every downstream consumer (the Rust-side fixture embed serializer, the
  future WASM port, conformance dashboards) already depends on
  `utsushi-core`.
- The substrate has a small footprint (one envelope struct, three
  reference structs, one capability struct, one error enum). Module-level
  isolation inside `utsushi-core/src/embed/` matches the precedent set by
  `vfs/`, `sink/`, `port/`, `conformance/`, and `snapshot/`.
- **WASM-friendly without `wasm-bindgen`.** The ABI is JSON, not native types.
  `utsushi-core` already compiles to `wasm32-unknown-unknown` (no
  thread::spawn or file-system access on the public types crossing the
  boundary; the embed envelope itself touches none of the host-only
  helpers in `lib.rs`). Slice A does NOT introduce `wasm-bindgen` as a
  workspace dep; the ABI is "serialize `EmbedState` to JSON, return the
  string." A future WASM port slice adds `wasm-bindgen` glue on top of the
  same JSON envelope (see §11.1).

**Submodule layout under `crates/utsushi-core/src/embed/`:**

```
crates/utsushi-core/src/embed/
  mod.rs           # re-exports + crate docs + EMBED_SCHEMA_VERSION constant
  capability.rs    # EmbedCapability, EmbedCapabilityStatus, capabilities()
  state.rs         # EmbedState envelope + EmbedTrace
  artifact.rs      # EmbedArtifactRef (re-validates ObservationArtifactRef)
  redaction.rs     # serialize-time redaction wrappers
  diagnostics.rs   # EmbedError + codes::* stable semantic codes
```

`utsushi-core/src/lib.rs` re-exports the public surface:

```rust
pub mod embed;

pub use embed::{
    EmbedArtifactRef, EmbedCapability, EmbedCapabilityStatus, EmbedError,
    EmbedSchemaVersion, EmbedSnapshotRef, EmbedState, EmbedTrace, EmbedTraceLine,
    EMBED_SCHEMA_VERSION,
};
```

**Fixture web embed lives where the existing web review app lives:
`apps/runtime-web-review/`.** Survey result: that app already exists, is a
Vite + TypeScript shell, already renders fixture-produced runtime evidence,
and has `vitest` + `msw` plumbing. Slice A:

- Adds a single TypeScript module `apps/runtime-web-review/src/embed.ts`
  that fetches an `EmbedState` JSON (produced by `utsushi-core` test
  fixtures or the fixture adapter's test corpus) and renders the four
  ABI components (capabilities list, trace, current snapshot ref,
  artifact refs).
- Adds a single vitest file
  `apps/runtime-web-review/test/embed.test.ts` that asserts the rendered
  DOM never displays a `/home/`, `/tmp/`, drive-letter, or
  `file://`-shaped string regardless of what the (well-formed) input
  contains.
- Does NOT introduce a real WASM bundle, an engine-shaped player UI, or a
  jump/restart interaction. Those are out of scope (see §12).

No new workspace member is introduced. No new third-party dep is
introduced.

**No new crate for the substrate.** No new crate for the web embed.

## 3. ABI shape

The ABI is **a single JSON envelope, `EmbedState`**, plus a single
capability-listing endpoint that returns `Vec<EmbedCapability>` (also as
JSON). Everything serializes through `serde_json::Value`; no native Rust
type crosses the boundary. The schema version is pinned.

### 3.1 Schema version

```rust
/// Pinned schema version for the embed ABI wire form.
///
/// Bumping the constant is a breaking change for every embed host. The pin
/// is asserted on every `to_json_value` and on `from_json_value` so a
/// version drift surfaces as `EmbedError::SchemaVersionMismatch` rather
/// than a silent shape change.
pub const EMBED_SCHEMA_VERSION: &str = "0.1.0-alpha";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EmbedSchemaVersion(pub String);

impl EmbedSchemaVersion {
    pub fn current() -> Self { Self(EMBED_SCHEMA_VERSION.to_string()) }
    pub fn as_str(&self) -> &str { &self.0 }
}
```

### 3.2 `EmbedState` envelope

```rust
/// The single envelope every embed serializes when the host asks for
/// "current state." Engine-neutral; constructed by both the fixture
/// adapter and any future engine port.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedState {
    /// Pinned schema version. Asserted on validate.
    pub schema_version: EmbedSchemaVersion,
    /// Stable, public adapter id (e.g. `"utsushi-fixture"`). Engine-
    /// neutral string; the ABI does not interpret. Required so two
    /// snapshots / traces from different adapters are not silently mixed
    /// at the host.
    pub adapter_id: String,
    /// Adapter version. Public string, free-form.
    pub adapter_version: String,
    /// Capability declaration. Sorted deterministically by
    /// `capability_id` so two equivalent envelopes serialize identically.
    /// MUST include every capability the host can ask about; "not
    /// declared" is not a valid posture for any UTSUSHI-024-era capability.
    pub capabilities: Vec<EmbedCapability>,
    /// Current trace. The trace MAY be empty (host asked for state before
    /// any text emission); the field is always present so the host can
    /// `Array.isArray(state.trace.lines)` without a null check.
    pub trace: EmbedTrace,
    /// Reference to the current snapshot. Id-only. See §6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_snapshot: Option<EmbedSnapshotRef>,
    /// Artifact references for the current playback session. Managed URIs
    /// only; see §7.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_refs: Vec<EmbedArtifactRef>,
}

impl EmbedState {
    pub fn validate(&self) -> Result<(), EmbedError>;
    pub fn to_json_value(&self) -> Result<Value, EmbedError>;
    pub fn from_json_value(value: Value) -> Result<Self, EmbedError>;
}
```

Validation passes (run on every `to_json_value` / `from_json_value`):

- `schema_version == EMBED_SCHEMA_VERSION`.
- `adapter_id` non-empty, ASCII-printable, no whitespace.
- `adapter_version` non-empty.
- `capabilities` is non-empty, contains no duplicate `capability_id`, and
  is sorted by `capability_id` (the deterministic-order claim).
- Each `EmbedCapability::validate()` passes.
- `trace.validate()` passes.
- Each `artifact_refs[i].validate()` passes.
- If `current_snapshot.is_some()`, `current_snapshot.unwrap().validate()`
  passes AND its `adapter_id` equals `EmbedState::adapter_id` (no
  cross-adapter snapshots leaking through; see §6).
- The fully serialized JSON form passes
  `reject_unredacted_local_paths` end-to-end.

### 3.3 `EmbedTrace`

```rust
/// Trace surface. The trace ABI mirrors the sink `TextLine` shape from
/// UTSUSHI-022 because the trace IS the sink-emitted text log; the ABI
/// reuses the same engine-neutral type rather than reinventing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedTrace {
    /// Pinned schema version; same constant as the envelope. Asserted on
    /// validate. Carrying it twice lets a host that fetches only the
    /// trace (e.g. tail-streaming) confirm the version independently.
    pub schema_version: EmbedSchemaVersion,
    /// Sequence of text lines as the sink saw them, in emission order.
    /// Engine-neutral: this is the same `TextLine` UTSUSHI-022 defined.
    pub lines: Vec<EmbedTraceLine>,
}

/// Thin newtype wrapper around `TextLine` so the ABI module owns the
/// validation entry point and can add embed-specific fields later
/// without re-exporting sink internals.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedTraceLine {
    #[serde(flatten)]
    pub text_line: crate::TextLine,
}

impl EmbedTrace {
    pub fn validate(&self) -> Result<(), EmbedError>;
}

impl EmbedTraceLine {
    pub fn validate(&self) -> Result<(), EmbedError>;
}
```

The `#[serde(flatten)]` choice keeps the wire shape compatible with the
existing `TextLine` JSON exactly (camelCase fields: `lineId`,
`evidenceTier`, `text`, `speaker`, `textSurface`, `bridgeRef`,
`sourceAsset`). The `sourceAsset` field is already an `AssetId`, so
no host path can leak through.

### 3.4 ABI surface summary

The ABI is two functions and one envelope:

| Function                               | Returns                     | Purpose                                                                                     |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `embed_capabilities(adapter) -> Value` | `Vec<EmbedCapability>` JSON | Capability discovery. Called by the host BEFORE any `embed_state` call.                     |
| `embed_state(adapter) -> Value`        | `EmbedState` JSON           | Returns the current envelope.                                                               |
| `EmbedState::from_json_value(value)`   | `Result<EmbedState, _>`     | Host-side parse (only needed by Rust-side test fixtures and consumers re-validating input). |

A host that wants a "do I support X?" check calls `embed_capabilities`,
inspects the list, and only invokes `embed_state` if the capability is
declared (see §5).

The substrate does NOT define the "load a session," "play forward," "jump"
verbs — those are deferred to a later embed-driver slice. UTSUSHI-024
covers the **observable surface** only: what the embed can be asked to
show. The fixture web embed renders that observable surface from a
canned `EmbedState`.

## 4. `EmbedCapability` declaration

```rust
/// Capability declaration. Stable, sorted, non-empty list returned by
/// `embed_capabilities()` and embedded inside every `EmbedState`. The host
/// MUST consult this before invoking any embed verb.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedCapability {
    /// Stable string id. The substrate pre-declares the set (see below);
    /// engine ports cannot invent new ids without an ABI bump.
    pub capability_id: EmbedCapabilityId,
    /// Whether the embed supports, partially supports, or does not
    /// support this capability.
    pub status: EmbedCapabilityStatus,
    /// Evidence-tier ceiling the embed can guarantee for this capability.
    /// `None` iff `status == Unsupported`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_tier_ceiling: Option<crate::EvidenceTier>,
    /// Free-form, public-safe phrases describing partial support or
    /// fixture-only limitations. Validated as non-blank strings; never a
    /// host path.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub limitations: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedCapabilityId {
    /// Embed can return a current `EmbedState` envelope at all.
    State,
    /// Embed can return a non-empty `EmbedTrace` lines vector.
    Trace,
    /// Embed can return a non-null `current_snapshot` ref.
    Snapshot,
    /// Embed exposes `artifact_refs` that resolve to managed runtime
    /// artifact URIs.
    ArtifactRefs,
    /// Embed declares deterministic-fixture posture (UTSUSHI-fixture-class
    /// embed). Engine ports declare a different posture; the field is the
    /// only one tied to fixture vs engine.
    DeterministicFixture,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedCapabilityStatus {
    Supported,
    Partial,
    Unsupported,
}

impl EmbedCapability {
    pub fn supported(id: EmbedCapabilityId, ceiling: crate::EvidenceTier) -> Self;
    pub fn partial(id: EmbedCapabilityId, ceiling: crate::EvidenceTier,
                   limitations: Vec<String>) -> Self;
    pub fn unsupported(id: EmbedCapabilityId, limitations: Vec<String>) -> Self;

    pub fn validate(&self) -> Result<(), EmbedError>;
}
```

Validation:

- `Supported | Partial` MUST carry `Some(evidence_tier_ceiling)`.
- `Unsupported` MUST carry `None` for `evidence_tier_ceiling`.
- `Partial` MUST carry at least one `limitation` entry (otherwise "what
  is partial about it?").
- Every `limitation` non-blank, passes `reject_unredacted_local_paths`.

The pre-declared id enum mirrors UTSUSHI-023's `StateNamespace` posture:
new capabilities are typed enum extensions; engine ports cannot smuggle
ad-hoc strings.

### 4.1 Engine-neutrality of the capability list

`EmbedCapabilityId` is intentionally **shaped around the ABI's observable
surface**, not around any one engine. There is no `"rpgm_savefile"` or
`"reallive_sel_stack"` variant. An engine port that wants to expose
deeper inspection adds a new `EmbedCapabilityId` variant in a future
ABI bump, accompanied by a stable shape under `EmbedState` for that
capability. This slice does not pre-bake any.

### 4.2 Sorting and determinism

`embed_capabilities()` and `EmbedState::capabilities` both return the list
sorted ascending by `(capability_id as u8, capability_id.as_str())`. The
test plan asserts deterministic order on both serialization sides. This is
the audit-focus "stable order" guarantee that lets dashboards diff two
capability listings reliably.

## 5. Capability discovery flow

The host-side flow the ABI commits to:

1. Host calls `embed_capabilities()`, gets a JSON `Vec<EmbedCapability>`.
2. Host inspects the vec for the capability it wants to use (e.g.
   `Capability::Snapshot`).
3. If the capability's `status == Unsupported`, the host short-circuits;
   it does NOT call `embed_state()` expecting the field to be present.
   The host's UI surface MUST render the `limitations` strings so the user
   sees "this fixture has no snapshot support" instead of silent failure.
4. If `status == Supported | Partial`, the host calls `embed_state()` and
   reads the relevant field. The substrate guarantees the field is
   present iff status >= Partial.
5. If the host calls `embed_state()` and tries to read a field whose
   capability is declared `Unsupported`, the substrate returns a typed
   `EmbedError::CapabilityNotSupported { capability_id }` rather than a
   silent `None`. (Concretely: the substrate adds typed accessor methods
   on `EmbedState` that consult `capabilities` before returning the
   field — see §5.1.)

### 5.1 Typed accessors

```rust
impl EmbedState {
    /// Return the trace only if `Capability::Trace` is declared
    /// `Supported | Partial`. Otherwise return
    /// `Err(EmbedError::CapabilityNotSupported)`. Hosts that bypass the
    /// accessor and read `state.trace` directly see an empty `lines`
    /// vector — which is the WASM-portable degraded shape — but the
    /// typed accessor is the documented entry point.
    pub fn trace(&self) -> Result<&EmbedTrace, EmbedError>;

    pub fn current_snapshot(&self) -> Result<Option<&EmbedSnapshotRef>, EmbedError>;

    pub fn artifact_refs(&self) -> Result<&[EmbedArtifactRef], EmbedError>;

    pub fn capability(&self, id: EmbedCapabilityId)
        -> Option<&EmbedCapability>;
    pub fn is_supported(&self, id: EmbedCapabilityId) -> bool;
}
```

Hosts written in TypeScript will not use the Rust accessors; the
TypeScript side gets a parallel runtime check in the web embed module
(see §10.1). The Rust accessors are the documented contract; the TS
module implements the same gating against the same JSON.

### 5.2 Pre-playback visibility

The capability list is delivered **before any playback frame ticks**
because the ABI has no "tick" verb in this slice — the only way to ask
the embed for anything is via `embed_capabilities()` and `embed_state()`,
both of which are read-only. A host that wants to render a "play"
button MUST first inspect the capability list. The web embed UI in
§10 renders capability status as the top of the page so the user can
see the gate before invoking any action.

This is the structural answer to the audit-focus "unsupported
capabilities discovered only after silent failure" item.

## 6. `EmbedSnapshotRef`

The ABI does NOT carry full `Snapshot` payloads. It carries the lightweight
reference defined in UTSUSHI-023:

```rust
/// Embed-boundary snapshot reference. Id, content hash, payload size,
/// and adapter id only. Never carries the state tree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedSnapshotRef {
    /// UUIDv7-shaped snapshot id (matches `SnapshotRef::snapshot_id`).
    pub snapshot_id: String,
    /// Inspectable id from the producing port. Asserted by
    /// `EmbedState::validate` to equal the envelope's `adapter_id` — the
    /// substrate does not let an embed serialize a foreign-adapter
    /// snapshot.
    pub adapter_id: String,
    /// Content hash of the canonical-serialized `Snapshot` JSON
    /// (lowercase hex, fixed length; matches the snapshot module's
    /// `BYTES_HASH_HEX_LEN` posture). Lets the host detect "did this
    /// snapshot change?" without downloading the payload.
    pub content_hash: String,
    /// Serialized payload byte length. Bounded by the snapshot module's
    /// `SNAPSHOT_MAX_SERIALIZED_BYTES`. Lets the host size a future
    /// resolve request.
    pub size_bytes: u32,
    /// Evidence tier declared on the underlying snapshot. Snapshots are
    /// E2-by-default and capped at E3 by UTSUSHI-023; the ABI mirrors.
    pub evidence_tier: crate::EvidenceTier,
}

impl EmbedSnapshotRef {
    pub fn validate(&self) -> Result<(), EmbedError>;
}
```

Validation:

- `snapshot_id` parses through `SnapshotId::parse` (UUIDv7 shape).
- `adapter_id` non-blank, ASCII printable.
- `content_hash` matches `^[0-9a-f]{64}$` (64 lowercase hex chars).
- `size_bytes <= SNAPSHOT_MAX_SERIALIZED_BYTES` (16 KiB ceiling re-exported
  from UTSUSHI-023).
- `evidence_tier <= EvidenceTier::E3`.

The substrate provides a one-liner `From<&Snapshot> for EmbedSnapshotRef`
that derives `content_hash`, `size_bytes`, and `evidence_tier` from a
real `Snapshot`. The fixture web embed uses canned JSON; the real-WASM
follow-up uses the helper.

### 6.1 No payload resolution in this slice

Resolving an `EmbedSnapshotRef` to a full `Snapshot` is a separate verb
(read the underlying snapshot store) and is **deferred**. The fixture
embed never resolves; it just displays the ref. The future engine-port
WASM slice will add a `embed_resolve_snapshot(id) -> Snapshot` verb,
which validates the id against the declared `Capability::Snapshot` and
the envelope's `adapter_id`.

## 7. `EmbedArtifactRef`

Artifact references re-use UTSUSHI-026's `ObservationArtifactRef` shape
but with a thin embed-side wrapper that re-validates on the ABI side and
ensures the URI passes `validate_runtime_artifact_uri`:

```rust
/// Embed-boundary artifact reference. Wraps `ObservationArtifactRef` so
/// the ABI module owns the validator and the wire form is decoupled from
/// any future `ObservationArtifactRef` field additions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedArtifactRef {
    /// Stable per-run artifact id; non-blank.
    pub artifact_id: String,
    /// Stable artifact kind string (matches `RuntimeArtifactKind::artifact_kind`).
    pub artifact_kind: String,
    /// Managed runtime URI. MUST start with
    /// `artifacts/utsushi/runtime/` and pass `validate_runtime_artifact_uri`.
    pub uri: String,
    /// Optional MIME type label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

impl EmbedArtifactRef {
    pub fn validate(&self) -> Result<(), EmbedError>;
}

impl From<&crate::ObservationArtifactRef> for EmbedArtifactRef { ... }
```

Validation:

- `artifact_id` non-blank.
- `artifact_kind` non-blank, ASCII.
- `uri` passes `validate_runtime_artifact_uri` (rejects absolute paths,
  drive letters, `data:` / `blob:` / `file:` schemes, traversal).
- `media_type`, if present, non-blank.

**Host paths are structurally impossible** in this struct: the URI must
start with the managed prefix; the validator rejects everything else.

### 7.1 Private asset policy

The fixture web embed renders ONLY managed-prefix artifacts. The
substrate validator is the structural gate; there is no "private asset"
field in the ABI. If a future engine port wants to expose engine-private
profile material (save files, RNG state), it MUST do so by:

1. Writing the material to a managed `RuntimeArtifactRoot` location.
2. Carrying it across the ABI as an `EmbedArtifactRef` with `artifact_kind`
   describing the kind (e.g. `"save_state"`).
3. Declaring a corresponding `EmbedCapabilityId` variant.

This slice does NOT add such a variant; the policy is "fixture-only,
managed URIs only, no private material." The audit-focus "browser ABI
exposing private assets" item is met because the ABI has no field
shaped to hold a non-managed reference.

## 8. Redaction policy

The substrate runs `reject_unredacted_local_paths` at four layers, with the
same defense-in-depth posture as UTSUSHI-021 / UTSUSHI-022 / UTSUSHI-023:

1. **Per-field validators**: `EmbedCapability::limitations`,
   `EmbedSnapshotRef::adapter_id`, `EmbedArtifactRef::uri` (the URI
   validator), and `EmbedTraceLine` (via `TextLine`'s own sink
   validation) reject host-path-shaped values on construction.
2. **`EmbedState::validate`** runs `reject_unredacted_local_paths` on the
   full serialized JSON form. Any field that somehow accumulated a host
   path fails with `EmbedError::RedactionViolation { field_path }`.
3. **`EmbedTrace::validate`** runs the same filter on its sub-tree so a
   trace fetched independently (without the envelope) is also clean.
4. **`embed_capabilities()`** runs the filter on the serialized
   `Vec<EmbedCapability>` form before returning.

The filter is the same `reject_unredacted_local_paths` re-exported from
`utsushi_core::redaction`; no embed-specific filter is introduced.

### 8.1 Public-fixture-mode constants

```rust
/// Max serialized envelope size (JSON, bytes). 32 KiB — 2× the snapshot
/// ceiling because the envelope can carry a moderate number of trace lines
/// and artifact refs in addition to a `SnapshotRef`.
pub const EMBED_STATE_MAX_SERIALIZED_BYTES: usize = 32 * 1024;

/// Max number of trace lines a single `EmbedTrace` can carry. Trace
/// windows beyond this MUST be paginated by a higher-level verb (deferred).
/// 256 lines comfortably fit under the byte ceiling for any realistic
/// `TextLine` shape.
pub const EMBED_TRACE_MAX_LINES: usize = 256;

/// Max number of artifact refs a single envelope can carry. 64 covers
/// every realistic frame-capture + recording corpus per session.
pub const EMBED_MAX_ARTIFACT_REFS: usize = 64;

/// Max number of capabilities. The pre-declared `EmbedCapabilityId`
/// enum has 5 variants today; the ceiling is loose so future ABI bumps
/// have headroom.
pub const EMBED_MAX_CAPABILITIES: usize = 32;
```

`EmbedState::validate` asserts every ceiling. A trace with 300 lines fails
with `EmbedError::TraceTooLarge { observed, ceiling }`; an envelope over
32 KiB serialized fails with `EmbedError::EnvelopeTooLarge`.

## 9. Semantic errors

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmbedError {
    /// Schema version mismatch on `from_json_value` or `validate`.
    SchemaVersionMismatch { observed: String, expected: &'static str },

    /// Host asked for a field whose capability is declared `Unsupported`.
    CapabilityNotSupported { capability_id: EmbedCapabilityId },

    /// `EmbedCapability` validation failed (e.g. supported without
    /// ceiling, partial without limitations).
    InvalidCapability { capability_id: EmbedCapabilityId, reason: String },

    /// Duplicate capability id in the declaration list.
    DuplicateCapability { capability_id: EmbedCapabilityId },

    /// Capability list is unsorted.
    UnsortedCapabilities,

    /// Adapter id failed shape validation (blank, whitespace, non-ASCII).
    InvalidAdapterId { observed: String },

    /// `EmbedState::current_snapshot`'s adapter id does not equal the
    /// envelope's `adapter_id`.
    SnapshotAdapterIdMismatch { envelope: String, snapshot: String },

    /// `EmbedSnapshotRef` failed shape validation (bad uuid, hash shape,
    /// size > ceiling, evidence tier > E3).
    InvalidSnapshotRef { reason: String },

    /// `EmbedArtifactRef` failed shape validation (URI not under managed
    /// prefix, traversal, scheme leak).
    InvalidArtifactRef { reason: String },

    /// A field anywhere in the serialized envelope matched
    /// `looks_like_local_path`.
    RedactionViolation { field_path: String },

    /// Envelope size exceeded `EMBED_STATE_MAX_SERIALIZED_BYTES`.
    EnvelopeTooLarge { size: usize, ceiling: usize },

    /// Trace exceeded `EMBED_TRACE_MAX_LINES`.
    TraceTooLarge { observed: usize, ceiling: usize },

    /// Artifact ref list exceeded `EMBED_MAX_ARTIFACT_REFS`.
    ArtifactRefsTooLarge { observed: usize, ceiling: usize },

    /// Capability list exceeded `EMBED_MAX_CAPABILITIES`.
    CapabilitiesTooLarge { observed: usize, ceiling: usize },

    /// Generic JSON serialization / deserialization error.
    Json { reason: String },
}

impl EmbedError {
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::SchemaVersionMismatch { .. } => "utsushi.embed.schema_version_mismatch",
            Self::CapabilityNotSupported { .. } => "utsushi.embed.capability_not_supported",
            Self::InvalidCapability { .. } => "utsushi.embed.invalid_capability",
            Self::DuplicateCapability { .. } => "utsushi.embed.duplicate_capability",
            Self::UnsortedCapabilities => "utsushi.embed.unsorted_capabilities",
            Self::InvalidAdapterId { .. } => "utsushi.embed.invalid_adapter_id",
            Self::SnapshotAdapterIdMismatch { .. } => "utsushi.embed.snapshot_adapter_id_mismatch",
            Self::InvalidSnapshotRef { .. } => "utsushi.embed.invalid_snapshot_ref",
            Self::InvalidArtifactRef { .. } => "utsushi.embed.invalid_artifact_ref",
            Self::RedactionViolation { .. } => "utsushi.embed.redaction_violation",
            Self::EnvelopeTooLarge { .. } => "utsushi.embed.envelope_too_large",
            Self::TraceTooLarge { .. } => "utsushi.embed.trace_too_large",
            Self::ArtifactRefsTooLarge { .. } => "utsushi.embed.artifact_refs_too_large",
            Self::CapabilitiesTooLarge { .. } => "utsushi.embed.capabilities_too_large",
            Self::Json { .. } => "utsushi.embed.json",
        }
    }
}

impl std::error::Error for EmbedError {}
```

`EmbedError: std::error::Error + Send + Sync + 'static`, converts to
`Box<dyn std::error::Error>` so it lives inside `UtsushiResult<T>`.

The `codes::*` module in `embed::diagnostics` exposes
`pub const ALL: &[&str] = &[...]` so the conformance schema package and
`just schema` can verify the `utsushi.embed.*` prefix is registered
without retrofitting (mirrors UTSUSHI-022 / UTSUSHI-023 precedent).

**No silent best-effort path exists.** A capability-mismatched call
returns a typed error. The contract has no "return Ok with empty trace"
branch.

## 10. Test plan

Behavior-first names per `docs/dev/testing-standard.md`. Unit tests live under
`crates/utsushi-core/src/embed/{capability,state,artifact,redaction,diagnostics}.rs`
with `#[cfg(test)] mod tests`. Integration tests live under
`crates/utsushi-core/tests/embed_*.rs`. TypeScript tests live under
`apps/runtime-web-review/test/embed.test.ts`.

### 10.1 `EmbedCapability` and capability listing

- `embed_capability_supported_requires_evidence_tier_ceiling()`.
- `embed_capability_partial_requires_at_least_one_limitation()`.
- `embed_capability_unsupported_rejects_evidence_tier_ceiling()`.
- `embed_capability_round_trips_through_serde_json()`.
- `embed_capability_list_sorted_by_id_is_deterministic()`.
- `embed_capability_list_rejects_duplicate_ids()`.
- `embed_capability_list_rejects_unsorted_input_on_validate()`.
- `embed_capability_limitations_with_host_path_fail_redaction()`.
- `embed_capabilities_helper_returns_list_in_deterministic_order()` —
  asserts two calls return byte-identical JSON.

### 10.2 `EmbedTrace` / `EmbedTraceLine`

- `embed_trace_line_wraps_text_line_with_camelcase_wire_form()`.
- `embed_trace_line_with_local_path_in_speaker_fails_redaction()`.
- `embed_trace_serialized_form_passes_reject_unredacted_local_paths()`.
- `embed_trace_validate_rejects_more_than_max_lines()`.
- `embed_trace_round_trips_through_serde_json()`.
- `embed_trace_line_source_asset_uses_vfs_asset_id()` — load-bearing
  assertion that the trace cannot carry a raw path.

### 10.3 `EmbedSnapshotRef`

- `embed_snapshot_ref_validate_accepts_well_formed_ref()`.
- `embed_snapshot_ref_rejects_non_uuid7_snapshot_id()`.
- `embed_snapshot_ref_rejects_non_hex_content_hash()`.
- `embed_snapshot_ref_rejects_size_above_snapshot_ceiling()`.
- `embed_snapshot_ref_rejects_evidence_tier_above_e3()`.
- `embed_snapshot_ref_from_snapshot_derives_content_hash_size_and_tier()`.
- `embed_snapshot_ref_round_trips_through_serde_json()`.

### 10.4 `EmbedArtifactRef`

- `embed_artifact_ref_accepts_managed_runtime_uri()`.
- `embed_artifact_ref_rejects_absolute_host_path()`.
- `embed_artifact_ref_rejects_data_blob_file_uri_schemes()`.
- `embed_artifact_ref_rejects_uri_with_path_traversal()`.
- `embed_artifact_ref_from_observation_artifact_ref_preserves_fields()`.

### 10.5 `EmbedState` envelope

- `embed_state_validate_accepts_well_formed_envelope()`.
- `embed_state_rejects_unsupported_schema_version_on_from_json_value()`.
- `embed_state_rejects_blank_adapter_id()`.
- `embed_state_rejects_snapshot_with_mismatched_adapter_id()`.
- `embed_state_rejects_envelope_serialized_over_32_kib()`.
- `embed_state_rejects_artifact_refs_over_ceiling()`.
- `embed_state_round_trips_through_serde_json()`.
- `embed_state_serialized_form_passes_reject_unredacted_local_paths()`.
- `embed_state_with_empty_trace_serializes_with_lines_array()` — load-bearing
  for the host-side `Array.isArray` claim.

### 10.6 Typed accessors and capability gating

- `embed_state_trace_returns_err_when_trace_capability_is_unsupported()`.
- `embed_state_current_snapshot_returns_err_when_snapshot_capability_is_unsupported()`.
- `embed_state_artifact_refs_returns_err_when_capability_is_unsupported()`.
- `embed_state_typed_accessor_returns_field_when_capability_is_partial()`.
- `embed_state_typed_accessor_returns_field_when_capability_is_supported()`.
- `embed_state_is_supported_returns_false_for_undeclared_capability()`.

### 10.7 Fixture-driven golden envelope (integration)

`crates/utsushi-core/tests/embed_fixture_state.rs`:

- `fixture_embed_state_round_trips_through_canonical_json()`:
  - Build a fixture `EmbedState` with: 5 trace lines, 2 artifact refs
    (one screenshot, one trace_log), 1 snapshot ref, full capability list
    (3 supported, 1 partial, 1 unsupported).
  - Serialize → JSON.
  - Compare against a golden file at
    `crates/utsushi-core/tests/fixtures/embed_state_golden.json`.
  - Deserialize the JSON back and assert structural equality with the
    constructed value.

- `fixture_embed_state_capability_listing_matches_envelope_capabilities()`:
  - Call `embed_capabilities(&fixture)` and `embed_state(&fixture)`.
  - Assert both return identical capability vectors (same length,
    same order, byte-identical JSON for the capabilities slice).

- `fixture_embed_state_with_unsupported_snapshot_capability_omits_current_snapshot()`:
  - Build an envelope with `Capability::Snapshot = Unsupported`.
  - Assert `current_snapshot` is `None`.
  - Assert calling `state.current_snapshot()` returns
    `EmbedError::CapabilityNotSupported`.

### 10.8 Redaction (integration)

`crates/utsushi-core/tests/embed_redaction.rs`:

- `embed_state_with_temp_path_in_capability_limitation_fails_validate()`:
  - Build an `EmbedCapability` with a limitation string containing
    `/tmp/secret`. Assert `EmbedError::RedactionViolation`.
- `embed_state_artifact_ref_with_file_uri_fails_validate()`:
  - Build an `EmbedArtifactRef { uri: "file:///etc/passwd" }`.
  - Assert `EmbedError::InvalidArtifactRef`.
- `embed_state_trace_line_with_drive_letter_in_speaker_fails_validate()`:
  - Build a `TextLine` with `speaker: Some("C:\\Users\\x".into())`.
  - Wrap into envelope.
  - Assert `EmbedError::RedactionViolation` with the speaker field path.
- `embed_capabilities_with_redaction_violation_in_limitation_fails_serialize()`:
  - Build the capability list outside an envelope.
  - Assert `embed_capabilities` returns the same typed error.

### 10.9 No regression in `utsushi-fixture`

`cargo test -p utsushi-fixture` must pass unchanged. The fixture adapter
is NOT refactored to expose an embed surface in this slice (Slice B
posture). The existing 22 tests must continue to pass. No new test is
added under `utsushi-fixture`.

### 10.10 Web embed (TypeScript)

`apps/runtime-web-review/test/embed.test.ts` runs under `vitest`:

- `embed_renders_capability_list_in_declared_order()` — render the
  capability list and assert DOM order matches `state.capabilities`.
- `embed_renders_disabled_action_when_capability_is_unsupported()` —
  assert the "show snapshot" button is `disabled` when
  `Capability::Snapshot` is unsupported, with the limitations rendered
  as visible text. (Audit-focus mitigation surface.)
- `embed_renders_trace_lines_with_engine_neutral_text()` — render 3
  lines, assert text content is present, no `sourceAsset` raw bytes.
- `embed_renders_artifact_uris_under_managed_prefix_only()` — render 2
  artifact refs, assert the rendered URI starts with
  `artifacts/utsushi/runtime/`.
- `embed_refuses_to_render_envelope_with_unknown_schema_version()` —
  feed an envelope with the wrong schema version; assert the page
  surfaces an error banner (text contains `schema_version_mismatch`).
- `embed_dom_never_contains_host_path_shapes()` — render the golden
  envelope; assert `document.body.innerHTML` matches none of
  `/^|[^A-Za-z]\/(home|tmp|var|root|Users)\//`, no drive letters
  (`/[A-Z]:[\\\/]/`), and no `file://` / `data:` / `blob:` schemes.
  This is the load-bearing audit-focus assertion on the TS side.

### 10.11 Test placement summary

- Rust unit tests: `crates/utsushi-core/src/embed/{capability,state,artifact,redaction,diagnostics}.rs`.
- Rust integration: `crates/utsushi-core/tests/embed_fixture_state.rs`,
  `embed_redaction.rs`.
- Golden fixture: `crates/utsushi-core/tests/fixtures/embed_state_golden.json`.
- TS tests: `apps/runtime-web-review/test/embed.test.ts`.
- TS embed module: `apps/runtime-web-review/src/embed.ts`.

## 11. Verification commands

```
cargo test -p utsushi-core embed
cargo test -p utsushi-core
cargo test -p utsushi-fixture
pnpm --filter @itotori/runtime-web-review test
pnpm --filter @itotori/runtime-web-review typecheck
just check
just test
```

Reasoning, per the brief:

- `cargo test -p utsushi-core embed` is the targeted bar for the new
  module's unit + integration tests.
- `cargo test -p utsushi-core` is the substrate bar — confirms embed
  integration does not regress VFS, replay, sink, port, snapshot, or
  conformance tests.
- `cargo test -p utsushi-fixture` confirms no regression in the fixture
  adapter; the embed module is additive and the fixture adapter is not
  refactored in this slice.
- The two `pnpm` invocations exercise the web embed module and TS
  type-check on `apps/runtime-web-review/`.
- `just check` (fmt, clippy, schema lint, ts:typecheck, spec DAG validate)
  is the local pre-CI bar.
- `just test` runs the full workspace test suite.

No `cargo test -p utsushi-embed` because no new crate is introduced. No
WASM build target is added in this slice.

### 11.1 No `wasm-bindgen` in this slice

The substrate's WASM-friendliness is a **structural** claim, not a
**bundled** claim: every type crossing the ABI serializes to JSON, no
native Rust type is in the wire form, and `utsushi-core` compiles to
`wasm32-unknown-unknown` already. The actual `wasm-bindgen` glue (a JS
`@itotori/utsushi-embed` package wrapping `embed_capabilities` and
`embed_state` as exported WASM functions) is a separate follow-up slice
that consumes the same JSON envelope. The fixture web embed in
§10.10 uses canned JSON fetched via `vitest`'s `msw` plumbing, not a
WASM bundle.

## 12. Risks and unknowns

### 12.1 ABI evolution under future engine ports

The ABI is pinned at `0.1.0-alpha`. Adding a new `EmbedCapabilityId`
variant is a minor bump on the schema (enum is non-exhaustive on the
read side via custom Deserialize that fails closed); adding a new
field on `EmbedState` is a minor bump if optional, a major bump if
required. Risk: a future engine port wants a capability the
substrate cannot express (e.g. "expose RNG state"). Mitigation: the
ABI deliberately exposes ONLY four observables (capabilities, trace,
snapshot ref, artifact refs) and forces any "expose X" need through
the artifact-ref + managed-URI path or a typed capability bump. Both
routes are audit-visible.

### 12.2 WASM-bindgen overhead

`wasm-bindgen` is not introduced in this slice. Risk: when the real
WASM port slice arrives, the JSON-over-the-wall posture may turn out
slower than direct typed JS bindings. Mitigation: the wire format
(JSON, bounded sizes, sorted keys) is identical to what any future
typed binding would marshal, so a switch to a typed binding is an
additive optimization, not a schema bump. The 32 KiB envelope
ceiling makes the worst-case per-call payload small enough that the
JSON-bridge cost is negligible at the human-interaction rate the
review UI cares about.

### 12.3 Private-asset policy at fixture vs production layer

The substrate's policy ("managed URIs only, no private asset field")
is enforced structurally. Risk: a production engine port wants to
expose save-state material to the host UI for debugging. Mitigation:
the only path is "write the material as a managed
`RuntimeArtifact` under `RuntimeArtifactRoot` and reference it via
`EmbedArtifactRef`," which keeps the substrate's redaction posture
intact and forces the engine port to think about retention /
ownership. Slice A does not add the corresponding
`EmbedCapabilityId` variant; production ports add it under a future
slice with a corresponding ABI bump.

### 12.4 Capability list deterministic order

`EmbedCapability` is sorted by `(EmbedCapabilityId as u8,
capability_id.as_str())`. Risk: future variants change `as u8`
values if inserted in the middle of the enum, which would reorder
older envelopes. Mitigation: new variants are appended to the end of
`EmbedCapabilityId`; the sort secondary key is the stable string
form so even a numeric reshuffle preserves stable lexicographic
order. The test
`embed_capability_list_sorted_by_id_is_deterministic` asserts
byte-identical JSON on two consecutive calls.

### 12.5 Trace pagination

`EMBED_TRACE_MAX_LINES = 256` is a small ceiling. Risk: long
playback sessions overflow. Mitigation: the substrate does not
own pagination in this slice — the host calls `embed_state()` for
"current state at this moment"; a paginated trace-tail verb is a
follow-up. The 256 ceiling is loud enough that nobody silently
caps a real run; the typed `EmbedError::TraceTooLarge` makes the
boundary explicit.

### 12.6 Mixed-case wire form (replay log inheritance)

UTSUSHI-021's `ReplayLog` ships a mixed-case wire form (camelCase
top-level + snake_case input event payload fields). UTSUSHI-024
does NOT inherit `ReplayLog` directly — the trace surface is
`TextLine`-shaped, which is consistently camelCase. The
`EmbedTrace` wire form is therefore clean. Risk: a future slice
that adds a `replay_log_ref` field to `EmbedState` would inherit
the mixed case. Mitigation: deferred until the replay-log-tail
verb is added; the case-normalization follow-up tracked on
UTSUSHI-021's audit is the cleanest resolution and should land
before any embed-side replay-log field.

### 12.7 Coordination with iter-5 sibling nodes

UTSUSHI-028 (snapshot conformance) is iter-5 parallel. UTSUSHI-028
consumes `Snapshot`/`SnapshotRef` for conformance results; it does
not touch the embed surface. KAIFUU-084 and ITOTORI-018 are
sibling iter-5 nodes; only UTSUSHI-024 touches
`utsushi-core/src/embed/`. Merge conflicts on `lib.rs` re-exports
are additive (one `pub use embed::{...};` line on this side). No
shared private type changes between the four nodes.

### 12.8 `wasm32` compile target

The substrate types and tests must compile under `wasm32`. Risk:
`cargo test -p utsushi-core embed` does not exercise the wasm
target by default. Mitigation: the implementation worker adds a
`#[cfg_attr(target_arch = "wasm32", allow(unused))]` posture only if
needed; the substrate uses no thread / file / clock primitives in
the `embed` module so the default build should compile under
`wasm32` without changes. A targeted `cargo check --target
wasm32-unknown-unknown -p utsushi-core` is added to the
verification list IF the workspace's `just check` does not already
run it. Survey of `justfile`: workspace `just check` does not run
the wasm target; the implementation worker adds a one-off `cargo
check --target wasm32-unknown-unknown -p utsushi-core` as a
documented "did this compile under wasm" sanity step, not a CI
gate, until the real WASM port slice lands.

## 13. Out of scope

- **Real WASM bundle / `wasm-bindgen` glue.** The substrate ABI is
  JSON; a follow-up slice wraps it as an exported WASM function set.
  This node ships the Rust-side types, the JSON wire form, and a
  TypeScript embed module that consumes canned JSON.
- **Engine-port embeds.** The fixture embed is the only embed in this
  slice. RealLive, RPGM, Siglus engine ports each add their own
  embed adapter under their own node.
- **Full engine parity claim.** The brief is explicit: fixture level
  only. Capability declarations explicitly carry
  `Capability::DeterministicFixture` so dashboards cannot confuse
  fixture-mode with engine-mode evidence.
- **Snapshot payload resolution at the embed boundary.** This slice
  carries `EmbedSnapshotRef` (id + hash + size); resolving to a full
  `Snapshot` is a follow-up `embed_resolve_snapshot` verb tracked on
  the WASM port slice.
- **Replay-log streaming verb.** The trace surface is a snapshot of
  emitted text lines; a paginated tail / streaming verb is deferred.
- **Secret / key handling.** The ABI carries no secret material by
  construction. Any future slice that wants to expose engine
  profile material does so through the managed-artifact path with a
  corresponding capability bump.
- **Engine-port-specific capability variants.** No
  `Capability::RealLiveSelStack` / `Capability::RpgmSaveFile`
  variants are added. Engine ports add their own under their own
  ABI bump.
- **`utsushi-fixture` refactor to implement the embed surface.**
  Mirrors the Slice A posture UTSUSHI-020 / UTSUSHI-022 / UTSUSHI-023
  took. Sibling implementation slice once Slice A merges.

## 14. Worker scoping

Recommendation: **one implementation slice** owned by a single worker.

Rationale:

- The five new modules (`capability`, `state`, `artifact`, `redaction`,
  `diagnostics`) are tightly coupled. `EmbedState::validate` runs the
  same redaction walk that `EmbedTrace::validate` runs; capability
  gating in `EmbedState::trace` / `EmbedState::current_snapshot` calls
  into the same `EmbedCapabilityId` lookup; the artifact-ref validator
  is the URI gate `EmbedState::validate` depends on. A multi-PR split
  would create cross-PR coupling on shared private helpers.
- The TS-side embed module + tests are a small, parallel surface
  (one .ts file + one .test.ts file). One worker holds the
  Rust-side type design and the TS-side rendering contract in head at
  once, which is what the audit-focus "ABI shaped around one engine"
  guardrail needs.
- The fixture adapter is NOT refactored to expose an embed surface
  (mirrors UTSUSHI-020 / UTSUSHI-022 / UTSUSHI-023 Slice A posture).
  The natural follow-up is Slice B (fixture adapter's
  `embed_state` / `embed_capabilities` impl) and the WASM bundle slice,
  both tracked separately.
- Test surface is moderate: ~40 unit tests, 2 Rust integration files
  - 1 golden, 6 TS tests + 1 TS embed module. All inside
    `utsushi-core` and `apps/runtime-web-review`. The `utsushi-fixture`
    no-regression bar is satisfied because the embed module is purely
    additive.

Verification (per §11):
`cargo test -p utsushi-core embed`,
`cargo test -p utsushi-core`,
`cargo test -p utsushi-fixture`,
`pnpm --filter @itotori/runtime-web-review test`,
`pnpm --filter @itotori/runtime-web-review typecheck`,
`just check`,
`just test`.

Estimated worker time: medium. The capability enum + state envelope +
serde plumbing are mechanical; the heavier work is the capability-
gating typed accessors, the golden envelope fixture, and the TS
redaction-on-DOM assertion that the audit-focus item depends on.
Substrate + fixture-web-review only; `utsushi-fixture` unchanged.

## Plan ends here.
