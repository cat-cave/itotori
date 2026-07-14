//! Stable semantic diagnostics for the runtime sink contracts.
//!
//! These mirror the `vfs::diagnostics::codes::ALL` precedent so a
//! downstream conformance allowed-code validator can not silently drop a
//! variant. Every variant carries a stable `utsushi.sink.*` semantic code and
//! enough public context (sink kind, adapter id, tier values) to be
//! redaction-safe without raw host strings.

use std::fmt;

use crate::EvidenceTier;

use super::SinkKind;

/// Stable Utsushi runtime sink semantic codes.
pub mod codes {
    pub const UNSUPPORTED_KIND: &str = "utsushi.sink.unsupported_kind";
    pub const EVIDENCE_TIER_MISMATCH: &str = "utsushi.sink.evidence_tier_mismatch";
    pub const ARTIFACT_POLICY: &str = "utsushi.sink.artifact_policy";
    pub const REDACTION_VIOLATION: &str = "utsushi.sink.redaction_violation";
    pub const BUDGET_EXHAUSTED: &str = "utsushi.sink.budget_exhausted";

    /// The full list of stable Utsushi sink semantic codes. Conformance
    /// schemas that gate runtime diagnostics by allowed-code list should
    /// include each of these.
    pub const ALL: &[&str] = &[
        UNSUPPORTED_KIND,
        EVIDENCE_TIER_MISMATCH,
        ARTIFACT_POLICY,
        REDACTION_VIOLATION,
        BUDGET_EXHAUSTED,
    ];
}

/// Diagnostic variants emitted by the headless runtime sinks. Each variant is
/// a stable conformance signal; never silent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SinkError {
    /// The adapter routed an emission to a sink kind it cannot serve. This is
    /// the canonical "no optionality" case from the audit focus: a text-only
    /// adapter receiving an audio event MUST return this rather than dropping.
    UnsupportedKind {
        sink: SinkKind,
        adapter_id: String,
        reason: String,
    },

    /// The emission's evidence tier violates the sink's per-kind ceiling or
    /// the frame-artifact lower bound (E2). Includes both ceiling violations
    /// (claim too high) and floor violations (claim too low for the sink).
    EvidenceTierMismatch {
        sink: SinkKind,
        claimed: EvidenceTier,
        ceiling: EvidenceTier,
    },

    /// The frame artifact ref is not a managed runtime artifact URI, or its
    /// `artifact_kind` is not in the allow-list of headless-runtime artifact
    /// kinds.
    ArtifactPolicy { artifact_id: String, reason: String },

    /// A payload field matched the local-path redaction filter
    /// ([`crate::redaction::reject_unredacted_local_paths`]) after
    /// serialization. Carries the offending field path inside the payload.
    RedactionViolation { sink: SinkKind, field: String },

    /// A write exceeded the configured soft artifact-byte budget (per the
    /// fidelity policy's `artifactLimits`). Surfaced on the real artifact-store
    /// write path by [`crate::RuntimeArtifactRoot::write_bytes`] when the root
    /// carries a soft byte budget (see
    /// [`crate::RuntimeArtifactRoot::with_soft_byte_budget`]); the artifact
    /// store is the `FrameArtifact` sink's storage surface, so `sink` is always
    /// [`SinkKind::FrameArtifact`] and `budget` is
    /// [`crate::RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL`].
    BudgetExhausted { sink: SinkKind, budget: String },
}

impl SinkError {
    /// Stable Utsushi semantic code, e.g. `"utsushi.sink.unsupported_kind"`.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::UnsupportedKind { .. } => codes::UNSUPPORTED_KIND,
            Self::EvidenceTierMismatch { .. } => codes::EVIDENCE_TIER_MISMATCH,
            Self::ArtifactPolicy { .. } => codes::ARTIFACT_POLICY,
            Self::RedactionViolation { .. } => codes::REDACTION_VIOLATION,
            Self::BudgetExhausted { .. } => codes::BUDGET_EXHAUSTED,
        }
    }

    /// The sink kind this diagnostic refers to. `ArtifactPolicy` is always a
    /// `FrameArtifact` diagnostic because no other sink touches artifact
    /// refs.
    pub fn sink(&self) -> SinkKind {
        match self {
            Self::UnsupportedKind { sink, .. }
            | Self::EvidenceTierMismatch { sink, .. }
            | Self::RedactionViolation { sink, .. }
            | Self::BudgetExhausted { sink, .. } => *sink,
            Self::ArtifactPolicy { .. } => SinkKind::FrameArtifact,
        }
    }
}

/// `Result` alias used throughout the sink module surface.
pub type SinkResult<T> = Result<T, SinkError>;

impl fmt::Display for SinkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::UnsupportedKind {
                sink,
                adapter_id,
                reason,
            } => write!(
                formatter,
                "{code}: sink={} adapter={} reason={}",
                sink.as_str(),
                adapter_id,
                reason
            ),
            Self::EvidenceTierMismatch {
                sink,
                claimed,
                ceiling,
            } => write!(
                formatter,
                "{code}: sink={} claimed={} ceiling={}",
                sink.as_str(),
                claimed.as_str(),
                ceiling.as_str()
            ),
            Self::ArtifactPolicy {
                artifact_id,
                reason,
            } => write!(
                formatter,
                "{code}: artifact_id={artifact_id} reason={reason}"
            ),
            Self::RedactionViolation { sink, field } => {
                write!(formatter, "{code}: sink={} field={}", sink.as_str(), field)
            }
            Self::BudgetExhausted { sink, budget } => {
                write!(
                    formatter,
                    "{code}: sink={} budget={}",
                    sink.as_str(),
                    budget
                )
            }
        }
    }
}

impl std::error::Error for SinkError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_codes_all_registered_in_module_list() {
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        let variants = [
            SinkError::UnsupportedKind {
                sink: SinkKind::AudioEvent,
                adapter_id: "synthetic-json".to_string(),
                reason: "no audio support".to_string(),
            }
            .semantic_code(),
            SinkError::EvidenceTierMismatch {
                sink: SinkKind::TextSurface,
                claimed: EvidenceTier::E2,
                ceiling: EvidenceTier::E1,
            }
            .semantic_code(),
            SinkError::ArtifactPolicy {
                artifact_id: "frame-001".to_string(),
                reason: "non-managed uri".to_string(),
            }
            .semantic_code(),
            SinkError::RedactionViolation {
                sink: SinkKind::TextSurface,
                field: "speaker".to_string(),
            }
            .semantic_code(),
            SinkError::BudgetExhausted {
                sink: SinkKind::FrameArtifact,
                budget: "frame_byte_cap".to_string(),
            }
            .semantic_code(),
        ];
        for code in variants {
            assert!(all.contains(code), "code {code} missing from codes::ALL");
        }
    }

    #[test]
    fn display_contains_stable_semantic_code() {
        let error = SinkError::EvidenceTierMismatch {
            sink: SinkKind::AudioEvent,
            claimed: EvidenceTier::E1,
            ceiling: EvidenceTier::E0,
        };
        let rendered = error.to_string();
        assert!(rendered.starts_with("utsushi.sink.evidence_tier_mismatch"));
        assert!(rendered.contains("audio_event"));
        assert!(rendered.contains("E1"));
        assert!(rendered.contains("E0"));
    }

    #[test]
    fn display_output_contains_no_host_path_substrings() {
        // The sink error display surface is constructed from only public
        // engine-neutral fields (sink kind enum, adapter id, semantic
        // reasons, tier names). Caller-supplied free-form `reason` strings
        // are still in adapter scope, so this is a structural check: the
        // formatter itself does not introduce host paths.
        let cases = [
            SinkError::UnsupportedKind {
                sink: SinkKind::TextSurface,
                adapter_id: "fixture".to_string(),
                reason: "no support".to_string(),
            },
            SinkError::EvidenceTierMismatch {
                sink: SinkKind::FrameArtifact,
                claimed: EvidenceTier::E1,
                ceiling: EvidenceTier::E2,
            },
            SinkError::ArtifactPolicy {
                artifact_id: "frame-001".to_string(),
                reason: "non-managed uri".to_string(),
            },
            SinkError::RedactionViolation {
                sink: SinkKind::AudioEvent,
                field: "source_asset".to_string(),
            },
            SinkError::BudgetExhausted {
                sink: SinkKind::FrameArtifact,
                budget: "frame_byte_cap".to_string(),
            },
        ];
        for error in &cases {
            let rendered = error.to_string();
            for forbidden in ["/home/", "/tmp/", "/Users/", "/var/folders/", "file://"] {
                assert!(
                    !rendered.contains(forbidden),
                    "rendered={rendered} contained forbidden substring {forbidden}"
                );
            }
        }
    }

    #[test]
    fn sink_method_classifies_artifact_policy_as_frame() {
        let error = SinkError::ArtifactPolicy {
            artifact_id: "a".to_string(),
            reason: "b".to_string(),
        };
        assert_eq!(error.sink(), SinkKind::FrameArtifact);
    }

    #[test]
    fn sink_method_returns_declared_sink_for_carrying_variants() {
        for sink in [
            SinkKind::TextSurface,
            SinkKind::FrameArtifact,
            SinkKind::AudioEvent,
        ] {
            let error = SinkError::UnsupportedKind {
                sink,
                adapter_id: "x".to_string(),
                reason: "y".to_string(),
            };
            assert_eq!(error.sink(), sink);
        }
    }
}
