//! Headless runtime sink contracts.
//!
//! Three engine-neutral sink traits (`TextSurfaceSink`, `FrameArtifactSink`,
//! `AudioEventSink`) describe what a runtime port can announce as observed
//! evidence. Each sink carries its own evidence-tier ceiling so a low-tier
//! sink can not be mistaken for high-tier evidence. See plan
//! `.plan/UTSUSHI-022.md` and `docs/utsushi-fidelity-policy.md` (section
//! "Sink Tier Rules") for the per-sink rules.
//!
//! Posture (matches the UTSUSHI-020 `RuntimeVfs` substrate posture):
//!
//! - `Send + Sync`, `&self`-only methods. Interior mutability is the
//!   implementor's concern (typically a `Mutex<Vec<...>>` collector in the
//!   fixture).
//! - No `&Path`/`&PathBuf` on the trait surface. Path-shaped fields use
//!   [`crate::vfs::AssetId`] or [`crate::ObservationArtifactRef`].
//! - Payloads (`TextLine`, `FrameArtifact`, `AudioEvent`) implement
//!   `Serialize`/`Deserialize` with `#[serde(rename_all = "camelCase")]` to
//!   match the existing observation hook payloads.
//! - No optionality: an adapter that can not serve a sink kind returns
//!   [`SinkError::UnsupportedKind`]; the sink never silently drops.

use serde::{Deserialize, Serialize};

use crate::EvidenceTier;

pub mod audio;
pub mod errors;
pub mod frame;
pub mod set;
pub mod text;

pub use audio::{AudioEvent, AudioEventKind, AudioEventSink};
pub use errors::{SinkError, SinkResult, codes};
pub use frame::{FrameArtifact, FrameArtifactSink};
pub use set::{SinkCapabilitySummary, SinkSet};
pub use text::{TextLine, TextSurfaceSink};

/// Discriminant for the three sink contracts. Used by [`SinkError`] and
/// [`SinkCapabilitySummary`] so the sink under discussion is always a typed
/// enum, never a free-form string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SinkKind {
    TextSurface,
    FrameArtifact,
    AudioEvent,
}

impl SinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TextSurface => "text_surface",
            Self::FrameArtifact => "frame_artifact",
            Self::AudioEvent => "audio_event",
        }
    }

    /// Maximum evidence tier a single emission into this sink may claim.
    /// This is a per-sink ceiling and is independent of the adapter's
    /// declared `EvidenceTier` ceiling — it stops a low-tier sink from being
    /// mistaken for high-tier evidence.
    pub fn evidence_tier_ceiling(self) -> EvidenceTier {
        match self {
            Self::TextSurface => EvidenceTier::E1,
            Self::FrameArtifact => EvidenceTier::E4,
            Self::AudioEvent => EvidenceTier::E0,
        }
    }
}

/// Adapter-declared support for a sink kind. The `evidence_tier_ceiling`
/// inside `Supported` is the adapter's own ceiling for this sink (which may
/// be lower than [`SinkKind::evidence_tier_ceiling`], never higher).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SinkCapability {
    Unsupported,
    Supported { evidence_tier_ceiling: EvidenceTier },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sink_kind_as_str_matches_snake_case() {
        assert_eq!(SinkKind::TextSurface.as_str(), "text_surface");
        assert_eq!(SinkKind::FrameArtifact.as_str(), "frame_artifact");
        assert_eq!(SinkKind::AudioEvent.as_str(), "audio_event");
    }

    #[test]
    fn sink_kind_evidence_tier_ceilings_pin_audit_focus() {
        // Hard-pin the per-sink ceilings the audit focus depends on.
        assert_eq!(
            SinkKind::TextSurface.evidence_tier_ceiling(),
            EvidenceTier::E1
        );
        assert_eq!(
            SinkKind::FrameArtifact.evidence_tier_ceiling(),
            EvidenceTier::E4
        );
        assert_eq!(
            SinkKind::AudioEvent.evidence_tier_ceiling(),
            EvidenceTier::E0
        );
    }

    #[test]
    fn sink_capability_round_trips_through_serde() {
        let supported = SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        };
        let value = serde_json::to_value(supported).expect("serialize");
        assert_eq!(value["status"], "supported");
        let parsed: SinkCapability = serde_json::from_value(value).expect("deserialize");
        assert_eq!(parsed, supported);

        let unsupported = SinkCapability::Unsupported;
        let value = serde_json::to_value(unsupported).expect("serialize");
        assert_eq!(value["status"], "unsupported");
    }

    #[test]
    fn sink_kind_serde_round_trip_uses_snake_case() {
        for kind in [
            SinkKind::TextSurface,
            SinkKind::FrameArtifact,
            SinkKind::AudioEvent,
        ] {
            let value = serde_json::to_value(kind).expect("serialize");
            let parsed: SinkKind = serde_json::from_value(value.clone()).expect("deserialize");
            assert_eq!(parsed, kind);
            assert_eq!(value.as_str().unwrap(), kind.as_str());
        }
    }
}
