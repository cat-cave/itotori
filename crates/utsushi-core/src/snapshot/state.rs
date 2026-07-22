//! Engine-neutral state tree, paths, and leaf values.
//!
//! The state tree is a flat, path-keyed hierarchy of typed leaves. `StatePath`
//! is the only key shape; `StateValue` is the only leaf shape. Engine ports
//! must route every inspectable field through one of the pre-declared
//! `StateNamespace` roots; the `port.*` namespace is the engine-port escape
//! hatch.
//!
//! The substrate enforces three layers of redaction (see
//! [`super::redaction`]): paths are checked at parse time, leaf strings at
//! insert time, and the entire serialized tree at validation time.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{AssetId, LogicalClockTick};

use super::diagnostics::SnapshotError;
use super::redaction::{
    reject_unredacted_local_path_string, reject_unredacted_local_paths_in_value,
};

#[path = "state_validation.rs"]
mod state_validation;

/// Max length of the hex-encoded sample stored in `BytesValue::sample_hex`.
/// 128 hex chars = 64 raw bytes. Enough to distinguish blobs in a debug
/// dump; small enough to keep snapshots compact.
pub const BYTES_SAMPLE_HEX_LEN: usize = 128;

/// Required length of the lowercase-hex digest carried by `BytesValue`.
/// 64 = 32-byte digest (BLAKE3 / SHA-256 / etc.). The substrate does not
/// mandate the algorithm at the type level but the length is fixed so a
/// future bump fails loudly at validation rather than silently mis-comparing.
pub const BYTES_HASH_HEX_LEN: usize = 64;

/// Max path-string length (bytes).
pub const MAX_STATE_PATH_BYTES: usize = 512;

/// Max number of segments in a state path.
pub const MAX_STATE_PATH_SEGMENTS: usize = 12;

/// Engine-neutral top-level namespaces. New variants require a typed
/// addition; engine ports cannot smuggle ad-hoc roots in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateNamespace {
    /// Substrate-owned: clock tick, clock origin, input cursor, etc.
    Runtime,
    /// Substrate-owned: replay log id, cursor, asset refs.
    Replay,
    /// Observation-hook owned: bridge unit / scene cross-references.
    Bridge,
    /// VFS-owned: package + asset references (`AssetId` only).
    Vfs,
    /// Engine-port escape hatch: every port-specific field lives here.
    Port,
    /// Substrate-owned: run id, seed, adapter metadata.
    Metadata,
}

impl StateNamespace {
    /// Stable lowercase ASCII identifier used as the top-level state path
    /// segment.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Replay => "replay",
            Self::Bridge => "bridge",
            Self::Vfs => "vfs",
            Self::Port => "port",
            Self::Metadata => "metadata",
        }
    }

    /// Full set of namespaces in canonical order.
    pub const ALL: &'static [StateNamespace] = &[
        StateNamespace::Runtime,
        StateNamespace::Replay,
        StateNamespace::Bridge,
        StateNamespace::Vfs,
        StateNamespace::Port,
        StateNamespace::Metadata,
    ];

    /// Look up a namespace by its lowercase identifier.
    pub fn from_identifier(value: &str) -> Option<StateNamespace> {
        Self::ALL.iter().copied().find(|ns| ns.as_str() == value)
    }
}

/// Dotted, engine-neutral path into the state tree. Construction validates
/// the shape so a malformed path cannot enter the tree.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StatePath(String);

impl StatePath {
    /// Parse a dotted state path.
    ///
    /// Validation rules:
    /// - Non-empty.
    /// - Each segment matches `[a-z0-9][a-z0-9_-]*`, lowercase ASCII.
    /// - Maximum overall length [`MAX_STATE_PATH_BYTES`].
    /// - Maximum segment count [`MAX_STATE_PATH_SEGMENTS`].
    /// - First segment names a top-level [`StateNamespace`]. Unknown roots
    ///   are rejected.
    /// - Passes [`super::redaction::reject_unredacted_local_path_string`].
    pub fn parse(raw: &str) -> Result<Self, SnapshotError> {
        if raw.is_empty() {
            return Err(SnapshotError::InvalidStatePath {
                raw: raw.to_string(),
                reason: "state path must not be empty".to_string(),
            });
        }
        if raw.len() > MAX_STATE_PATH_BYTES {
            return Err(SnapshotError::InvalidStatePath {
                raw: raw.to_string(),
                reason: format!("state path exceeds maximum byte length {MAX_STATE_PATH_BYTES}"),
            });
        }
        // The local-path filter rejects backslashes, drive-letter shapes
        // home/, /tmp/, /Users/, etc. Apply it before per-segment shape so
        // the diagnostic is the most specific one.
        reject_unredacted_local_path_string(raw, raw).map_err(|err| match err {
            SnapshotError::RedactionViolation { field_path } => SnapshotError::InvalidStatePath {
                raw: raw.to_string(),
                reason: format!("state path matches host-path shape at {field_path}"),
            },
            other => other,
        })?;

        let segments: Vec<&str> = raw.split('.').collect();
        if segments.len() > MAX_STATE_PATH_SEGMENTS {
            return Err(SnapshotError::InvalidStatePath {
                raw: raw.to_string(),
                reason: format!(
                    "state path exceeds maximum segment count {MAX_STATE_PATH_SEGMENTS}"
                ),
            });
        }
        for segment in &segments {
            validate_segment(raw, segment)?;
        }

        let root = segments[0];
        if StateNamespace::from_identifier(root).is_none() {
            return Err(SnapshotError::UnknownStateNamespace {
                raw: raw.to_string(),
                observed_root: root.to_string(),
            });
        }

        Ok(Self(raw.to_string()))
    }

    /// The dotted path string in canonical form.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Iterate the path segments.
    pub fn segments(&self) -> impl Iterator<Item = &str> {
        self.0.split('.')
    }

    /// Top-level namespace segment (e.g. `"runtime"`, `"port"`).
    pub fn top_level(&self) -> &str {
        self.0.split('.').next().expect("non-empty after parse")
    }

    /// Typed top-level namespace.
    pub fn namespace(&self) -> StateNamespace {
        StateNamespace::from_identifier(self.top_level()).expect("parse validated namespace")
    }
}

impl std::fmt::Display for StatePath {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn validate_segment(raw: &str, segment: &str) -> Result<(), SnapshotError> {
    if segment.is_empty() {
        return Err(SnapshotError::InvalidStatePath {
            raw: raw.to_string(),
            reason: "state path segment must not be empty".to_string(),
        });
    }
    let bytes = segment.as_bytes();
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err(SnapshotError::InvalidStatePath {
            raw: raw.to_string(),
            reason: format!(
                "state path segment {segment:?} must start with lowercase ascii letter or digit"
            ),
        });
    }
    for byte in bytes {
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-') {
            return Err(SnapshotError::InvalidStatePath {
                raw: raw.to_string(),
                reason: format!(
                    "state path segment {segment:?} contains disallowed character {:?}",
                    *byte as char
                ),
            });
        }
    }
    Ok(())
}

/// Bounded, hex-encoded bytes plus a content hash. Used for opaque
/// engine-defined state regions. The hash is the load-bearing comparison
/// key; `sample_hex` is purely informational (capped at
/// [`BYTES_SAMPLE_HEX_LEN`]).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BytesValue {
    /// Hex-encoded prefix of the bytes, at most [`BYTES_SAMPLE_HEX_LEN`]
    /// characters (= 64 raw bytes). Lowercase hex; no `0x` prefix.
    pub sample_hex: String,
    /// Full content hash of the raw bytes, lowercase hex. The hash is
    /// the load-bearing comparison key — `diff` and equality compare on
    /// `hash`, never on `sample_hex`.
    pub hash: String,
    /// Total byte length of the original bytes (informational; not
    /// secret).
    pub length: u64,
}

impl BytesValue {
    /// Validate the bytes value shape (sample length, hex characters
    /// digest length).
    pub fn validate(&self, field_path: &str) -> Result<(), SnapshotError> {
        if self.sample_hex.len() > BYTES_SAMPLE_HEX_LEN {
            return Err(SnapshotError::InvalidBytesValue {
                field_path: field_path.to_string(),
                reason: format!(
                    "sample_hex length {} exceeds ceiling {}",
                    self.sample_hex.len(),
                    BYTES_SAMPLE_HEX_LEN
                ),
            });
        }
        for byte in self.sample_hex.as_bytes() {
            if !is_lowercase_hex(*byte) {
                return Err(SnapshotError::InvalidBytesValue {
                    field_path: field_path.to_string(),
                    reason: "sample_hex must be lowercase hex".to_string(),
                });
            }
        }
        if !self.sample_hex.len().is_multiple_of(2) {
            return Err(SnapshotError::InvalidBytesValue {
                field_path: field_path.to_string(),
                reason: "sample_hex must contain an even number of hex digits".to_string(),
            });
        }
        if self.hash.is_empty() {
            return Err(SnapshotError::InvalidBytesValue {
                field_path: field_path.to_string(),
                reason: "hash must not be empty".to_string(),
            });
        }
        if self.hash.len() != BYTES_HASH_HEX_LEN {
            return Err(SnapshotError::InvalidBytesValue {
                field_path: field_path.to_string(),
                reason: format!(
                    "hash length {} must equal {BYTES_HASH_HEX_LEN}",
                    self.hash.len()
                ),
            });
        }
        for byte in self.hash.as_bytes() {
            if !is_lowercase_hex(*byte) {
                return Err(SnapshotError::InvalidBytesValue {
                    field_path: field_path.to_string(),
                    reason: "hash must be lowercase hex".to_string(),
                });
            }
        }
        Ok(())
    }
}

impl PartialEq for BytesValue {
    fn eq(&self, other: &Self) -> bool {
        // The hash is the load-bearing comparison key. `sample_hex` is
        // informational and never tips equality (so two snapshots whose
        // implementations chose different sample prefixes still compare
        // equal on identical content).
        self.hash == other.hash && self.length == other.length
    }
}

impl Eq for BytesValue {}

fn is_lowercase_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// Engine-neutral leaf value. The enum is bounded; engine ports cannot
/// introduce new variants. `Nested` is the only branch node and lets the
/// tree express grouped values where a `StatePath` per leaf would be
/// awkward.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "valueKind", rename_all = "camelCase")]
pub enum StateValue {
    /// UTF-8 string. Validated through the local-path filter at insert
    /// time and again at serialized-form validation.
    #[serde(rename = "string", rename_all = "camelCase")]
    String { value: String },

    /// Signed 64-bit integer.
    #[serde(rename = "int", rename_all = "camelCase")]
    Int { value: i64 },

    /// Unsigned 64-bit integer.
    #[serde(rename = "uint", rename_all = "camelCase")]
    Uint { value: u64 },

    /// Boolean.
    #[serde(rename = "bool", rename_all = "camelCase")]
    Bool { value: bool },

    /// Asset reference. Stored as `AssetId`; never a raw path.
    #[serde(rename = "assetId", rename_all = "camelCase")]
    AssetId { value: AssetId },

    /// Bounded, hex-encoded bytes plus a content hash.
    #[serde(rename = "bytes", rename_all = "camelCase")]
    Bytes(BytesValue),

    /// Logical clock tick.
    #[serde(rename = "tick", rename_all = "camelCase")]
    Tick { value: LogicalClockTick },

    /// Ordered list of homogeneous leaves. Used sparingly (e.g.
    /// `replay.asset_refs`).
    #[serde(rename = "list", rename_all = "camelCase")]
    List { items: Vec<StateValue> },

    /// Nested subtree. Keys are leaf-level segments, not full `StatePath`s.
    /// Used to group fields that always co-vary.
    #[serde(rename = "nested", rename_all = "camelCase")]
    Nested {
        entries: BTreeMap<String, StateValue>,
    },
}

impl StateValue {
    /// Stable human-readable type tag used in `RestoreTypeMismatch`
    /// diagnostics. The strings are stable wire identifiers (snake_case)
    /// matching the `valueKind` tag serialized to JSON.
    pub fn type_tag(&self) -> &'static str {
        match self {
            Self::String { .. } => "string",
            Self::Int { .. } => "int",
            Self::Uint { .. } => "uint",
            Self::Bool { .. } => "bool",
            Self::AssetId { .. } => "assetId",
            Self::Bytes(_) => "bytes",
            Self::Tick { .. } => "tick",
            Self::List { .. } => "list",
            Self::Nested { .. } => "nested",
        }
    }

    /// Validate the value at insert time, asserting redaction and
    /// `BytesValue` shape constraints. `field_path` names the path the
    /// value will be inserted under so diagnostics quote it verbatim.
    pub fn validate(&self, field_path: &str) -> Result<(), SnapshotError> {
        match self {
            Self::String { value } => reject_unredacted_local_path_string(field_path, value),
            Self::Int { .. }
            | Self::Uint { .. }
            | Self::Bool { .. }
            | Self::Tick { .. }
            | Self::AssetId { .. } => Ok(()),
            Self::Bytes(bytes) => bytes.validate(field_path),
            Self::List { items } => {
                for (index, item) in items.iter().enumerate() {
                    let child = format!("{field_path}[{index}]");
                    item.validate(&child)?;
                }
                Ok(())
            }
            Self::Nested { entries } => {
                for (key, value) in entries {
                    state_validation::validate_nested_segment(field_path, key)?;
                    let child = format!("{field_path}.{key}");
                    value.validate(&child)?;
                }
                Ok(())
            }
        }
    }
}

/// Flat path-keyed state tree. The internal storage is a `BTreeMap` keyed
/// by `StatePath` so iteration and serialization order are deterministic.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StateTree(BTreeMap<StatePath, StateValue>);

impl StateTree {
    /// Construct an empty state tree.
    pub fn new() -> Self {
        Self(BTreeMap::new())
    }

    /// Insert a typed value at `path`. Fails if the path is already
    /// present (duplicate insertion is a structural error, never a
    /// silent overwrite).
    pub fn insert(&mut self, path: StatePath, value: StateValue) -> Result<(), SnapshotError> {
        // Validate the leaf shape using the insertion path as the field
        // path. The redaction walk on the full serialized form catches
        // anything the leaf-level validator misses.
        value.validate(path.as_str())?;
        if self.0.contains_key(&path) {
            return Err(SnapshotError::DuplicateStatePath {
                path: path.as_str().to_string(),
            });
        }
        self.0.insert(path, value);
        Ok(())
    }

    /// Look up the value at `path`.
    pub fn get(&self, path: &StatePath) -> Option<&StateValue> {
        self.0.get(path)
    }

    /// Iterate paths in canonical (sorted) order.
    pub fn paths(&self) -> impl Iterator<Item = &StatePath> {
        self.0.keys()
    }

    /// Iterate `(path, value)` pairs in canonical (sorted) order.
    pub fn iter(&self) -> impl Iterator<Item = (&StatePath, &StateValue)> {
        self.0.iter()
    }

    /// Number of entries in the tree.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the tree carries no entries.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Validate the whole tree end-to-end: re-runs redaction on every value
    /// (insert-time validator + serialized-form walk) and asserts every
    /// `BytesValue` has a non-empty hash. Serialized-form size is
    /// enforced one layer up, at the snapshot envelope tier
    /// ([`super::envelope::SnapshotEnvelope`]); the per-tree size budget
    /// is no longer a global constant under.
    pub fn validate(&self) -> Result<(), SnapshotError> {
        if self.0.is_empty() {
            return Err(SnapshotError::EmptyStateTree);
        }
        for (path, value) in &self.0 {
            value.validate(path.as_str())?;
        }
        let serialized =
            serde_json::to_vec(self).map_err(|err| SnapshotError::SerializationFailure {
                reason: err.to_string(),
            })?;
        let json_value = serde_json::from_slice(&serialized).map_err(|err| {
            SnapshotError::SerializationFailure {
                reason: err.to_string(),
            }
        })?;
        reject_unredacted_local_paths_in_value("", &json_value)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
