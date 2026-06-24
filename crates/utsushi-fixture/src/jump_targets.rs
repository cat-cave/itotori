//! Bridge-linked jump target fixtures (UTSUSHI-062).
//!
//! A [`JumpTargetSet`] is the engine-neutral fixture surface that pairs a list
//! of bridge-linked [`JumpTargetFixture`] entries with the deterministic
//! replay-log artifact captured at recording time. The model and loader live
//! here; the determinism gate that drives a fixture through controlled
//! playback and asserts byte-identical replay logs lives in
//! `crates/utsushi-core/tests/replay_log_jump_target.rs`.
//!
//! Hard properties enforced by the loader:
//!
//! - Every jump target carries a non-empty `bridge_unit_id` that must resolve
//!   through a caller-supplied [`BridgeUnitIndex`].
//! - No host paths appear in committed fixture JSON. The loader walks every
//!   string leaf through [`utsushi_core::looks_like_local_path`] and rejects
//!   anything that fails the project-wide redaction filter.
//! - Bridge linkage stays in the fixture domain: this slice does not touch
//!   `ReplayLog` or `ReplayEntry`. Linkage is expressed by logical-tick
//!   correspondence between a [`JumpTargetFixture::activates_at_tick`] and a
//!   `ReplayEntry::tick` in the paired log.

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utsushi_core::{LogicalClockTick, SourceTag, looks_like_local_path};

/// Schema version pin for the jump target fixture wire form. Co-versioned
/// with `REFERENCE_TRACE_SCHEMA_VERSION` (UTSUSHI-060) so a future schema
/// bump is a single coordinated event.
pub const JUMP_TARGET_SCHEMA_VERSION: &str = "0.1.0-alpha";

/// A single fixture jump target. Every target is bridge-linked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JumpTargetFixture {
    /// Stable target id (kebab-namespaced public string). Never a host path.
    /// The validator rejects whitespace, empty strings, and any value that
    /// `looks_like_local_path` flags.
    pub target_id: String,
    /// Bridge unit id this target resolves into. MUST exist in the
    /// [`BridgeUnitIndex`] passed to [`JumpTargetSet::validate`]; otherwise
    /// the validator emits [`JumpTargetError::JumpTargetMissingBridgeUnit`].
    pub bridge_unit_id: String,
    /// Optional human-readable label for review tooling only. Public string;
    /// the redaction filter applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Logical clock tick the target activates on. Used to align the jump in
    /// the paired replay log. Always `> 0` (tick 0 is the implicit
    /// "before any input" state and is reserved).
    pub activates_at_tick: LogicalClockTick,
}

/// A fixture's full set of bridge-linked jump targets, plus the canonical
/// ordering for replay-log alignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JumpTargetSet {
    /// Schema version pin. Loader rejects unknown versions.
    pub schema_version: String,
    /// `SourceTag::Fixture` only in this slice. The field exists so future
    /// engine-ported fixtures plug in without a schema bump.
    pub source: SourceTag,
    /// Public adapter identifier (matches the conformance manifest
    /// adapter_id used by the paired replay log).
    pub adapter_id: String,
    /// Jump targets in canonical order (sorted by
    /// `(activates_at_tick, target_id)`). The loader re-sorts on load and
    /// rejects duplicates by `target_id`.
    pub targets: Vec<JumpTargetFixture>,
}

/// Resolver passed to [`JumpTargetSet::validate`]. The fixture crate does not
/// own bridge unit storage; callers supply an index. The integration gate in
/// `utsushi-core/tests/replay_log_jump_target.rs` constructs an in-memory
/// index from the fixture's bridge unit list so the gate is self-contained.
pub trait BridgeUnitIndex {
    fn contains(&self, bridge_unit_id: &str) -> bool;
}

/// Built-in in-memory implementation for tests and the integration gate.
#[derive(Clone, Debug, Default)]
pub struct InMemoryBridgeUnitIndex(BTreeSet<String>);

impl InMemoryBridgeUnitIndex {
    /// Construct an empty index.
    pub fn new() -> Self {
        Self(BTreeSet::new())
    }

    /// Construct from an iterator of `bridge_unit_id`s. Duplicates collapse.
    pub fn from_ids<I, S>(ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut set = BTreeSet::new();
        for id in ids {
            set.insert(id.into());
        }
        Self(set)
    }

    /// Insert a bridge unit id.
    pub fn insert(&mut self, bridge_unit_id: impl Into<String>) {
        self.0.insert(bridge_unit_id.into());
    }

    /// Number of ids tracked.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the index is empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl BridgeUnitIndex for InMemoryBridgeUnitIndex {
    fn contains(&self, bridge_unit_id: &str) -> bool {
        self.0.contains(bridge_unit_id)
    }
}

/// Loader and validator diagnostics.
///
/// Every variant maps to a stable semantic code in
/// [`codes`]. Diagnostic strings are stable test-asserted text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JumpTargetError {
    /// `schema_version` did not match [`JUMP_TARGET_SCHEMA_VERSION`].
    UnsupportedSchemaVersion { observed: String, expected: String },
    /// Underlying JSON did not parse / failed `deny_unknown_fields`.
    InvalidJson { reason: String },
    /// A target id failed the project-wide redaction filter.
    TargetIdLooksLikeLocalPath { target_id: String, reason: String },
    /// A target id was duplicated within the set.
    DuplicateTargetId { target_id: String },
    /// A target references a bridge unit not present in the supplied
    /// [`BridgeUnitIndex`].
    JumpTargetMissingBridgeUnit {
        target_id: String,
        bridge_unit_id: String,
    },
    /// `activates_at_tick` was zero. Tick 0 is reserved for the implicit
    /// "before any input" state.
    ActivatesAtTickIsZero { target_id: String },
    /// A string leaf elsewhere in the document failed the redaction filter.
    UnredactedLocalPath { field_path: String, value: String },
    /// `target_id` or `bridge_unit_id` was blank / whitespace-only.
    BlankIdentifier { field: &'static str },
    /// Determinism gate caught a replay-log byte diff against the committed
    /// artifact.
    ReplayLogFingerprintMismatch { observed: String, expected: String },
}

impl fmt::Display for JumpTargetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion { observed, expected } => write!(
                formatter,
                "jump target fixture schema_version {observed:?} not supported; expected {expected:?}"
            ),
            Self::InvalidJson { reason } => {
                write!(formatter, "jump target fixture JSON invalid: {reason}")
            }
            Self::TargetIdLooksLikeLocalPath { target_id, reason } => write!(
                formatter,
                "jump target id {target_id:?} fails redaction filter ({reason})"
            ),
            Self::DuplicateTargetId { target_id } => {
                write!(formatter, "jump target id {target_id:?} duplicated")
            }
            Self::JumpTargetMissingBridgeUnit {
                target_id,
                bridge_unit_id,
            } => write!(
                formatter,
                "jump target {target_id:?} references missing bridge unit {bridge_unit_id:?}"
            ),
            Self::ActivatesAtTickIsZero { target_id } => write!(
                formatter,
                "jump target {target_id:?} activates_at_tick must be > 0 (tick 0 is reserved)"
            ),
            Self::UnredactedLocalPath { field_path, value } => write!(
                formatter,
                "jump target fixture contains unredacted local path at {field_path}: {value}"
            ),
            Self::BlankIdentifier { field } => {
                write!(
                    formatter,
                    "jump target fixture field {field} must not be blank"
                )
            }
            Self::ReplayLogFingerprintMismatch { observed, expected } => write!(
                formatter,
                "replay log fingerprint mismatch (observed {observed:?}, expected {expected:?})"
            ),
        }
    }
}

impl std::error::Error for JumpTargetError {}

impl JumpTargetError {
    /// Stable semantic code for this variant. Mirrors the
    /// `utsushi.fixture.jump_target.*` namespace called out by the plan.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::UnsupportedSchemaVersion { .. } => codes::UNSUPPORTED_SCHEMA_VERSION,
            Self::InvalidJson { .. } => codes::INVALID_JSON,
            Self::TargetIdLooksLikeLocalPath { .. } => codes::TARGET_ID_LOOKS_LIKE_LOCAL_PATH,
            Self::DuplicateTargetId { .. } => codes::DUPLICATE_TARGET_ID,
            Self::JumpTargetMissingBridgeUnit { .. } => codes::MISSING_BRIDGE_UNIT,
            Self::ActivatesAtTickIsZero { .. } => codes::ACTIVATES_AT_TICK_IS_ZERO,
            Self::UnredactedLocalPath { .. } => codes::UNREDACTED_LOCAL_PATH,
            Self::BlankIdentifier { .. } => codes::BLANK_IDENTIFIER,
            Self::ReplayLogFingerprintMismatch { .. } => codes::REPLAY_LOG_FINGERPRINT_MISMATCH,
        }
    }
}

/// Stable semantic codes for [`JumpTargetError`] variants. `ALL` is the
/// authoritative registry: the integration tests assert every variant's
/// `semantic_code()` is in `ALL`.
pub mod codes {
    pub const UNSUPPORTED_SCHEMA_VERSION: &str =
        "utsushi.fixture.jump_target.unsupported_schema_version";
    pub const INVALID_JSON: &str = "utsushi.fixture.jump_target.invalid_json";
    pub const TARGET_ID_LOOKS_LIKE_LOCAL_PATH: &str =
        "utsushi.fixture.jump_target.target_id_looks_like_local_path";
    pub const DUPLICATE_TARGET_ID: &str = "utsushi.fixture.jump_target.duplicate_target_id";
    pub const MISSING_BRIDGE_UNIT: &str = "utsushi.fixture.jump_target.missing_bridge_unit";
    pub const ACTIVATES_AT_TICK_IS_ZERO: &str =
        "utsushi.fixture.jump_target.activates_at_tick_is_zero";
    pub const UNREDACTED_LOCAL_PATH: &str = "utsushi.fixture.jump_target.unredacted_local_path";
    pub const BLANK_IDENTIFIER: &str = "utsushi.fixture.jump_target.blank_identifier";
    pub const REPLAY_LOG_FINGERPRINT_MISMATCH: &str =
        "utsushi.fixture.jump_target.replay_log_fingerprint_mismatch";

    /// Authoritative list of every stable semantic code emitted by
    /// [`super::JumpTargetError`].
    pub const ALL: &[&str] = &[
        UNSUPPORTED_SCHEMA_VERSION,
        INVALID_JSON,
        TARGET_ID_LOOKS_LIKE_LOCAL_PATH,
        DUPLICATE_TARGET_ID,
        MISSING_BRIDGE_UNIT,
        ACTIVATES_AT_TICK_IS_ZERO,
        UNREDACTED_LOCAL_PATH,
        BLANK_IDENTIFIER,
        REPLAY_LOG_FINGERPRINT_MISMATCH,
    ];
}

impl JumpTargetSet {
    /// Parse a jump target set from JSON bytes. Performs:
    ///
    /// 1. `serde_json::from_slice` with `deny_unknown_fields`.
    /// 2. Schema version check.
    /// 3. Full-document redaction walk via
    ///    [`utsushi_core::looks_like_local_path`].
    /// 4. Canonical sort of `targets` by `(activates_at_tick, target_id)`.
    pub fn load_from_json(bytes: &[u8]) -> Result<Self, JumpTargetError> {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|error| JumpTargetError::InvalidJson {
                reason: error.to_string(),
            })?;
        reject_unredacted_local_paths_in_value("", &value)?;
        let mut set: Self =
            serde_json::from_value(value).map_err(|error| JumpTargetError::InvalidJson {
                reason: error.to_string(),
            })?;
        if set.schema_version != JUMP_TARGET_SCHEMA_VERSION {
            return Err(JumpTargetError::UnsupportedSchemaVersion {
                observed: set.schema_version,
                expected: JUMP_TARGET_SCHEMA_VERSION.to_string(),
            });
        }
        if set.adapter_id.trim().is_empty() {
            return Err(JumpTargetError::BlankIdentifier { field: "adapterId" });
        }
        set.targets.sort_by(|left, right| {
            match left.activates_at_tick.cmp(&right.activates_at_tick) {
                std::cmp::Ordering::Equal => left.target_id.cmp(&right.target_id),
                other => other,
            }
        });
        Ok(set)
    }

    /// Validate the set against a [`BridgeUnitIndex`]. Pure function: no I/O,
    /// no clock, no env.
    pub fn validate(&self, index: &dyn BridgeUnitIndex) -> Result<(), JumpTargetError> {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for target in &self.targets {
            if target.target_id.trim().is_empty() {
                return Err(JumpTargetError::BlankIdentifier { field: "targetId" });
            }
            if target.bridge_unit_id.trim().is_empty() {
                return Err(JumpTargetError::BlankIdentifier {
                    field: "bridgeUnitId",
                });
            }
            if looks_like_local_path(&target.target_id) {
                return Err(JumpTargetError::TargetIdLooksLikeLocalPath {
                    target_id: target.target_id.clone(),
                    reason: "matches local-path heuristic".to_string(),
                });
            }
            if has_whitespace(&target.target_id) {
                return Err(JumpTargetError::TargetIdLooksLikeLocalPath {
                    target_id: target.target_id.clone(),
                    reason: "contains whitespace".to_string(),
                });
            }
            if target.activates_at_tick.0 == 0 {
                return Err(JumpTargetError::ActivatesAtTickIsZero {
                    target_id: target.target_id.clone(),
                });
            }
            if !seen.insert(target.target_id.as_str()) {
                return Err(JumpTargetError::DuplicateTargetId {
                    target_id: target.target_id.clone(),
                });
            }
            if !index.contains(&target.bridge_unit_id) {
                return Err(JumpTargetError::JumpTargetMissingBridgeUnit {
                    target_id: target.target_id.clone(),
                    bridge_unit_id: target.bridge_unit_id.clone(),
                });
            }
        }
        Ok(())
    }

    /// Convenience: load and validate against the supplied index.
    pub fn load_and_validate(
        bytes: &[u8],
        index: &dyn BridgeUnitIndex,
    ) -> Result<Self, JumpTargetError> {
        let set = Self::load_from_json(bytes)?;
        set.validate(index)?;
        Ok(set)
    }
}

fn has_whitespace(value: &str) -> bool {
    value.chars().any(|ch| ch.is_whitespace())
}

fn reject_unredacted_local_paths_in_value(
    path: &str,
    value: &Value,
) -> Result<(), JumpTargetError> {
    match value {
        Value::String(text) if looks_like_local_path(text) => {
            Err(JumpTargetError::UnredactedLocalPath {
                field_path: if path.is_empty() {
                    "<root>".to_string()
                } else {
                    path.to_string()
                },
                value: text.clone(),
            })
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                reject_unredacted_local_paths_in_value(&format!("{path}[{index}]"), item)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, child) in map {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                reject_unredacted_local_paths_in_value(&child_path, child)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_set_json() -> Value {
        json!({
            "schemaVersion": JUMP_TARGET_SCHEMA_VERSION,
            "source": "fixture",
            "adapterId": "utsushi-fixture",
            "targets": [
                {
                    "targetId": "target-b",
                    "bridgeUnitId": "bridge-unit-b",
                    "activatesAtTick": 5
                },
                {
                    "targetId": "target-a",
                    "bridgeUnitId": "bridge-unit-a",
                    "activatesAtTick": 4
                }
            ]
        })
    }

    fn index_with(ids: &[&str]) -> InMemoryBridgeUnitIndex {
        InMemoryBridgeUnitIndex::from_ids(ids.iter().copied())
    }

    #[test]
    fn loader_normalises_target_order_by_tick_then_id() {
        let bytes = serde_json::to_vec(&sample_set_json()).unwrap();
        let set = JumpTargetSet::load_from_json(&bytes).unwrap();
        let ids: Vec<&str> = set.targets.iter().map(|t| t.target_id.as_str()).collect();
        assert_eq!(ids, vec!["target-a", "target-b"]);
    }

    #[test]
    fn loader_rejects_unknown_schema_version() {
        let mut value = sample_set_json();
        value["schemaVersion"] = Value::String("9.9.9".to_string());
        let bytes = serde_json::to_vec(&value).unwrap();
        let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
        assert!(matches!(
            error,
            JumpTargetError::UnsupportedSchemaVersion { .. }
        ));
        assert_eq!(error.semantic_code(), codes::UNSUPPORTED_SCHEMA_VERSION,);
    }

    #[test]
    fn loader_rejects_unknown_field() {
        let mut value = sample_set_json();
        value
            .as_object_mut()
            .unwrap()
            .insert("extraField".to_string(), Value::String("nope".to_string()));
        let bytes = serde_json::to_vec(&value).unwrap();
        let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
        assert!(matches!(error, JumpTargetError::InvalidJson { .. }));
    }

    #[test]
    fn loader_rejects_host_path_in_label_field() {
        let mut value = sample_set_json();
        value["targets"][0]["label"] = Value::String("/home/trevor/secret".to_string());
        let bytes = serde_json::to_vec(&value).unwrap();
        let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
        match error {
            JumpTargetError::UnredactedLocalPath { field_path, .. } => {
                assert!(field_path.contains("label"));
            }
            other => panic!("expected UnredactedLocalPath, got {other:?}"),
        }
    }

    #[test]
    fn validate_passes_for_well_formed_set() {
        let bytes = serde_json::to_vec(&sample_set_json()).unwrap();
        let set = JumpTargetSet::load_from_json(&bytes).unwrap();
        let index = index_with(&["bridge-unit-a", "bridge-unit-b"]);
        set.validate(&index).unwrap();
    }

    #[test]
    fn validate_rejects_target_with_missing_bridge_unit() {
        let bytes = serde_json::to_vec(&sample_set_json()).unwrap();
        let set = JumpTargetSet::load_from_json(&bytes).unwrap();
        let index = index_with(&["bridge-unit-a"]);
        let error = set.validate(&index).unwrap_err();
        match error {
            JumpTargetError::JumpTargetMissingBridgeUnit {
                target_id,
                bridge_unit_id,
            } => {
                assert_eq!(target_id, "target-b");
                assert_eq!(bridge_unit_id, "bridge-unit-b");
            }
            other => panic!("expected JumpTargetMissingBridgeUnit, got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_duplicate_target_id() {
        // Force both targets to share targetId AND bridgeUnitId so the
        // sort by (tick, id) preserves both rather than collapsing.
        let mut value = sample_set_json();
        value["targets"][0]["targetId"] = Value::String("target-a".to_string());
        value["targets"][0]["bridgeUnitId"] = Value::String("bridge-unit-a".to_string());
        value["targets"][1]["targetId"] = Value::String("target-a".to_string());
        value["targets"][1]["bridgeUnitId"] = Value::String("bridge-unit-a".to_string());
        let bytes = serde_json::to_vec(&value).unwrap();
        let set = JumpTargetSet::load_from_json(&bytes).unwrap();
        let index = index_with(&["bridge-unit-a", "bridge-unit-b"]);
        let error = set.validate(&index).unwrap_err();
        match error {
            JumpTargetError::DuplicateTargetId { target_id } => {
                assert_eq!(target_id, "target-a");
            }
            other => panic!("expected DuplicateTargetId, got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_activates_at_tick_zero() {
        let mut value = sample_set_json();
        value["targets"][1]["activatesAtTick"] = json!(0);
        let bytes = serde_json::to_vec(&value).unwrap();
        let set = JumpTargetSet::load_from_json(&bytes).unwrap();
        let index = index_with(&["bridge-unit-a", "bridge-unit-b"]);
        let error = set.validate(&index).unwrap_err();
        match error {
            JumpTargetError::ActivatesAtTickIsZero { target_id } => {
                // After sort, tick 0 lands first.
                assert_eq!(target_id, "target-a");
            }
            other => panic!("expected ActivatesAtTickIsZero, got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_target_id_with_whitespace() {
        let mut value = sample_set_json();
        value["targets"][0]["targetId"] = Value::String("target b".to_string());
        let bytes = serde_json::to_vec(&value).unwrap();
        let set = JumpTargetSet::load_from_json(&bytes).unwrap();
        let index = index_with(&["bridge-unit-a", "bridge-unit-b"]);
        let error = set.validate(&index).unwrap_err();
        assert!(matches!(
            error,
            JumpTargetError::TargetIdLooksLikeLocalPath { .. }
        ));
    }

    #[test]
    fn every_variant_has_a_registered_code() {
        let variants = [
            JumpTargetError::UnsupportedSchemaVersion {
                observed: "x".to_string(),
                expected: "y".to_string(),
            },
            JumpTargetError::InvalidJson {
                reason: "x".to_string(),
            },
            JumpTargetError::TargetIdLooksLikeLocalPath {
                target_id: "x".to_string(),
                reason: "x".to_string(),
            },
            JumpTargetError::DuplicateTargetId {
                target_id: "x".to_string(),
            },
            JumpTargetError::JumpTargetMissingBridgeUnit {
                target_id: "x".to_string(),
                bridge_unit_id: "y".to_string(),
            },
            JumpTargetError::ActivatesAtTickIsZero {
                target_id: "x".to_string(),
            },
            JumpTargetError::UnredactedLocalPath {
                field_path: "x".to_string(),
                value: "y".to_string(),
            },
            JumpTargetError::BlankIdentifier { field: "x" },
            JumpTargetError::ReplayLogFingerprintMismatch {
                observed: "x".to_string(),
                expected: "y".to_string(),
            },
        ];
        for variant in &variants {
            let code = variant.semantic_code();
            assert!(
                codes::ALL.contains(&code),
                "code {code:?} for {variant:?} not in codes::ALL"
            );
        }
        // And the registry has no aliases for missing variants.
        assert_eq!(codes::ALL.len(), variants.len());
    }

    #[test]
    fn schema_version_constant_is_alpha() {
        assert_eq!(JUMP_TARGET_SCHEMA_VERSION, "0.1.0-alpha");
    }

    #[test]
    fn in_memory_bridge_unit_index_round_trips() {
        let mut index = InMemoryBridgeUnitIndex::new();
        assert!(index.is_empty());
        index.insert("bridge-unit-1");
        index.insert("bridge-unit-2");
        index.insert("bridge-unit-1");
        assert_eq!(index.len(), 2);
        assert!(index.contains("bridge-unit-1"));
        assert!(!index.contains("bridge-unit-3"));
    }
}
