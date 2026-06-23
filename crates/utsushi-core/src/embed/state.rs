//! Envelope, snapshot ref, and trace surface for the WASM embed ABI
//! substrate.
//!
//! The ABI is a single JSON envelope, [`EmbedState`], plus a capability
//! discovery helper exposed from [`super::capability::embed_capabilities`].
//! Every type in this module serializes through `serde_json`; no native
//! Rust type crosses the ABI boundary.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    EvidenceTier, SNAPSHOT_EVIDENCE_TIER_CEILING, SNAPSHOT_MAX_SERIALIZED_BYTES, Snapshot, TextLine,
};

use super::artifact::EmbedArtifactRef;
use super::capability::{
    EMBED_MAX_CAPABILITIES, EmbedCapability, EmbedCapabilityId, validate_capability_list,
};
use super::diagnostics::EmbedError;
use super::redaction::reject_redaction_violation;

/// Pinned schema version for the embed ABI wire form. Bumping the constant
/// is a breaking change for every embed host; the pin is asserted on every
/// [`EmbedState::to_json_value`] and on [`EmbedState::from_json_value`] so a
/// version drift surfaces as [`EmbedError::SchemaVersionMismatch`] rather
/// than a silent shape change.
pub const EMBED_SCHEMA_VERSION: &str = "0.1.0-alpha";

/// Max serialized envelope size (JSON, bytes). 32 KiB — 2x the snapshot
/// ceiling because the envelope can carry a moderate number of trace lines
/// and artifact refs in addition to a snapshot ref.
pub const EMBED_STATE_MAX_SERIALIZED_BYTES: usize = 32 * 1024;

/// Max number of trace lines a single [`EmbedTrace`] can carry. Trace
/// windows beyond this MUST be paginated by a higher-level verb (deferred
/// to a follow-up slice).
pub const EMBED_TRACE_MAX_LINES: usize = 256;

/// Max number of artifact refs a single envelope can carry. 64 covers every
/// realistic frame-capture + recording corpus per session.
pub const EMBED_MAX_ARTIFACT_REFS: usize = 64;

/// Required length of the lowercase-hex SHA-256 hex digest carried by
/// [`EmbedSnapshotRef::content_hash`]. Matches the snapshot module's
/// `BYTES_HASH_HEX_LEN` posture.
pub const EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN: usize = 64;

/// Pinned schema version wrapper. Serializes transparently as a string.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EmbedSchemaVersion(pub String);

impl EmbedSchemaVersion {
    /// Construct a schema version pinned to the substrate's pinned
    /// [`EMBED_SCHEMA_VERSION`].
    pub fn current() -> Self {
        Self(EMBED_SCHEMA_VERSION.to_string())
    }

    /// Returns the underlying string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Embed-boundary snapshot reference. Id, content hash, payload size, and
/// adapter id only. Never carries the state tree.
///
/// The plan calls the producer-side label "adapter id"; the underlying
/// [`crate::SnapshotRef`] calls it "inspectable id." The embed ABI uses the
/// adapter-facing name, and the [`From<&Snapshot>`] impl maps from the
/// snapshot's `inspectable_id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedSnapshotRef {
    /// Snapshot id (matches `crate::SnapshotId::parse` shape: non-empty
    /// `[a-z0-9-]`; UUIDv7 is a subset of this character class).
    pub snapshot_id: String,
    /// Inspectable / adapter id from the producing port. Asserted by
    /// [`EmbedState::validate`] to equal the envelope's `adapter_id`.
    pub adapter_id: String,
    /// Lowercase hex SHA-256 of the canonical-serialized [`Snapshot`] JSON.
    pub content_hash: String,
    /// Serialized payload byte length, bounded by
    /// [`SNAPSHOT_MAX_SERIALIZED_BYTES`].
    pub size_bytes: u32,
    /// Evidence tier declared on the underlying snapshot. Bounded by
    /// [`SNAPSHOT_EVIDENCE_TIER_CEILING`].
    pub evidence_tier: EvidenceTier,
}

impl EmbedSnapshotRef {
    /// Per-field validator. Called by [`EmbedState::validate`].
    pub fn validate(&self) -> Result<(), EmbedError> {
        validate_snapshot_id(&self.snapshot_id)?;
        validate_adapter_id_field(&self.adapter_id, "snapshot adapter_id")
            .map_err(|reason| EmbedError::InvalidSnapshotRef { reason })?;
        validate_content_hash(&self.content_hash)?;
        if (self.size_bytes as usize) > SNAPSHOT_MAX_SERIALIZED_BYTES {
            return Err(EmbedError::InvalidSnapshotRef {
                reason: format!(
                    "size_bytes={} exceeds SNAPSHOT_MAX_SERIALIZED_BYTES={}",
                    self.size_bytes, SNAPSHOT_MAX_SERIALIZED_BYTES
                ),
            });
        }
        if self.evidence_tier > SNAPSHOT_EVIDENCE_TIER_CEILING {
            return Err(EmbedError::InvalidSnapshotRef {
                reason: format!(
                    "evidence_tier={} exceeds SNAPSHOT_EVIDENCE_TIER_CEILING={}",
                    self.evidence_tier.as_str(),
                    SNAPSHOT_EVIDENCE_TIER_CEILING.as_str()
                ),
            });
        }
        Ok(())
    }
}

impl TryFrom<&Snapshot> for EmbedSnapshotRef {
    type Error = EmbedError;

    fn try_from(snapshot: &Snapshot) -> Result<Self, EmbedError> {
        // Use the snapshot's own canonical serializer so the hash and size
        // are derived from exactly the wire form a host would see.
        let serialized = serde_json::to_vec(snapshot).map_err(|err| EmbedError::Json {
            reason: err.to_string(),
        })?;
        let content_hash = hex_digest(&serialized);
        let size_bytes: u32 =
            serialized
                .len()
                .try_into()
                .map_err(|_| EmbedError::InvalidSnapshotRef {
                    reason: "snapshot serialized bytes exceed u32 range".to_string(),
                })?;
        let value = Self {
            snapshot_id: snapshot.snapshot_id().as_str().to_string(),
            adapter_id: snapshot.inspectable_id().to_string(),
            content_hash,
            size_bytes,
            evidence_tier: snapshot.evidence_tier(),
        };
        value.validate()?;
        Ok(value)
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn validate_snapshot_id(raw: &str) -> Result<(), EmbedError> {
    crate::SnapshotId::parse(raw).map_err(|err| EmbedError::InvalidSnapshotRef {
        reason: format!("snapshot_id rejected: {err}"),
    })?;
    Ok(())
}

fn validate_content_hash(raw: &str) -> Result<(), EmbedError> {
    if raw.len() != EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN {
        return Err(EmbedError::InvalidSnapshotRef {
            reason: format!(
                "content_hash length {} must equal {EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN}",
                raw.len()
            ),
        });
    }
    if !raw
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(EmbedError::InvalidSnapshotRef {
            reason: "content_hash must be lowercase hex".to_string(),
        });
    }
    Ok(())
}

fn validate_adapter_id_field(raw: &str, label: &'static str) -> Result<(), String> {
    if raw.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if raw.trim().is_empty() {
        return Err(format!("{label} must not be blank"));
    }
    if !raw.is_ascii() {
        return Err(format!("{label} must be ASCII"));
    }
    if raw.chars().any(char::is_whitespace) {
        return Err(format!("{label} must not contain whitespace"));
    }
    if raw.chars().any(|c| (c as u32) < 0x20 || (c as u32) == 0x7f) {
        return Err(format!("{label} must be printable ASCII"));
    }
    Ok(())
}

/// Thin wrapper around [`TextLine`] so the ABI owns its own validation
/// entry point and can add embed-specific fields later without re-exporting
/// sink internals. `#[serde(flatten)]` preserves the existing `TextLine`
/// camelCase wire form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedTraceLine {
    #[serde(flatten)]
    pub text_line: TextLine,
}

impl EmbedTraceLine {
    /// Validate the underlying text line and run the embed redaction filter
    /// on the serialized form.
    pub fn validate(&self) -> Result<(), EmbedError> {
        self.text_line
            .validate()
            .map_err(|err| EmbedError::InvalidCapability {
                capability_id: EmbedCapabilityId::Trace,
                reason: format!("text line validation failed: {err}"),
            })?;
        let value = serde_json::to_value(self).map_err(|err| EmbedError::Json {
            reason: err.to_string(),
        })?;
        reject_redaction_violation("", &value)?;
        Ok(())
    }
}

/// Trace surface. Mirrors the sink `TextLine` shape from UTSUSHI-022 because
/// the trace IS the sink-emitted text log; the ABI reuses the same
/// engine-neutral type rather than reinventing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedTrace {
    /// Pinned schema version; same constant as the envelope. Asserted on
    /// validate so a host that fetches the trace independently can confirm
    /// the version without the envelope.
    pub schema_version: EmbedSchemaVersion,
    /// Sequence of text lines in emission order. Engine-neutral.
    pub lines: Vec<EmbedTraceLine>,
}

impl EmbedTrace {
    /// Construct an empty trace at the current schema version.
    pub fn empty() -> Self {
        Self {
            schema_version: EmbedSchemaVersion::current(),
            lines: Vec::new(),
        }
    }

    /// Per-trace validator. Called by [`EmbedState::validate`] and by hosts
    /// that fetch the trace independently.
    pub fn validate(&self) -> Result<(), EmbedError> {
        if self.schema_version.as_str() != EMBED_SCHEMA_VERSION {
            return Err(EmbedError::SchemaVersionMismatch {
                observed: self.schema_version.as_str().to_string(),
                expected: EMBED_SCHEMA_VERSION,
            });
        }
        if self.lines.len() > EMBED_TRACE_MAX_LINES {
            return Err(EmbedError::TraceTooLarge {
                observed: self.lines.len(),
                ceiling: EMBED_TRACE_MAX_LINES,
            });
        }
        for line in &self.lines {
            line.validate()?;
        }
        let value = serde_json::to_value(self).map_err(|err| EmbedError::Json {
            reason: err.to_string(),
        })?;
        reject_redaction_violation("trace", &value)?;
        Ok(())
    }
}

/// The single JSON envelope every embed serializes when the host asks for
/// "current state." Engine-neutral; constructed by both the fixture adapter
/// and any future engine port.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedState {
    /// Pinned schema version. Asserted on validate.
    pub schema_version: EmbedSchemaVersion,
    /// Stable public adapter id (e.g. `"utsushi-fixture"`). Engine-neutral.
    pub adapter_id: String,
    /// Adapter version. Public string, free-form.
    pub adapter_version: String,
    /// Capability declaration. Sorted deterministically by
    /// `capability_id`. MUST include every capability the host can ask
    /// about; "not declared" is not a valid posture for any UTSUSHI-024-era
    /// capability.
    pub capabilities: Vec<EmbedCapability>,
    /// Current trace. The `lines` vector MAY be empty; the field is always
    /// present so the host can `Array.isArray(state.trace.lines)` without
    /// a null check.
    pub trace: EmbedTrace,
    /// Reference to the current snapshot. Id-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_snapshot: Option<EmbedSnapshotRef>,
    /// Artifact references for the current playback session. Managed URIs
    /// only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_refs: Vec<EmbedArtifactRef>,
}

impl EmbedState {
    /// End-to-end envelope validator. Runs on every
    /// [`Self::to_json_value`] and [`Self::from_json_value`].
    pub fn validate(&self) -> Result<(), EmbedError> {
        if self.schema_version.as_str() != EMBED_SCHEMA_VERSION {
            return Err(EmbedError::SchemaVersionMismatch {
                observed: self.schema_version.as_str().to_string(),
                expected: EMBED_SCHEMA_VERSION,
            });
        }
        validate_adapter_id_field(&self.adapter_id, "envelope adapter_id").map_err(|reason| {
            EmbedError::InvalidAdapterId {
                observed: format!("{}: {reason}", self.adapter_id),
            }
        })?;
        if self.adapter_version.trim().is_empty() {
            return Err(EmbedError::InvalidAdapterId {
                observed: format!("adapter_version: {}", self.adapter_version),
            });
        }
        validate_capability_list(&self.capabilities)?;
        if self.capabilities.len() > EMBED_MAX_CAPABILITIES {
            return Err(EmbedError::CapabilitiesTooLarge {
                observed: self.capabilities.len(),
                ceiling: EMBED_MAX_CAPABILITIES,
            });
        }
        self.trace.validate()?;
        if self.artifact_refs.len() > EMBED_MAX_ARTIFACT_REFS {
            return Err(EmbedError::ArtifactRefsTooLarge {
                observed: self.artifact_refs.len(),
                ceiling: EMBED_MAX_ARTIFACT_REFS,
            });
        }
        for artifact_ref in &self.artifact_refs {
            artifact_ref.validate()?;
        }
        if let Some(snapshot) = &self.current_snapshot {
            snapshot.validate()?;
            if snapshot.adapter_id != self.adapter_id {
                return Err(EmbedError::SnapshotAdapterIdMismatch {
                    envelope: self.adapter_id.clone(),
                    snapshot: snapshot.adapter_id.clone(),
                });
            }
        }
        // Defense-in-depth redaction walk on the fully serialized form.
        let serialized = serde_json::to_vec(self).map_err(|err| EmbedError::Json {
            reason: err.to_string(),
        })?;
        if serialized.len() > EMBED_STATE_MAX_SERIALIZED_BYTES {
            return Err(EmbedError::EnvelopeTooLarge {
                size: serialized.len(),
                ceiling: EMBED_STATE_MAX_SERIALIZED_BYTES,
            });
        }
        let json_value: Value =
            serde_json::from_slice(&serialized).map_err(|err| EmbedError::Json {
                reason: err.to_string(),
            })?;
        reject_redaction_violation("", &json_value)?;
        Ok(())
    }

    /// Serialize to a JSON `Value`. Re-runs `validate` so an inconsistent
    /// envelope cannot leak through serialization.
    pub fn to_json_value(&self) -> Result<Value, EmbedError> {
        self.validate()?;
        serde_json::to_value(self).map_err(|err| EmbedError::Json {
            reason: err.to_string(),
        })
    }

    /// Deserialize from a JSON `Value`. Validates the resulting envelope
    /// end-to-end.
    pub fn from_json_value(value: Value) -> Result<Self, EmbedError> {
        let state: Self = serde_json::from_value(value).map_err(|err| EmbedError::Json {
            reason: err.to_string(),
        })?;
        state.validate()?;
        Ok(state)
    }

    /// Typed accessor: return the trace only if `Capability::Trace` is
    /// declared `Supported | Partial`. Otherwise return
    /// [`EmbedError::CapabilityNotSupported`].
    pub fn trace(&self) -> Result<&EmbedTrace, EmbedError> {
        if self.is_supported(EmbedCapabilityId::Trace) {
            Ok(&self.trace)
        } else {
            Err(EmbedError::CapabilityNotSupported {
                capability_id: EmbedCapabilityId::Trace,
            })
        }
    }

    /// Typed accessor: return the `current_snapshot` only if
    /// `Capability::Snapshot` is declared `Supported | Partial`. Otherwise
    /// return [`EmbedError::CapabilityNotSupported`].
    pub fn current_snapshot(&self) -> Result<Option<&EmbedSnapshotRef>, EmbedError> {
        if self.is_supported(EmbedCapabilityId::Snapshot) {
            Ok(self.current_snapshot.as_ref())
        } else {
            Err(EmbedError::CapabilityNotSupported {
                capability_id: EmbedCapabilityId::Snapshot,
            })
        }
    }

    /// Typed accessor: return the artifact refs only if
    /// `Capability::ArtifactRefs` is declared `Supported | Partial`.
    /// Otherwise return [`EmbedError::CapabilityNotSupported`].
    pub fn artifact_refs(&self) -> Result<&[EmbedArtifactRef], EmbedError> {
        if self.is_supported(EmbedCapabilityId::ArtifactRefs) {
            Ok(&self.artifact_refs)
        } else {
            Err(EmbedError::CapabilityNotSupported {
                capability_id: EmbedCapabilityId::ArtifactRefs,
            })
        }
    }

    /// Lookup a single capability declaration. Returns `None` if the
    /// capability id is not declared in the envelope's capability list.
    pub fn capability(&self, id: EmbedCapabilityId) -> Option<&EmbedCapability> {
        self.capabilities
            .iter()
            .find(|capability| capability.capability_id == id)
    }

    /// Convenience: returns `true` iff the capability is declared
    /// `Supported | Partial`. Returns `false` for `Unsupported` AND for
    /// "not declared at all" — the typed accessor gates check this method.
    pub fn is_supported(&self, id: EmbedCapabilityId) -> bool {
        self.capability(id)
            .is_some_and(|capability| capability.status.is_available())
    }
}

/// Serialize an `EmbedState` snapshot as JSON. Equivalent to
/// `state.to_json_value()`; provided as a free function so the embed-side
/// "two ABI calls" surface ([`super::capability::embed_capabilities`] plus
/// `embed_state`) is symmetric.
pub fn embed_state(state: &EmbedState) -> Result<Value, EmbedError> {
    state.to_json_value()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{ObservationBridgeRef, vfs::AssetId};

    use super::*;

    fn sample_text_line() -> TextLine {
        TextLine {
            line_id: "line-001".to_string(),
            evidence_tier: EvidenceTier::E1,
            text: "hello world".to_string(),
            speaker: Some("narrator".to_string()),
            text_surface: Some("adv".to_string()),
            bridge_ref: Some(ObservationBridgeRef {
                bridge_unit_id: Some("0190a000-0000-7000-8000-000000000001".to_string()),
                source_unit_key: Some("intro/line/1".to_string()),
                runtime_object_id: Some("scene-intro/text-1".to_string()),
            }),
            source_asset: Some(AssetId::parse("vfs://www/data/Map001.json").expect("asset id")),
        }
    }

    fn sample_trace_line() -> EmbedTraceLine {
        EmbedTraceLine {
            text_line: sample_text_line(),
        }
    }

    fn sample_trace() -> EmbedTrace {
        EmbedTrace {
            schema_version: EmbedSchemaVersion::current(),
            lines: vec![sample_trace_line()],
        }
    }

    fn sample_capabilities_for_full_envelope() -> Vec<EmbedCapability> {
        vec![
            EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
            EmbedCapability::supported(EmbedCapabilityId::Trace, EvidenceTier::E1),
            EmbedCapability::supported(EmbedCapabilityId::Snapshot, EvidenceTier::E2),
            EmbedCapability::supported(EmbedCapabilityId::ArtifactRefs, EvidenceTier::E2),
            EmbedCapability::supported(EmbedCapabilityId::DeterministicFixture, EvidenceTier::E1),
        ]
    }

    fn sample_snapshot_ref() -> EmbedSnapshotRef {
        EmbedSnapshotRef {
            snapshot_id: "run-fixture-001-tick-0042".to_string(),
            adapter_id: "utsushi-fixture".to_string(),
            content_hash: "a".repeat(EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN),
            size_bytes: 1024,
            evidence_tier: EvidenceTier::E2,
        }
    }

    fn sample_artifact_ref() -> EmbedArtifactRef {
        EmbedArtifactRef {
            artifact_id: "frame-001".to_string(),
            artifact_kind: "frame_capture".to_string(),
            uri: "artifacts/utsushi/runtime/run-fixture-001/frame-captures/frame-001.png"
                .to_string(),
            media_type: Some("image/png".to_string()),
        }
    }

    fn sample_state() -> EmbedState {
        EmbedState {
            schema_version: EmbedSchemaVersion::current(),
            adapter_id: "utsushi-fixture".to_string(),
            adapter_version: "0.0.0".to_string(),
            capabilities: sample_capabilities_for_full_envelope(),
            trace: sample_trace(),
            current_snapshot: Some(sample_snapshot_ref()),
            artifact_refs: vec![sample_artifact_ref()],
        }
    }

    #[test]
    fn embed_trace_line_wraps_text_line_with_camelcase_wire_form() {
        let line = sample_trace_line();
        let value = serde_json::to_value(&line).expect("serialize");
        let obj = value.as_object().expect("object");
        assert!(obj.contains_key("lineId"));
        assert!(obj.contains_key("evidenceTier"));
        assert!(obj.contains_key("textSurface"));
        assert!(obj.contains_key("bridgeRef"));
        assert!(obj.contains_key("sourceAsset"));
        assert!(!obj.contains_key("line_id"));
        assert!(!obj.contains_key("text_surface"));
    }

    #[test]
    fn embed_trace_line_with_local_path_in_speaker_fails_redaction() {
        let mut line = sample_trace_line();
        line.text_line.speaker = Some("/home/leak/profile".to_string());
        let error = line.validate().expect_err("host path in speaker rejected");
        assert!(matches!(
            error,
            EmbedError::RedactionViolation { field_path } if field_path.contains("speaker")
        ));
    }

    #[test]
    fn embed_trace_serialized_form_passes_reject_unredacted_local_paths() {
        let trace = sample_trace();
        trace.validate().expect("clean trace accepted");
    }

    #[test]
    fn embed_trace_validate_rejects_more_than_max_lines() {
        let mut trace = sample_trace();
        for index in 0..EMBED_TRACE_MAX_LINES {
            let mut line = sample_trace_line();
            line.text_line.line_id = format!("line-{index:04}");
            trace.lines.push(line);
        }
        let error = trace.validate().expect_err("over ceiling rejected");
        assert!(matches!(
            error,
            EmbedError::TraceTooLarge { ceiling, .. } if ceiling == EMBED_TRACE_MAX_LINES
        ));
    }

    #[test]
    fn embed_trace_round_trips_through_serde_json() {
        let trace = sample_trace();
        let value = serde_json::to_value(&trace).expect("serialize");
        let parsed: EmbedTrace = serde_json::from_value(value).expect("deserialize");
        assert_eq!(parsed, trace);
    }

    #[test]
    fn embed_trace_line_source_asset_uses_vfs_asset_id() {
        let line = sample_trace_line();
        let value = serde_json::to_value(&line).expect("serialize");
        assert_eq!(
            value["sourceAsset"].as_str(),
            Some("vfs://www/data/Map001.json")
        );
    }

    #[test]
    fn embed_trace_rejects_unsupported_schema_version() {
        let trace = EmbedTrace {
            schema_version: EmbedSchemaVersion("0.0.0".to_string()),
            lines: Vec::new(),
        };
        let error = trace.validate().expect_err("schema mismatch rejected");
        assert!(matches!(error, EmbedError::SchemaVersionMismatch { .. }));
    }

    #[test]
    fn embed_snapshot_ref_validate_accepts_well_formed_ref() {
        let snapshot_ref = sample_snapshot_ref();
        snapshot_ref.validate().expect("well-formed ref accepted");
    }

    #[test]
    fn embed_snapshot_ref_rejects_non_uuid7_snapshot_id() {
        let mut snapshot_ref = sample_snapshot_ref();
        snapshot_ref.snapshot_id = "BAD ID".to_string();
        let error = snapshot_ref
            .validate()
            .expect_err("malformed snapshot id rejected");
        assert!(matches!(error, EmbedError::InvalidSnapshotRef { .. }));
    }

    #[test]
    fn embed_snapshot_ref_rejects_non_hex_content_hash() {
        let mut snapshot_ref = sample_snapshot_ref();
        snapshot_ref.content_hash = "G".repeat(EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN);
        let error = snapshot_ref.validate().expect_err("non-hex hash rejected");
        assert!(matches!(error, EmbedError::InvalidSnapshotRef { .. }));
    }

    #[test]
    fn embed_snapshot_ref_rejects_wrong_length_content_hash() {
        let mut snapshot_ref = sample_snapshot_ref();
        snapshot_ref.content_hash = "abc".to_string();
        let error = snapshot_ref.validate().expect_err("short hash rejected");
        assert!(matches!(error, EmbedError::InvalidSnapshotRef { .. }));
    }

    #[test]
    fn embed_snapshot_ref_rejects_size_above_snapshot_ceiling() {
        let mut snapshot_ref = sample_snapshot_ref();
        snapshot_ref.size_bytes = (SNAPSHOT_MAX_SERIALIZED_BYTES + 1) as u32;
        let error = snapshot_ref
            .validate()
            .expect_err("over-ceiling size rejected");
        assert!(matches!(error, EmbedError::InvalidSnapshotRef { .. }));
    }

    #[test]
    fn embed_snapshot_ref_rejects_evidence_tier_above_e3() {
        let mut snapshot_ref = sample_snapshot_ref();
        snapshot_ref.evidence_tier = EvidenceTier::E4;
        let error = snapshot_ref.validate().expect_err("E4 rejected");
        assert!(matches!(error, EmbedError::InvalidSnapshotRef { .. }));
    }

    #[test]
    fn embed_snapshot_ref_round_trips_through_serde_json() {
        let snapshot_ref = sample_snapshot_ref();
        let value = serde_json::to_value(&snapshot_ref).expect("serialize");
        let parsed: EmbedSnapshotRef = serde_json::from_value(value).expect("deserialize");
        assert_eq!(parsed, snapshot_ref);
    }

    #[test]
    fn embed_snapshot_ref_serializes_with_camel_case_wire_form() {
        let snapshot_ref = sample_snapshot_ref();
        let value = serde_json::to_value(&snapshot_ref).expect("serialize");
        let obj = value.as_object().expect("object");
        assert!(obj.contains_key("snapshotId"));
        assert!(obj.contains_key("adapterId"));
        assert!(obj.contains_key("contentHash"));
        assert!(obj.contains_key("sizeBytes"));
        assert!(obj.contains_key("evidenceTier"));
        assert!(!obj.contains_key("snapshot_id"));
        assert!(!obj.contains_key("adapter_id"));
        assert!(!obj.contains_key("content_hash"));
        assert!(!obj.contains_key("size_bytes"));
    }

    #[test]
    fn embed_state_validate_accepts_well_formed_envelope() {
        let state = sample_state();
        state.validate().expect("well-formed envelope accepted");
    }

    #[test]
    fn embed_state_rejects_unsupported_schema_version_on_from_json_value() {
        let state = sample_state();
        let mut value = state.to_json_value().expect("serialize");
        value["schemaVersion"] = json!("0.0.0");
        let error = EmbedState::from_json_value(value).expect_err("schema mismatch rejected");
        assert!(matches!(error, EmbedError::SchemaVersionMismatch { .. }));
    }

    #[test]
    fn embed_state_rejects_blank_adapter_id() {
        let mut state = sample_state();
        state.adapter_id = "   ".to_string();
        // current_snapshot.adapter_id mismatch would fire first; clear it.
        state.current_snapshot = None;
        let error = state.validate().expect_err("blank adapter id rejected");
        assert!(matches!(error, EmbedError::InvalidAdapterId { .. }));
    }

    #[test]
    fn embed_state_rejects_snapshot_with_mismatched_adapter_id() {
        let mut state = sample_state();
        state
            .current_snapshot
            .as_mut()
            .expect("snapshot present")
            .adapter_id = "engine-port".to_string();
        let error = state
            .validate()
            .expect_err("cross-adapter snapshot rejected");
        assert!(matches!(
            error,
            EmbedError::SnapshotAdapterIdMismatch { .. }
        ));
    }

    #[test]
    fn embed_state_rejects_envelope_serialized_over_32_kib() {
        let mut state = sample_state();
        // Generate enough lines to push the envelope over the byte ceiling
        // by repeating a wide text payload. The ceiling on lines is 256 and
        // the byte ceiling is 32 KiB; each line is < 256 bytes, so a few
        // hundred lines will easily exceed the byte ceiling while staying
        // below the line ceiling.
        let mut wide_line = sample_trace_line();
        wide_line.text_line.text = "x".repeat(200);
        for index in 0..EMBED_TRACE_MAX_LINES - 1 {
            let mut line = wide_line.clone();
            line.text_line.line_id = format!("line-{index:04}");
            state.trace.lines.push(line);
        }
        let error = state.validate().expect_err("over byte ceiling rejected");
        assert!(matches!(
            error,
            EmbedError::EnvelopeTooLarge { ceiling, .. }
                if ceiling == EMBED_STATE_MAX_SERIALIZED_BYTES
        ));
    }

    #[test]
    fn embed_state_rejects_artifact_refs_over_ceiling() {
        let mut state = sample_state();
        let artifact = sample_artifact_ref();
        for index in 0..(EMBED_MAX_ARTIFACT_REFS + 1) {
            let mut entry = artifact.clone();
            entry.artifact_id = format!("frame-{index:04}");
            entry.uri = format!(
                "artifacts/utsushi/runtime/run-fixture-001/frame-captures/frame-{index:04}.png"
            );
            state.artifact_refs.push(entry);
        }
        // Strip the original artifact ref to leave EMBED_MAX_ARTIFACT_REFS + 1
        // total after the loop.
        state.artifact_refs.remove(0);
        let error = state
            .validate()
            .expect_err("over artifact ceiling rejected");
        assert!(matches!(
            error,
            EmbedError::ArtifactRefsTooLarge { ceiling, .. } if ceiling == EMBED_MAX_ARTIFACT_REFS
        ));
    }

    #[test]
    fn embed_state_round_trips_through_serde_json() {
        let state = sample_state();
        let value = state.to_json_value().expect("serialize");
        let parsed = EmbedState::from_json_value(value).expect("deserialize");
        assert_eq!(parsed, state);
    }

    #[test]
    fn embed_state_serialized_form_passes_reject_unredacted_local_paths() {
        let state = sample_state();
        let value = state.to_json_value().expect("serialize");
        crate::redaction::reject_unredacted_local_paths("", &value)
            .expect("serialized envelope is redaction-clean");
    }

    #[test]
    fn embed_state_with_empty_trace_serializes_with_lines_array() {
        let mut state = sample_state();
        state.trace.lines.clear();
        let value = state.to_json_value().expect("serialize");
        let lines = value["trace"]["lines"]
            .as_array()
            .expect("lines is an array even when empty");
        assert!(lines.is_empty(), "lines remains an array, not null");
    }

    #[test]
    fn embed_state_trace_returns_err_when_trace_capability_is_unsupported() {
        let mut state = sample_state();
        // Replace Trace capability with Unsupported and clear lines so the
        // envelope validates.
        state.trace.lines.clear();
        for capability in state.capabilities.iter_mut() {
            if capability.capability_id == EmbedCapabilityId::Trace {
                *capability = EmbedCapability::unsupported(
                    EmbedCapabilityId::Trace,
                    vec!["trace deferred".to_string()],
                );
            }
        }
        state.validate().expect("envelope still valid");
        let error = state.trace().expect_err("typed accessor returns err");
        assert!(matches!(
            error,
            EmbedError::CapabilityNotSupported {
                capability_id: EmbedCapabilityId::Trace
            }
        ));
    }

    #[test]
    fn embed_state_current_snapshot_returns_err_when_snapshot_capability_is_unsupported() {
        let mut state = sample_state();
        state.current_snapshot = None;
        for capability in state.capabilities.iter_mut() {
            if capability.capability_id == EmbedCapabilityId::Snapshot {
                *capability = EmbedCapability::unsupported(
                    EmbedCapabilityId::Snapshot,
                    vec!["fixture has no snapshot store".to_string()],
                );
            }
        }
        state.validate().expect("envelope still valid");
        let error = state
            .current_snapshot()
            .expect_err("typed accessor returns err");
        assert!(matches!(
            error,
            EmbedError::CapabilityNotSupported {
                capability_id: EmbedCapabilityId::Snapshot
            }
        ));
    }

    #[test]
    fn embed_state_artifact_refs_returns_err_when_capability_is_unsupported() {
        let mut state = sample_state();
        state.artifact_refs.clear();
        for capability in state.capabilities.iter_mut() {
            if capability.capability_id == EmbedCapabilityId::ArtifactRefs {
                *capability = EmbedCapability::unsupported(
                    EmbedCapabilityId::ArtifactRefs,
                    vec!["fixture artifact corpus deferred".to_string()],
                );
            }
        }
        state.validate().expect("envelope still valid");
        let error = state
            .artifact_refs()
            .expect_err("typed accessor returns err");
        assert!(matches!(
            error,
            EmbedError::CapabilityNotSupported {
                capability_id: EmbedCapabilityId::ArtifactRefs
            }
        ));
    }

    #[test]
    fn embed_state_typed_accessor_returns_field_when_capability_is_partial() {
        let mut state = sample_state();
        for capability in state.capabilities.iter_mut() {
            if capability.capability_id == EmbedCapabilityId::Trace {
                *capability = EmbedCapability::partial(
                    EmbedCapabilityId::Trace,
                    EvidenceTier::E1,
                    vec!["trace window limited".to_string()],
                );
            }
        }
        state.validate().expect("partial envelope valid");
        let trace = state.trace().expect("partial returns field");
        assert_eq!(trace.lines.len(), 1);
    }

    #[test]
    fn embed_state_typed_accessor_returns_field_when_capability_is_supported() {
        let state = sample_state();
        let trace = state.trace().expect("supported returns field");
        assert_eq!(trace.lines.len(), 1);
        let snapshot = state
            .current_snapshot()
            .expect("supported returns option")
            .expect("snapshot present");
        assert_eq!(snapshot.adapter_id, "utsushi-fixture");
        let refs = state.artifact_refs().expect("supported returns slice");
        assert_eq!(refs.len(), 1);
    }

    #[test]
    fn embed_state_is_supported_returns_false_for_undeclared_capability() {
        // Construct a minimal capability list missing the Snapshot entry.
        let mut state = sample_state();
        state.current_snapshot = None;
        state
            .capabilities
            .retain(|capability| capability.capability_id != EmbedCapabilityId::Snapshot);
        state.validate().expect("envelope still valid");
        assert!(!state.is_supported(EmbedCapabilityId::Snapshot));
        assert!(state.capability(EmbedCapabilityId::Snapshot).is_none());
    }

    #[test]
    fn embed_state_rejects_envelope_with_unknown_top_level_field() {
        let state = sample_state();
        let mut value = state.to_json_value().expect("serialize");
        value
            .as_object_mut()
            .expect("object")
            .insert("secretField".to_string(), json!("leak"));
        let error = EmbedState::from_json_value(value).expect_err("unknown field rejected");
        assert!(matches!(error, EmbedError::Json { .. }));
    }

    #[test]
    fn embed_state_rejects_blank_adapter_version() {
        let mut state = sample_state();
        state.adapter_version = "   ".to_string();
        state.current_snapshot = None;
        let error = state
            .validate()
            .expect_err("blank adapter version rejected");
        assert!(matches!(error, EmbedError::InvalidAdapterId { .. }));
    }

    #[test]
    fn embed_snapshot_ref_from_snapshot_derives_content_hash_size_and_tier() {
        use crate::snapshot::{
            Inspectable, SnapshotRequest, StatePath, StateTree, StateValue, take_snapshot,
        };

        struct FixtureInspectable;
        impl Inspectable for FixtureInspectable {
            fn inspectable_id(&self) -> &'static str {
                "fixture-snapshot"
            }
            fn inspect_state(&self) -> Result<StateTree, crate::SnapshotError> {
                let mut tree = StateTree::new();
                tree.insert(
                    StatePath::parse("runtime.tick").expect("path"),
                    StateValue::Tick {
                        value: crate::clock::LogicalClockTick(0),
                    },
                )?;
                Ok(tree)
            }
        }

        let snapshot = take_snapshot(
            &FixtureInspectable,
            &SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(0),
        )
        .expect("snapshot");
        let snapshot_ref: EmbedSnapshotRef = (&snapshot).try_into().expect("conversion");
        snapshot_ref.validate().expect("derived ref valid");
        assert_eq!(snapshot_ref.adapter_id, "fixture-snapshot");
        assert_eq!(snapshot_ref.evidence_tier, EvidenceTier::E2);
        assert_eq!(
            snapshot_ref.content_hash.len(),
            EMBED_SNAPSHOT_CONTENT_HASH_HEX_LEN
        );
        // Recompute the hash and assert byte-equality.
        let canonical = serde_json::to_vec(&snapshot).expect("serialize snapshot");
        assert_eq!(snapshot_ref.content_hash, hex_digest(&canonical));
        assert_eq!(snapshot_ref.size_bytes as usize, canonical.len());
    }
}
