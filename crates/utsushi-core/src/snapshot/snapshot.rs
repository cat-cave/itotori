//! Immutable `Snapshot` payload plus `take_snapshot` / `restore_snapshot`
//! orchestration.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::EvidenceTier;

use super::diagnostics::SnapshotError;
use super::envelope::SnapshotEnvelope;
use super::inspectable::{Inspectable, Restorable, RestoreReport};
use super::redaction::reject_unredacted_local_paths_in_value;
use super::state::StateTree;

mod validation;

use validation::{validate_generated_at, validate_inspectable_id};

/// Schema version pin for the snapshot substrate.
///
/// bumped the pin from `0.1.0-alpha` to `0.2.0-alpha` when the
/// previous fixed-byte ceiling was replaced with the per-port
/// [`SnapshotEnvelope`] tier and the manifest grew a required
/// `envelope_class` field. **No upgrade path; old snapshots are not
/// readable by this version.** A consumer that needs to load a
/// pre-0.2.0-alpha snapshot must re-snapshot from its source port at the
/// new schema.
pub const SNAPSHOT_SCHEMA_VERSION: &str = "0.2.0-alpha";

/// Evidence-tier ceiling for snapshots. Snapshots are E2-by-default
/// (controlled-playback evidence) and capped at E3. Higher tiers require a
/// separate sink and are not part of this surface.
pub const SNAPSHOT_EVIDENCE_TIER_CEILING: EvidenceTier = EvidenceTier::E3;

/// Schema version pin carried on serialized snapshots and diffs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SnapshotSchemaVersion(pub String);

impl SnapshotSchemaVersion {
    /// Construct a schema version pinned to the substrate's pinned
    /// [`SNAPSHOT_SCHEMA_VERSION`].
    pub fn current() -> Self {
        Self(SNAPSHOT_SCHEMA_VERSION.to_string())
    }

    /// Returns the underlying string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable snapshot id. The wire form is a non-empty lowercase ASCII
/// string of `[a-z0-9-]` no longer than `MAX_SNAPSHOT_ID_BYTES`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SnapshotId(String);

/// Max bytes in a [`SnapshotId`] wire form.
pub const MAX_SNAPSHOT_ID_BYTES: usize = 128;

impl SnapshotId {
    /// Parse a snapshot id. Validation rules:
    /// - Non-empty.
    /// - At most [`MAX_SNAPSHOT_ID_BYTES`] bytes.
    /// - Each byte matches `[a-z0-9-]` (lowercase ASCII or hyphen).
    pub fn parse(raw: &str) -> Result<Self, SnapshotError> {
        if raw.is_empty() {
            return Err(SnapshotError::InvalidSnapshotId {
                raw: raw.to_string(),
                reason: "snapshot id must not be empty".to_string(),
            });
        }
        if raw.len() > MAX_SNAPSHOT_ID_BYTES {
            return Err(SnapshotError::InvalidSnapshotId {
                raw: raw.to_string(),
                reason: format!("snapshot id exceeds maximum byte length {MAX_SNAPSHOT_ID_BYTES}"),
            });
        }
        for byte in raw.as_bytes() {
            if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-') {
                return Err(SnapshotError::InvalidSnapshotId {
                    raw: raw.to_string(),
                    reason: format!(
                        "snapshot id contains disallowed character {:?}",
                        *byte as char
                    ),
                });
            }
        }
        Ok(Self(raw.to_string()))
    }

    /// The wire form.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Immutable controlled-playback snapshot. Constructors validate the
/// payload end-to-end; no `&mut` accessor exists post-construction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    schema_version: SnapshotSchemaVersion,
    #[serde(rename = "snapshotId")]
    id: SnapshotId,
    /// RFC3339 instant supplied by the runner. The substrate never calls
    /// `SystemTime::now()`.
    generated_at: String,
    /// Stable identifier of the inspectable surface that produced the
    /// snapshot. Two snapshots from different `inspectable_id` cannot be
    /// diffed.
    inspectable_id: String,
    state_tree: StateTree,
    /// Evidence tier of the snapshot. Capped at
    /// [`SNAPSHOT_EVIDENCE_TIER_CEILING`].
    evidence_tier: EvidenceTier,
    /// Per-port snapshot envelope tier. The runner enforces the declared
    /// class on every serialized write; an over-budget snapshot surfaces
    /// as [`SnapshotError::SnapshotEnvelopeOverflow`] and produces no
    /// partial output.
    envelope_class: SnapshotEnvelope,
}

impl Snapshot {
    /// Schema version pin.
    pub fn schema_version(&self) -> &SnapshotSchemaVersion {
        &self.schema_version
    }
    /// Snapshot id.
    pub fn snapshot_id(&self) -> &SnapshotId {
        &self.id
    }
    /// RFC3339 instant supplied by the runner.
    pub fn generated_at(&self) -> &str {
        &self.generated_at
    }
    /// Inspectable surface that produced this snapshot.
    pub fn inspectable_id(&self) -> &str {
        &self.inspectable_id
    }
    /// Read-only state tree accessor.
    pub fn state_tree(&self) -> &StateTree {
        &self.state_tree
    }
    /// Snapshot evidence tier.
    pub fn evidence_tier(&self) -> EvidenceTier {
        self.evidence_tier
    }
    /// Declared envelope tier. The runner enforces
    /// `envelope_class.max_bytes()` on every serialized write.
    pub fn envelope_class(&self) -> SnapshotEnvelope {
        self.envelope_class
    }

    /// Validate the snapshot end-to-end. Runs on construction and on
    /// [`Snapshot::from_json_value`].
    pub fn validate(&self) -> Result<(), SnapshotError> {
        if self.schema_version.as_str() != SNAPSHOT_SCHEMA_VERSION {
            return Err(SnapshotError::SchemaVersionMismatch {
                observed: self.schema_version.as_str().to_string(),
                expected: SNAPSHOT_SCHEMA_VERSION,
            });
        }
        // Re-run id validators so deserialized payloads cannot smuggle
        // malformed metadata past serde.
        SnapshotId::parse(self.id.as_str())?;
        validate_inspectable_id(&self.inspectable_id)?;
        validate_generated_at(&self.generated_at)?;
        if self.state_tree.is_empty() {
            return Err(SnapshotError::EmptyStateTree);
        }
        self.state_tree.validate()?;
        if self.evidence_tier > SNAPSHOT_EVIDENCE_TIER_CEILING {
            return Err(SnapshotError::EvidenceTierOverclaim {
                claimed: self.evidence_tier,
                ceiling: SNAPSHOT_EVIDENCE_TIER_CEILING,
            });
        }

        let serialized =
            serde_json::to_vec(self).map_err(|err| SnapshotError::SerializationFailure {
                reason: err.to_string(),
            })?;
        let limit_bytes = self.envelope_class.max_bytes();
        if serialized.len() > limit_bytes {
            return Err(SnapshotError::SnapshotEnvelopeOverflow {
                envelope_class: self.envelope_class,
                observed_bytes: serialized.len(),
                limit_bytes,
            });
        }
        // Belt-and-suspenders: redaction walk on the fully serialized
        // payload. The leaf-level validator already covers individual
        // string fields; this walk catches any field accidentally added
        // in the future that carries a host-shape string.
        let json_value: Value = serde_json::from_slice(&serialized).map_err(|err| {
            SnapshotError::SerializationFailure {
                reason: err.to_string(),
            }
        })?;
        reject_unredacted_local_paths_in_value("", &json_value)?;
        Ok(())
    }

    /// Serialize to a JSON `Value`. Re-runs `validate` so an inconsistent
    /// snapshot cannot leak through serialization.
    pub fn to_json_value(&self) -> Result<Value, SnapshotError> {
        self.validate()?;
        serde_json::to_value(self).map_err(|err| SnapshotError::SerializationFailure {
            reason: err.to_string(),
        })
    }

    /// Deserialize from a JSON `Value`. Validates the resulting snapshot
    /// end-to-end.
    pub fn from_json_value(value: Value) -> Result<Self, SnapshotError> {
        let snapshot: Self =
            serde_json::from_value(value).map_err(|err| SnapshotError::SerializationFailure {
                reason: err.to_string(),
            })?;
        snapshot.validate()?;
        Ok(snapshot)
    }
}

/// Lightweight reference to a snapshot for additive plumbing through
/// `RuntimeRequest`. Carries only the id; the full payload is resolved
/// out of band so `RuntimeRequest` does not grow unbounded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    pub snapshot_id: SnapshotId,
    pub inspectable_id: String,
    pub evidence_tier: EvidenceTier,
}

impl SnapshotRef {
    /// Validate the `SnapshotRef` shape (id parse, inspectable id parse
    /// tier ceiling).
    pub fn validate(&self) -> Result<(), SnapshotError> {
        SnapshotId::parse(self.snapshot_id.as_str())?;
        validate_inspectable_id(&self.inspectable_id)?;
        if self.evidence_tier > SNAPSHOT_EVIDENCE_TIER_CEILING {
            return Err(SnapshotError::EvidenceTierOverclaim {
                claimed: self.evidence_tier,
                ceiling: SNAPSHOT_EVIDENCE_TIER_CEILING,
            });
        }
        Ok(())
    }
}

/// Request payload for [`take_snapshot`]. The caller supplies the run id
/// and generated-at instant; the substrate never calls `SystemTime::now()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotRequest<'a> {
    /// Run id supplied by the runner; used as the namespace seed for
    /// `SnapshotId` derivation when the caller supplies no explicit id.
    pub run_id: &'a str,
    /// Optional caller-supplied id (otherwise derived deterministically
    /// from `run_id` + the supplied logical tick if any, see
    /// [`SnapshotRequest::tick`]).
    pub snapshot_id: Option<SnapshotId>,
    /// Caller-declared evidence tier (capped at
    /// [`SNAPSHOT_EVIDENCE_TIER_CEILING`] by `validate`).
    pub evidence_tier: EvidenceTier,
    /// RFC3339 instant supplied by the runner from its deterministic
    /// clock.
    pub generated_at: &'a str,
    /// Optional logical clock tick used as the deterministic id seed when
    /// `snapshot_id` is `None`.
    pub tick: Option<u64>,
    /// Per-port declared envelope tier. The runner threads this through
    /// from the port's [`super::SnapshotManifest`]; the serializer
    /// enforces the declared ceiling at write time.
    pub envelope_class: SnapshotEnvelope,
}

impl<'a> SnapshotRequest<'a> {
    /// Construct a request with the required fields and no tick / explicit
    /// id. The envelope class defaults to the smallest tier
    /// ([`SnapshotEnvelope::Small`]); callers with non-fixture state must
    /// explicitly upshift via [`SnapshotRequest::with_envelope_class`].
    pub fn new(run_id: &'a str, generated_at: &'a str, evidence_tier: EvidenceTier) -> Self {
        Self {
            run_id,
            snapshot_id: None,
            evidence_tier,
            generated_at,
            tick: None,
            envelope_class: SnapshotEnvelope::Small,
        }
    }

    /// Override the snapshot id (otherwise derived deterministically from
    /// `run_id` + `tick`).
    pub fn with_snapshot_id(mut self, snapshot_id: SnapshotId) -> Self {
        self.snapshot_id = Some(snapshot_id);
        self
    }

    /// Set the logical tick used as the deterministic id seed.
    pub fn with_tick(mut self, tick: u64) -> Self {
        self.tick = Some(tick);
        self
    }

    /// Set the per-port envelope tier declared on the port's
    /// [`super::SnapshotManifest`].
    pub fn with_envelope_class(mut self, envelope_class: SnapshotEnvelope) -> Self {
        self.envelope_class = envelope_class;
        self
    }
}

fn derive_snapshot_id(run_id: &str, tick: Option<u64>) -> Result<SnapshotId, SnapshotError> {
    // Derive a deterministic id from run_id + tick. Lowercase ASCII
    // digits / hyphen so the parser accepts the output. The id is a
    // stable, run-scoped seed; downstream callers may still supply their
    // own via `SnapshotRequest::with_snapshot_id` when they need control
    // over the value.
    let safe: String = run_id
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
                c
            } else if c.is_ascii_uppercase() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = safe.trim_matches('-');
    let safe = if trimmed.is_empty() { "run" } else { trimmed };
    let raw = match tick {
        Some(tick) => format!("snap-{safe}-{tick}"),
        None => format!("snap-{safe}"),
    };
    SnapshotId::parse(&raw)
}

/// Read the inspectable port's state into an immutable [`Snapshot`].
///
/// The builder pattern is internal; the public API is a single function so
/// callers cannot construct a snapshot from a partial / un-validated tree.
pub fn take_snapshot(
    inspectable: &dyn Inspectable,
    request: &SnapshotRequest<'_>,
) -> Result<Snapshot, SnapshotError> {
    let inspectable_id = inspectable.inspectable_id();
    validate_inspectable_id(inspectable_id)?;
    validate_generated_at(request.generated_at)?;
    if request.evidence_tier > SNAPSHOT_EVIDENCE_TIER_CEILING {
        return Err(SnapshotError::EvidenceTierOverclaim {
            claimed: request.evidence_tier,
            ceiling: SNAPSHOT_EVIDENCE_TIER_CEILING,
        });
    }
    let state_tree = inspectable.inspect_state()?;
    state_tree.validate()?;
    // The canonical envelope check runs against the whole serialized
    // snapshot inside `Snapshot::validate`, attributing observed_bytes
    // and limit_bytes to the declared `envelope_class.max_bytes()`. No
    // separate per-tree pre-check fires here — under the
    // envelope ceiling is the single canonical size gate.
    let snapshot_id = match &request.snapshot_id {
        Some(id) => id.clone(),
        None => derive_snapshot_id(request.run_id, request.tick)?,
    };
    let snapshot = Snapshot {
        schema_version: SnapshotSchemaVersion::current(),
        id: snapshot_id,
        generated_at: request.generated_at.to_string(),
        inspectable_id: inspectable_id.to_string(),
        state_tree,
        evidence_tier: request.evidence_tier,
        envelope_class: request.envelope_class,
    };
    snapshot.validate()?;
    Ok(snapshot)
}

/// Restore the supplied snapshot onto the `restorable` port.
pub fn restore_snapshot(
    restorable: &mut dyn Restorable,
    snapshot: &Snapshot,
) -> Result<RestoreReport, SnapshotError> {
    if snapshot.schema_version().as_str() != SNAPSHOT_SCHEMA_VERSION {
        return Err(SnapshotError::SchemaVersionMismatch {
            observed: snapshot.schema_version().as_str().to_string(),
            expected: SNAPSHOT_SCHEMA_VERSION,
        });
    }
    let port_id = restorable.inspectable_id();
    if port_id != snapshot.inspectable_id() {
        return Err(SnapshotError::InspectableIdMismatch {
            expected: snapshot.inspectable_id().to_string(),
            found: port_id.to_string(),
        });
    }
    restorable.restore_state(snapshot.state_tree())
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
