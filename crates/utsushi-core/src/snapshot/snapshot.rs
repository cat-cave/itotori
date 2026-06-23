//! Immutable `Snapshot` payload plus `take_snapshot` / `restore_snapshot`
//! orchestration.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::EvidenceTier;

use super::diagnostics::SnapshotError;
use super::inspectable::{Inspectable, Restorable, RestoreReport};
use super::redaction::reject_unredacted_local_paths_in_value;
use super::state::{STATE_TREE_MAX_SERIALIZED_BYTES, StateTree};

/// Schema version pin for the snapshot substrate.
pub const SNAPSHOT_SCHEMA_VERSION: &str = "0.1.0-alpha";

/// Max serialized snapshot size (JSON, bytes). 16 KiB catches accidental
/// binary embedding loudly.
pub const SNAPSHOT_MAX_SERIALIZED_BYTES: usize = 16 * 1024;

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

/// Inspectable surface identifier. Lowercase ASCII kebab matches the
/// adapter id shape used by [`crate::conformance::ConformanceManifest`].
fn validate_inspectable_id(raw: &str) -> Result<(), SnapshotError> {
    if raw.is_empty() {
        return Err(SnapshotError::InvalidInspectableId {
            raw: raw.to_string(),
            reason: "inspectable id must not be empty".to_string(),
        });
    }
    if raw.len() > 128 {
        return Err(SnapshotError::InvalidInspectableId {
            raw: raw.to_string(),
            reason: "inspectable id exceeds 128 bytes".to_string(),
        });
    }
    for byte in raw.as_bytes() {
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-') {
            return Err(SnapshotError::InvalidInspectableId {
                raw: raw.to_string(),
                reason: format!(
                    "inspectable id contains disallowed character {:?}",
                    *byte as char
                ),
            });
        }
    }
    Ok(())
}

fn validate_generated_at(raw: &str) -> Result<(), SnapshotError> {
    if raw.is_empty() {
        return Err(SnapshotError::InvalidGeneratedAt {
            raw: raw.to_string(),
            reason: "generated_at must not be empty".to_string(),
        });
    }
    if !is_valid_rfc3339_instant(raw) {
        return Err(SnapshotError::InvalidGeneratedAt {
            raw: raw.to_string(),
            reason: "generated_at must be RFC3339".to_string(),
        });
    }
    Ok(())
}

/// Local copy of the RFC3339 instant validator (mirrors the helper used
/// by observation hook events). Kept module-private so the substrate has
/// no implicit dependency on the lib.rs internal validator.
fn is_valid_rfc3339_instant(value: &str) -> bool {
    let Some((date, time_and_offset)) = value.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let Some(year) = parse_u32(&date[0..4]) else {
        return false;
    };
    let Some(month) = parse_u32(&date[5..7]) else {
        return false;
    };
    let Some(day) = parse_u32(&date[8..10]) else {
        return false;
    };

    let (time, offset) = if let Some(time) = time_and_offset.strip_suffix('Z') {
        (time, "Z")
    } else if let Some((offset_index, _)) = time_and_offset
        .char_indices()
        .rev()
        .find(|(_, c)| *c == '+' || *c == '-')
    {
        if offset_index == 0 {
            return false;
        }
        (
            &time_and_offset[..offset_index],
            &time_and_offset[offset_index..],
        )
    } else {
        return false;
    };

    if time.len() < 8
        || time.as_bytes().get(2) != Some(&b':')
        || time.as_bytes().get(5) != Some(&b':')
    {
        return false;
    }
    let Some(hour) = parse_u32(&time[0..2]) else {
        return false;
    };
    let Some(minute) = parse_u32(&time[3..5]) else {
        return false;
    };
    let second_text = &time[6..];
    let (second_text, fraction) = second_text
        .split_once('.')
        .map_or((second_text, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    let Some(second) = parse_u32(second_text) else {
        return false;
    };
    if second_text.len() != 2
        || fraction.is_some_and(|fraction| {
            fraction.is_empty() || !fraction.as_bytes().iter().all(u8::is_ascii_digit)
        })
    {
        return false;
    }

    if month == 0
        || month > 12
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }

    if offset == "Z" {
        return true;
    }
    if offset.len() != 6 || offset.as_bytes().get(3) != Some(&b':') {
        return false;
    }
    let Some(offset_hour) = parse_u32(&offset[1..3]) else {
        return false;
    };
    let Some(offset_minute) = parse_u32(&offset[4..6]) else {
        return false;
    };
    offset_hour <= 23 && offset_minute <= 59
}

fn parse_u32(value: &str) -> Option<u32> {
    if value.is_empty() || !value.as_bytes().iter().all(u8::is_ascii_digit) {
        return None;
    }
    value.parse().ok()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

/// Immutable controlled-playback snapshot. Constructors validate the
/// payload end-to-end; no `&mut` accessor exists post-construction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    schema_version: SnapshotSchemaVersion,
    snapshot_id: SnapshotId,
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
}

impl Snapshot {
    /// Schema version pin.
    pub fn schema_version(&self) -> &SnapshotSchemaVersion {
        &self.schema_version
    }
    /// Snapshot id.
    pub fn snapshot_id(&self) -> &SnapshotId {
        &self.snapshot_id
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
        SnapshotId::parse(self.snapshot_id.as_str())?;
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
        if serialized.len() > SNAPSHOT_MAX_SERIALIZED_BYTES {
            return Err(SnapshotError::SnapshotTooLarge {
                size: serialized.len(),
                ceiling: SNAPSHOT_MAX_SERIALIZED_BYTES,
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
    /// Validate the `SnapshotRef` shape (id parse, inspectable id parse,
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
}

impl<'a> SnapshotRequest<'a> {
    /// Construct a request with the required fields and no tick / explicit
    /// id.
    pub fn new(run_id: &'a str, generated_at: &'a str, evidence_tier: EvidenceTier) -> Self {
        Self {
            run_id,
            snapshot_id: None,
            evidence_tier,
            generated_at,
            tick: None,
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
}

fn derive_snapshot_id(run_id: &str, tick: Option<u64>) -> Result<SnapshotId, SnapshotError> {
    // Derive a deterministic id from run_id + tick. Lowercase ASCII /
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
    // Cap the state-tree size early so `Snapshot::validate` can attribute
    // the failure to the substrate's per-tree ceiling when the wider
    // snapshot envelope would still fit.
    let tree_bytes =
        serde_json::to_vec(&state_tree).map_err(|err| SnapshotError::SerializationFailure {
            reason: err.to_string(),
        })?;
    if tree_bytes.len() > STATE_TREE_MAX_SERIALIZED_BYTES {
        return Err(SnapshotError::StateTreeTooLarge {
            size: tree_bytes.len(),
            ceiling: STATE_TREE_MAX_SERIALIZED_BYTES,
        });
    }
    let snapshot_id = match &request.snapshot_id {
        Some(id) => id.clone(),
        None => derive_snapshot_id(request.run_id, request.tick)?,
    };
    let snapshot = Snapshot {
        schema_version: SnapshotSchemaVersion::current(),
        snapshot_id,
        generated_at: request.generated_at.to_string(),
        inspectable_id: inspectable_id.to_string(),
        state_tree,
        evidence_tier: request.evidence_tier,
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
mod tests {
    use super::*;
    use crate::snapshot::state::{StatePath, StateValue};
    use std::collections::BTreeMap;

    struct DummyInspect {
        id: &'static str,
        tree: StateTree,
    }
    impl Inspectable for DummyInspect {
        fn inspectable_id(&self) -> &'static str {
            self.id
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            Ok(self.tree.clone())
        }
    }

    fn make_tree() -> StateTree {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("runtime.clock.tick").expect("path"),
            StateValue::Tick {
                value: crate::LogicalClockTick(7),
            },
        )
        .expect("insert tick");
        tree.insert(
            StatePath::parse("port.frame").expect("path"),
            StateValue::Uint { value: 12 },
        )
        .expect("insert frame");
        tree
    }

    fn make_snapshot() -> Snapshot {
        let port = DummyInspect {
            id: "utsushi-fixture",
            tree: make_tree(),
        };
        let request =
            SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(7);
        take_snapshot(&port, &request).expect("snapshot")
    }

    #[test]
    fn snapshot_validate_accepts_well_formed_snapshot_at_e2() {
        let snapshot = make_snapshot();
        assert_eq!(snapshot.evidence_tier(), EvidenceTier::E2);
        snapshot.validate().expect("valid snapshot");
    }

    #[test]
    fn snapshot_validate_rejects_evidence_tier_above_e3() {
        let port = DummyInspect {
            id: "utsushi-fixture",
            tree: make_tree(),
        };
        let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E4);
        let err = take_snapshot(&port, &request).expect_err("over-claim");
        assert!(matches!(err, SnapshotError::EvidenceTierOverclaim { .. }));
    }

    #[test]
    fn snapshot_validate_rejects_empty_state_tree() {
        let port = DummyInspect {
            id: "utsushi-fixture",
            tree: StateTree::new(),
        };
        let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2);
        let err = take_snapshot(&port, &request).expect_err("empty tree");
        assert!(matches!(err, SnapshotError::EmptyStateTree));
    }

    #[test]
    fn snapshot_from_json_value_rejects_mismatched_schema_version() {
        let snapshot = make_snapshot();
        let mut json = snapshot.to_json_value().expect("to json");
        json["schemaVersion"] = "9.9.9".into();
        let err = Snapshot::from_json_value(json).expect_err("bad schema");
        assert!(matches!(err, SnapshotError::SchemaVersionMismatch { .. }));
    }

    #[test]
    fn snapshot_round_trips_through_serde_json() {
        let snapshot = make_snapshot();
        let json = snapshot.to_json_value().expect("to json");
        let restored = Snapshot::from_json_value(json).expect("from json");
        assert_eq!(restored, snapshot);
    }

    #[test]
    fn snapshot_to_json_value_passes_reject_unredacted_local_paths() {
        let snapshot = make_snapshot();
        let value = snapshot.to_json_value().expect("to json");
        reject_unredacted_local_paths_in_value("", &value).expect("no leak");
    }

    #[test]
    fn snapshot_serialized_form_stays_under_documented_ceiling() {
        let snapshot = make_snapshot();
        let bytes = serde_json::to_vec(&snapshot).expect("serialize");
        assert!(
            bytes.len() < SNAPSHOT_MAX_SERIALIZED_BYTES,
            "size {} exceeded ceiling",
            bytes.len()
        );
    }

    #[test]
    fn snapshot_ref_round_trips_id_inspectable_id_and_tier_only() {
        let snapshot_ref = SnapshotRef {
            snapshot_id: SnapshotId::parse("snap-run-1").expect("id"),
            inspectable_id: "utsushi-fixture".to_string(),
            evidence_tier: EvidenceTier::E2,
        };
        snapshot_ref.validate().expect("clean");
        let json = serde_json::to_value(&snapshot_ref).expect("to json");
        let restored: SnapshotRef = serde_json::from_value(json).expect("from json");
        assert_eq!(restored, snapshot_ref);
    }

    #[test]
    fn take_snapshot_from_inspectable_returns_validated_snapshot() {
        let snapshot = make_snapshot();
        assert_eq!(snapshot.inspectable_id(), "utsushi-fixture");
        assert!(!snapshot.state_tree().is_empty());
    }

    #[test]
    fn take_snapshot_derives_id_deterministically_from_run_id_when_unset() {
        let port = DummyInspect {
            id: "utsushi-fixture",
            tree: make_tree(),
        };
        let req_a =
            SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(7);
        let req_b =
            SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(7);
        let a = take_snapshot(&port, &req_a).expect("a");
        let b = take_snapshot(&port, &req_b).expect("b");
        assert_eq!(a.snapshot_id(), b.snapshot_id());
    }

    #[test]
    fn take_snapshot_rejects_inspectable_that_produces_invalid_state_tree() {
        struct BadPort;
        impl Inspectable for BadPort {
            fn inspectable_id(&self) -> &'static str {
                "utsushi-fixture"
            }
            fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
                // Return an empty tree which fails validation.
                Ok(StateTree::new())
            }
        }
        let port = BadPort;
        let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2);
        let err = take_snapshot(&port, &request).expect_err("invalid");
        assert!(matches!(err, SnapshotError::EmptyStateTree));
    }

    #[test]
    fn take_snapshot_requires_caller_supplied_generated_at_rfc3339_string() {
        let port = DummyInspect {
            id: "utsushi-fixture",
            tree: make_tree(),
        };
        let request = SnapshotRequest::new("run-001", "not-an-rfc3339", EvidenceTier::E2);
        let err = take_snapshot(&port, &request).expect_err("bad time");
        assert!(matches!(err, SnapshotError::InvalidGeneratedAt { .. }));
    }

    /// The substrate never calls `SystemTime::now()`. This is enforced by
    /// the caller-supplied `generated_at` contract; we assert here that
    /// the validator rejects the most obvious accidental input.
    #[test]
    fn take_snapshot_does_not_call_system_time_now() {
        // Documentation / API contract test: the substrate only accepts
        // a caller-supplied RFC3339 timestamp. There is no public way to
        // build a snapshot without one. (`Snapshot` has only private
        // fields so no caller can construct one directly.)
        let port = DummyInspect {
            id: "utsushi-fixture",
            tree: make_tree(),
        };
        // Passing the empty string fails — no substrate-side fallback to
        // wall-clock time.
        let request = SnapshotRequest::new("run-001", "", EvidenceTier::E2);
        let err = take_snapshot(&port, &request).expect_err("no fallback");
        assert!(matches!(err, SnapshotError::InvalidGeneratedAt { .. }));
    }

    // Restorable round-trip & restoration error tests.

    struct FakePort {
        id: &'static str,
        frame: u64,
        last_string: Option<String>,
    }

    impl Inspectable for FakePort {
        fn inspectable_id(&self) -> &'static str {
            self.id
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            let mut tree = StateTree::new();
            tree.insert(
                StatePath::parse("port.frame").expect("path"),
                StateValue::Uint { value: self.frame },
            )?;
            if let Some(text) = &self.last_string {
                tree.insert(
                    StatePath::parse("port.last").expect("path"),
                    StateValue::String {
                        value: text.clone(),
                    },
                )?;
            }
            tree.insert(
                StatePath::parse("metadata.adapter_name").expect("path"),
                StateValue::String {
                    value: "fake-port".to_string(),
                },
            )?;
            Ok(tree)
        }
    }

    impl Restorable for FakePort {
        fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
            let mut consumed = Vec::new();
            let mut ignored = Vec::new();
            for (path, value) in state.iter() {
                match (path.as_str(), value) {
                    ("port.frame", StateValue::Uint { value }) => {
                        self.frame = *value;
                        consumed.push(path.clone());
                    }
                    ("port.frame", other) => {
                        return Err(SnapshotError::RestoreTypeMismatch {
                            path: path.clone(),
                            expected: "uint",
                            found: other.type_tag(),
                        });
                    }
                    ("port.last", StateValue::String { value }) => {
                        self.last_string = Some(value.clone());
                        consumed.push(path.clone());
                    }
                    ("metadata.adapter_name", StateValue::String { .. }) => {
                        // Metadata is informational; declare ignored by
                        // design so the runner can audit-track it.
                        ignored.push(path.clone());
                    }
                    _ => {
                        return Err(SnapshotError::RestoreStatePathUnknown { path: path.clone() });
                    }
                }
            }
            Ok(RestoreReport {
                consumed_paths: consumed,
                ignored_by_design: ignored,
            })
        }
    }

    fn take(port: &dyn Inspectable, tick: u64) -> Snapshot {
        let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2)
            .with_tick(tick);
        take_snapshot(port, &request).expect("snapshot")
    }

    #[test]
    fn restore_snapshot_round_trip_produces_equal_snapshot_on_re_take() {
        let mut port = FakePort {
            id: "fake-port",
            frame: 1,
            last_string: Some("hello".to_string()),
        };
        let snapshot_a = take(&port, 1);
        port.frame = 42;
        port.last_string = Some("changed".to_string());
        restore_snapshot(&mut port, &snapshot_a).expect("restore");
        let snapshot_b = take(&port, 1);
        assert_eq!(snapshot_a, snapshot_b);
        let bytes_a = serde_json::to_vec(&snapshot_a).expect("a bytes");
        let bytes_b = serde_json::to_vec(&snapshot_b).expect("b bytes");
        assert_eq!(bytes_a, bytes_b, "canonical JSON form must be byte-equal");
    }

    #[test]
    fn restore_snapshot_with_mismatched_inspectable_id_returns_typed_error() {
        let port_a = FakePort {
            id: "fake-port",
            frame: 1,
            last_string: None,
        };
        let snapshot = take(&port_a, 1);
        let mut port_b = FakePort {
            id: "different-port",
            frame: 0,
            last_string: None,
        };
        let err = restore_snapshot(&mut port_b, &snapshot).expect_err("mismatch");
        assert!(matches!(err, SnapshotError::InspectableIdMismatch { .. }));
    }

    #[test]
    fn restore_snapshot_with_unknown_state_path_returns_restore_state_path_unknown() {
        // Construct a snapshot whose state tree carries a path the port
        // does not consume.
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.unknown_thing").expect("p"),
            StateValue::Uint { value: 1 },
        )
        .expect("insert");
        struct PortReturningSeed;
        impl Inspectable for PortReturningSeed {
            fn inspectable_id(&self) -> &'static str {
                "fake-port"
            }
            fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
                let mut tree = StateTree::new();
                tree.insert(
                    StatePath::parse("port.unknown_thing").expect("p"),
                    StateValue::Uint { value: 1 },
                )?;
                Ok(tree)
            }
        }
        let seed_port = PortReturningSeed;
        let snapshot = take(&seed_port, 1);
        let mut port = FakePort {
            id: "fake-port",
            frame: 0,
            last_string: None,
        };
        let err = restore_snapshot(&mut port, &snapshot).expect_err("unknown");
        assert!(matches!(err, SnapshotError::RestoreStatePathUnknown { .. }));
    }

    #[test]
    fn restore_snapshot_with_wrong_type_returns_restore_type_mismatch() {
        struct WrongTypePort;
        impl Inspectable for WrongTypePort {
            fn inspectable_id(&self) -> &'static str {
                "fake-port"
            }
            fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
                let mut tree = StateTree::new();
                tree.insert(
                    StatePath::parse("port.frame").expect("p"),
                    StateValue::String {
                        value: "not-a-number".to_string(),
                    },
                )?;
                Ok(tree)
            }
        }
        let wrong = WrongTypePort;
        let snapshot = take(&wrong, 1);
        let mut port = FakePort {
            id: "fake-port",
            frame: 0,
            last_string: None,
        };
        let err = restore_snapshot(&mut port, &snapshot).expect_err("mismatch");
        assert!(matches!(err, SnapshotError::RestoreTypeMismatch { .. }));
    }

    #[test]
    fn restore_snapshot_with_out_of_range_value_returns_restore_value_out_of_range() {
        struct StrictPort {
            frame: u64,
        }
        impl Inspectable for StrictPort {
            fn inspectable_id(&self) -> &'static str {
                "strict-port"
            }
            fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
                let mut tree = StateTree::new();
                tree.insert(
                    StatePath::parse("port.frame").expect("p"),
                    StateValue::Uint { value: self.frame },
                )?;
                Ok(tree)
            }
        }
        impl Restorable for StrictPort {
            fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
                for (path, value) in state.iter() {
                    if path.as_str() == "port.frame"
                        && let StateValue::Uint { value } = value
                    {
                        if *value > 1_000 {
                            return Err(SnapshotError::RestoreValueOutOfRange {
                                path: path.clone(),
                                reason: "frame ceiling 1000".to_string(),
                            });
                        }
                        self.frame = *value;
                    }
                }
                Ok(RestoreReport::empty())
            }
        }
        let seed = StrictPort { frame: 10_000 };
        let snapshot = take(&seed, 1);
        let mut port = StrictPort { frame: 0 };
        let err = restore_snapshot(&mut port, &snapshot).expect_err("out of range");
        assert!(matches!(err, SnapshotError::RestoreValueOutOfRange { .. }));
    }

    #[test]
    fn restore_snapshot_on_inspect_only_port_returns_restore_unsupported() {
        // A port that does not implement `Restorable` cannot be passed to
        // `restore_snapshot` (compile-time check). Surface the same
        // posture via the typed error: a port that knows it cannot
        // restore returns `RestoreUnsupported` from inside its
        // implementation.
        struct InspectOnlyWithStub;
        impl Inspectable for InspectOnlyWithStub {
            fn inspectable_id(&self) -> &'static str {
                "inspect-only"
            }
            fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
                let mut tree = StateTree::new();
                tree.insert(
                    StatePath::parse("port.frame").expect("p"),
                    StateValue::Uint { value: 1 },
                )?;
                Ok(tree)
            }
        }
        impl Restorable for InspectOnlyWithStub {
            fn restore_state(&mut self, _: &StateTree) -> Result<RestoreReport, SnapshotError> {
                Err(SnapshotError::RestoreUnsupported {
                    inspectable_id: "inspect-only".to_string(),
                })
            }
        }
        let seed = InspectOnlyWithStub;
        let snapshot = take(&seed, 1);
        let mut port = InspectOnlyWithStub;
        let err = restore_snapshot(&mut port, &snapshot).expect_err("unsupported");
        assert!(matches!(err, SnapshotError::RestoreUnsupported { .. }));
    }

    #[test]
    fn restore_snapshot_with_old_schema_version_returns_schema_version_mismatch() {
        let snapshot = make_snapshot();
        let mut json = snapshot.to_json_value().expect("json");
        json["schemaVersion"] = "0.0.1".into();
        // Bypass `from_json_value` validation by constructing the
        // Snapshot manually through serde — we want to exercise the
        // `restore_snapshot` check, not the from_json_value check.
        // Use a permissive deserializer wrapper.
        #[derive(Serialize, Deserialize)]
        struct Raw {
            schema_version: SnapshotSchemaVersion,
            snapshot_id: SnapshotId,
            generated_at: String,
            inspectable_id: String,
            state_tree: StateTree,
            evidence_tier: EvidenceTier,
        }
        impl Raw {
            fn into_snapshot(self) -> Snapshot {
                // Build via JSON round-trip into a Snapshot value
                // bypassing `from_json_value`'s validate call.
                serde_json::from_value(serde_json::json!({
                    "schemaVersion": self.schema_version,
                    "snapshotId": self.snapshot_id,
                    "generatedAt": self.generated_at,
                    "inspectableId": self.inspectable_id,
                    "stateTree": self.state_tree,
                    "evidenceTier": self.evidence_tier,
                }))
                .expect("snapshot")
            }
        }
        let raw = Raw {
            schema_version: SnapshotSchemaVersion("0.0.1".to_string()),
            snapshot_id: snapshot.snapshot_id().clone(),
            generated_at: snapshot.generated_at().to_string(),
            inspectable_id: snapshot.inspectable_id().to_string(),
            state_tree: snapshot.state_tree().clone(),
            evidence_tier: snapshot.evidence_tier(),
        };
        let bad_snapshot = raw.into_snapshot();
        let mut port = FakePort {
            id: "utsushi-fixture",
            frame: 0,
            last_string: None,
        };
        let err = restore_snapshot(&mut port, &bad_snapshot).expect_err("bad schema");
        assert!(matches!(err, SnapshotError::SchemaVersionMismatch { .. }));
    }

    // Compile-time / structural assertion: `Snapshot` has no
    // `state_tree_mut` accessor. Attempting to use one fails at compile
    // time and the absence of such a method is structurally enforced
    // by the private field + read-only accessor surface above.
    //
    // We exercise the read-only posture by asserting that `state_tree`
    // returns a shared reference whose lifetime is bounded by `&self`.
    #[test]
    fn snapshot_state_tree_accessor_returns_shared_reference_only() {
        let snapshot = make_snapshot();
        let tree_ref: &StateTree = snapshot.state_tree();
        // The returned reference borrows from `snapshot`. We can read
        // through it but cannot mutate via this accessor (no `&mut`
        // alternative is provided).
        assert!(!tree_ref.is_empty());
    }

    // Suppress unused warning: BTreeMap import used by code under test.
    #[test]
    fn snapshot_schema_version_constant_matches_pin() {
        assert_eq!(
            SnapshotSchemaVersion::current().as_str(),
            SNAPSHOT_SCHEMA_VERSION
        );
        let _ = BTreeMap::<String, StateValue>::new();
    }
}
