//! Snapshot envelope size class ().
//!
//! Per-port declaration of how big the serialized snapshot may grow. The
//! substrate exposes three tiers; the runner enforces the declared tier
//! at write time and surfaces an [`super::SnapshotError::SnapshotEnvelopeOverflow`]
//! when the serialized bytes exceed the declared ceiling. **No silent
//! truncation. No partial output. No fallback to a larger tier.**
//!
//! The substrate-honesty audit §M.2 documented that the previous fixed
//! 16 KiB ceiling silenced real RealLive `REALLIVE.sav` shapes (24 876
//! bytes raw; ≥64 KiB once normalised into the int/str bank + graphics
//! layer state-tree form). The three tiers are sized to bracket realistic
//! engine save shapes:
//!
//! - [`SnapshotEnvelope::Small`] — 16 KiB — fixture / smoke shapes only.
//! - [`SnapshotEnvelope::Medium`] — 256 KiB — single-engine save state
//!   (RealLive `REALLIVE.sav`, MV/MZ `.rpgsave`).
//! - [`SnapshotEnvelope::Large`] — 4 MiB — full-engine state including
//!   asset / layer references at high entry counts.

use serde::{Deserialize, Serialize};

/// Per-port declared snapshot envelope ceiling. The runner enforces the
/// declared tier when serializing a snapshot; a serialized payload above
/// the declared ceiling surfaces as
/// [`super::SnapshotError::SnapshotEnvelopeOverflow`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotEnvelope {
    /// 16 KiB. Fixture / smoke shapes only.
    Small,
    /// 256 KiB. Single-engine save state — RealLive `REALLIVE.sav`
    /// MV/MZ `www/save/file*.rpgsave`.
    Medium,
    /// 4 MiB. Full-engine state including asset / layer references at
    /// high entry counts.
    Large,
}

impl SnapshotEnvelope {
    /// Ceiling for the serialized snapshot wire form (JSON bytes).
    pub const fn max_bytes(self) -> usize {
        match self {
            Self::Small => 16 * 1024,
            Self::Medium => 256 * 1024,
            Self::Large => 4 * 1024 * 1024,
        }
    }

    /// Stable lowercase identifier suitable for diagnostics / log fields.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
        }
    }
}

// Const-asserted ceilings. A typo in `max_bytes` fails compilation.
const _: () = assert!(SnapshotEnvelope::Small.max_bytes() == 16 * 1024);
const _: () = assert!(SnapshotEnvelope::Medium.max_bytes() == 256 * 1024);
const _: () = assert!(SnapshotEnvelope::Large.max_bytes() == 4 * 1024 * 1024);

/// Per-port manifest declaring the inspectable surface id and the snapshot
/// envelope class the runner enforces at write time. Engine ports
/// construct a [`SnapshotManifest`] once at registration and hand it to
/// the runner; the runner threads `envelope_class` through every
/// [`super::take_snapshot`] call against that port.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    /// Stable inspectable surface id (matches the value returned by
    /// `super::Inspectable::inspectable_id`).
    pub inspectable_id: String,
    /// Envelope class the runner enforces on every snapshot taken from
    /// this port. There is no upgrade path: bumping the declared class
    /// invalidates pre-bump snapshots.
    pub envelope_class: SnapshotEnvelope,
}

impl SnapshotManifest {
    /// Construct a manifest from the inspectable id and declared
    /// envelope class.
    pub fn new(inspectable_id: impl Into<String>, envelope_class: SnapshotEnvelope) -> Self {
        Self {
            inspectable_id: inspectable_id.into(),
            envelope_class,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_envelope_max_bytes_is_sixteen_kib() {
        assert_eq!(SnapshotEnvelope::Small.max_bytes(), 16 * 1024);
    }

    #[test]
    fn medium_envelope_max_bytes_is_two_hundred_fifty_six_kib() {
        assert_eq!(SnapshotEnvelope::Medium.max_bytes(), 256 * 1024);
    }

    #[test]
    fn large_envelope_max_bytes_is_four_mib() {
        assert_eq!(SnapshotEnvelope::Large.max_bytes(), 4 * 1024 * 1024);
    }

    #[test]
    fn envelope_round_trips_through_serde_json() {
        for envelope in [
            SnapshotEnvelope::Small,
            SnapshotEnvelope::Medium,
            SnapshotEnvelope::Large,
        ] {
            let json = serde_json::to_value(envelope).expect("serialize");
            let restored: SnapshotEnvelope = serde_json::from_value(json).expect("deserialize");
            assert_eq!(restored, envelope);
        }
    }

    #[test]
    fn manifest_round_trips_through_serde_json() {
        let manifest = SnapshotManifest::new("utsushi-fixture", SnapshotEnvelope::Medium);
        let json = serde_json::to_value(&manifest).expect("serialize");
        let restored: SnapshotManifest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(restored, manifest);
    }
}
