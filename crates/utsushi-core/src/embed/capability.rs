//! Capability declaration for the WASM embed ABI substrate.
//!
//! The capability list is the canonical answer to "what observable surface
//! does this embed expose?" An `Unsupported` capability tells the host the
//! underlying field must not be read (see
//! [`EmbedCapabilityStatus::is_available`]); the host consults the
//! capability vector rather than relying on a silent missing field.
//!
//! Capability ids are an append-only typed enum. New variants are added at
//! the end of [`EmbedCapabilityId`]; ordering is stable on both
//! `(EmbedCapabilityId as u8, EmbedCapabilityId::as_str())` so a numeric
//! reshuffle preserves lexicographic order.

use serde::{Deserialize, Serialize};

use crate::EvidenceTier;

use super::diagnostics::EmbedError;

/// Maximum number of capabilities a single declaration list may carry. The
/// pre-declared id enum has 5 variants today; the ceiling is loose so future
/// ABI bumps have headroom.
pub const EMBED_MAX_CAPABILITIES: usize = 32;

/// Pre-declared, append-only capability ids. Engine ports cannot smuggle
/// ad-hoc strings; new variants are an additive ABI bump.
///
/// The enum derives `PartialOrd`/`Ord` so the substrate can sort by
/// `(EmbedCapabilityId as u8, as_str())`. The audit-focus "stable order"
/// guarantee depends on this being a typed enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedCapabilityId {
    /// Embed can return a current state envelope at all. Required for any
    /// envelope.
    State,
    /// Embed can return a non-empty trace lines vector.
    Trace,
    /// Embed can return a non-null `current_snapshot` ref.
    Snapshot,
    /// Embed exposes `artifact_refs` that resolve to managed runtime
    /// artifact URIs.
    ArtifactRefs,
    /// Embed declares deterministic-fixture posture (UTSUSHI-fixture-class
    /// embed). Engine ports declare a different posture; this is the only
    /// id tied to fixture vs engine.
    DeterministicFixture,
}

impl EmbedCapabilityId {
    /// Stable snake_case string form for this capability id. Matches the
    /// `#[serde(rename_all = "snake_case")]` wire form so the
    /// `(as u8, as_str())` sort key is deterministic.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::State => "state",
            Self::Trace => "trace",
            Self::Snapshot => "snapshot",
            Self::ArtifactRefs => "artifact_refs",
            Self::DeterministicFixture => "deterministic_fixture",
        }
    }

    /// Total order key used by [`validate_capability_list`] to assert a
    /// deterministic listing. Primary key is the enum discriminant
    /// (`as u8`); secondary key is the stable string form so a future enum
    /// reshuffle preserves lexicographic order.
    pub fn sort_key(self) -> (u8, &'static str) {
        (self as u8, self.as_str())
    }
}

/// Whether the embed supports, partially supports, or does not support a
/// declared capability. `Partial` and `Supported` both carry an evidence
/// tier ceiling; `Unsupported` carries none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedCapabilityStatus {
    Supported,
    Partial,
    Unsupported,
}

impl EmbedCapabilityStatus {
    /// Stable snake_case string form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Partial => "partial",
            Self::Unsupported => "unsupported",
        }
    }

    /// Whether the host may read the underlying field. `Supported | Partial`
    /// promise a present field; `Unsupported` tells the host the field must
    /// not be read.
    pub fn is_available(self) -> bool {
        matches!(self, Self::Supported | Self::Partial)
    }
}

/// Single capability declaration. The host MUST consult the capability
/// vector for this id BEFORE invoking any read on the corresponding field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedCapability {
    /// Stable string id. See [`EmbedCapabilityId`].
    pub capability_id: EmbedCapabilityId,
    /// Support status. See [`EmbedCapabilityStatus`].
    pub status: EmbedCapabilityStatus,
    /// Evidence-tier ceiling the embed can guarantee for this capability.
    /// `None` iff `status == Unsupported`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_tier_ceiling: Option<EvidenceTier>,
    /// Free-form, public-safe phrases describing partial support or
    /// fixture-only limitations. Validated as non-blank strings; never a
    /// host path.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub limitations: Vec<String>,
}

impl EmbedCapability {
    /// Construct a `Supported` declaration with a ceiling and no
    /// limitations.
    pub fn supported(id: EmbedCapabilityId, ceiling: EvidenceTier) -> Self {
        Self {
            capability_id: id,
            status: EmbedCapabilityStatus::Supported,
            evidence_tier_ceiling: Some(ceiling),
            limitations: Vec::new(),
        }
    }

    /// Construct a `Partial` declaration with a ceiling and at least one
    /// limitation string (validated on `validate`).
    pub fn partial(id: EmbedCapabilityId, ceiling: EvidenceTier, limitations: Vec<String>) -> Self {
        Self {
            capability_id: id,
            status: EmbedCapabilityStatus::Partial,
            evidence_tier_ceiling: Some(ceiling),
            limitations,
        }
    }

    /// Construct an `Unsupported` declaration. Limitations are optional but
    /// recommended so the host UI can render a public-safe reason string.
    pub fn unsupported(id: EmbedCapabilityId, limitations: Vec<String>) -> Self {
        Self {
            capability_id: id,
            status: EmbedCapabilityStatus::Unsupported,
            evidence_tier_ceiling: None,
            limitations,
        }
    }

    /// Per-field validator. Called by [`validate_capability_list`].
    pub fn validate(&self) -> Result<(), EmbedError> {
        match self.status {
            EmbedCapabilityStatus::Supported => {
                if self.evidence_tier_ceiling.is_none() {
                    return Err(EmbedError::InvalidCapability {
                        capability_id: self.capability_id,
                        reason: "supported capability must declare an evidence tier ceiling"
                            .to_string(),
                    });
                }
            }
            EmbedCapabilityStatus::Partial => {
                if self.evidence_tier_ceiling.is_none() {
                    return Err(EmbedError::InvalidCapability {
                        capability_id: self.capability_id,
                        reason: "partial capability must declare an evidence tier ceiling"
                            .to_string(),
                    });
                }
                if self.limitations.is_empty() {
                    return Err(EmbedError::InvalidCapability {
                        capability_id: self.capability_id,
                        reason: "partial capability must declare at least one limitation"
                            .to_string(),
                    });
                }
            }
            EmbedCapabilityStatus::Unsupported => {
                if self.evidence_tier_ceiling.is_some() {
                    return Err(EmbedError::InvalidCapability {
                        capability_id: self.capability_id,
                        reason: "unsupported capability must not declare an evidence tier ceiling"
                            .to_string(),
                    });
                }
            }
        }
        for limitation in &self.limitations {
            if limitation.trim().is_empty() {
                return Err(EmbedError::InvalidCapability {
                    capability_id: self.capability_id,
                    reason: "limitation strings must be non-blank".to_string(),
                });
            }
        }
        Ok(())
    }
}

/// Validate a capability list end-to-end: each entry passes `validate`, the
/// list contains no duplicate ids, the list is sorted by
/// [`EmbedCapabilityId::sort_key`], the list is non-empty, and the list
/// length is bounded by [`EMBED_MAX_CAPABILITIES`].
pub fn validate_capability_list(capabilities: &[EmbedCapability]) -> Result<(), EmbedError> {
    if capabilities.is_empty() {
        return Err(EmbedError::InvalidCapability {
            capability_id: EmbedCapabilityId::State,
            reason: "capability list must declare at least one capability".to_string(),
        });
    }
    if capabilities.len() > EMBED_MAX_CAPABILITIES {
        return Err(EmbedError::CapabilitiesTooLarge {
            observed: capabilities.len(),
            ceiling: EMBED_MAX_CAPABILITIES,
        });
    }
    let mut previous: Option<(u8, &'static str)> = None;
    let mut seen: Vec<EmbedCapabilityId> = Vec::with_capacity(capabilities.len());
    for capability in capabilities {
        capability.validate()?;
        if seen.contains(&capability.capability_id) {
            return Err(EmbedError::DuplicateCapability {
                capability_id: capability.capability_id,
            });
        }
        seen.push(capability.capability_id);
        let current = capability.capability_id.sort_key();
        if let Some(previous_key) = previous
            && previous_key >= current
        {
            return Err(EmbedError::UnsortedCapabilities);
        }
        previous = Some(current);
    }
    Ok(())
}

/// Sort a capability vector into the deterministic order asserted by
/// [`validate_capability_list`]. Re-exported for adapter-side callers that
/// build a capability vector incrementally and want to
/// canonicalise before serialization.
pub fn sort_capabilities(capabilities: &mut [EmbedCapability]) {
    capabilities.sort_by_key(|capability| capability.capability_id.sort_key());
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn embed_capability_supported_requires_evidence_tier_ceiling() {
        let capability = EmbedCapability {
            capability_id: EmbedCapabilityId::State,
            status: EmbedCapabilityStatus::Supported,
            evidence_tier_ceiling: None,
            limitations: Vec::new(),
        };
        let error = capability.validate().expect_err("missing ceiling rejected");
        assert!(matches!(
            error,
            EmbedError::InvalidCapability {
                capability_id: EmbedCapabilityId::State,
                ..
            }
        ));
    }

    #[test]
    fn embed_capability_partial_requires_at_least_one_limitation() {
        let capability = EmbedCapability {
            capability_id: EmbedCapabilityId::Snapshot,
            status: EmbedCapabilityStatus::Partial,
            evidence_tier_ceiling: Some(EvidenceTier::E2),
            limitations: Vec::new(),
        };
        let error = capability
            .validate()
            .expect_err("missing limitation rejected");
        assert!(matches!(
            error,
            EmbedError::InvalidCapability {
                capability_id: EmbedCapabilityId::Snapshot,
                ..
            }
        ));
    }

    #[test]
    fn embed_capability_unsupported_rejects_evidence_tier_ceiling() {
        let capability = EmbedCapability {
            capability_id: EmbedCapabilityId::Trace,
            status: EmbedCapabilityStatus::Unsupported,
            evidence_tier_ceiling: Some(EvidenceTier::E2),
            limitations: Vec::new(),
        };
        let error = capability
            .validate()
            .expect_err("unsupported with ceiling rejected");
        assert!(matches!(
            error,
            EmbedError::InvalidCapability {
                capability_id: EmbedCapabilityId::Trace,
                ..
            }
        ));
    }

    #[test]
    fn embed_capability_round_trips_through_serde_json() {
        let capability = EmbedCapability::partial(
            EmbedCapabilityId::Trace,
            EvidenceTier::E1,
            vec!["fixture mode only".to_string()],
        );
        let value = serde_json::to_value(&capability).expect("serialize");
        let parsed: EmbedCapability = serde_json::from_value(value).expect("deserialize");
        assert_eq!(parsed, capability);
    }

    #[test]
    fn embed_capability_serializes_with_camel_case_wire_form() {
        let capability = EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2);
        let value = serde_json::to_value(&capability).expect("serialize");
        let obj = value.as_object().expect("object");
        assert!(obj.contains_key("capabilityId"));
        assert!(obj.contains_key("status"));
        assert!(obj.contains_key("evidenceTierCeiling"));
        assert!(!obj.contains_key("capability_id"));
        assert!(!obj.contains_key("evidence_tier_ceiling"));
        assert_eq!(obj["capabilityId"].as_str(), Some("state"));
        assert_eq!(obj["status"].as_str(), Some("supported"));
        assert_eq!(obj["evidenceTierCeiling"].as_str(), Some("E2"));
    }

    fn sample_sorted_list() -> Vec<EmbedCapability> {
        vec![
            EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
            EmbedCapability::supported(EmbedCapabilityId::Trace, EvidenceTier::E1),
            EmbedCapability::partial(
                EmbedCapabilityId::Snapshot,
                EvidenceTier::E2,
                vec!["snapshots id-only".to_string()],
            ),
            EmbedCapability::unsupported(
                EmbedCapabilityId::ArtifactRefs,
                vec!["fixture has no managed artifact corpus".to_string()],
            ),
            EmbedCapability::supported(EmbedCapabilityId::DeterministicFixture, EvidenceTier::E1),
        ]
    }

    #[test]
    fn embed_capability_list_sorted_by_id_is_deterministic() {
        let list = sample_sorted_list();
        validate_capability_list(&list).expect("sorted list accepted");
        let first = serde_json::to_string(&list).expect("serialize 1");
        let second = serde_json::to_string(&list).expect("serialize 2");
        assert_eq!(first, second, "two serializations must be byte-identical");
    }

    #[test]
    fn embed_capability_list_rejects_duplicate_ids() {
        let list = vec![
            EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
            EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
        ];
        let error = validate_capability_list(&list).expect_err("duplicate rejected");
        assert!(matches!(
            error,
            EmbedError::DuplicateCapability {
                capability_id: EmbedCapabilityId::State
            }
        ));
    }

    #[test]
    fn embed_capability_list_rejects_unsorted_input_on_validate() {
        let list = vec![
            EmbedCapability::supported(EmbedCapabilityId::Trace, EvidenceTier::E1),
            EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
        ];
        let error = validate_capability_list(&list).expect_err("unsorted rejected");
        assert!(matches!(error, EmbedError::UnsortedCapabilities));
    }

    #[test]
    fn embed_capability_list_rejects_empty_input() {
        let list: Vec<EmbedCapability> = Vec::new();
        let error = validate_capability_list(&list).expect_err("empty rejected");
        assert!(matches!(error, EmbedError::InvalidCapability { .. }));
    }

    #[test]
    fn embed_capability_list_rejects_over_ceiling() {
        let mut list = Vec::new();
        // Synthesize EMBED_MAX_CAPABILITIES + 1 entries by repeating a
        // supported entry with all five ids cycled; duplicates would normally
        // fire first, so we deliberately use the sort_key to seed a sequence
        // that exceeds the ceiling before validate finds the duplicate.
        for index in 0..=EMBED_MAX_CAPABILITIES {
            let id = match index % 5 {
                0 => EmbedCapabilityId::State,
                1 => EmbedCapabilityId::Trace,
                2 => EmbedCapabilityId::Snapshot,
                3 => EmbedCapabilityId::ArtifactRefs,
                _ => EmbedCapabilityId::DeterministicFixture,
            };
            list.push(EmbedCapability::supported(id, EvidenceTier::E1));
        }
        let error = validate_capability_list(&list).expect_err("over ceiling rejected");
        assert!(matches!(
            error,
            EmbedError::CapabilitiesTooLarge { observed, ceiling }
                if observed == EMBED_MAX_CAPABILITIES + 1 && ceiling == EMBED_MAX_CAPABILITIES
        ));
    }

    #[test]
    fn embed_capability_status_round_trips_through_serde_json() {
        for status in [
            EmbedCapabilityStatus::Supported,
            EmbedCapabilityStatus::Partial,
            EmbedCapabilityStatus::Unsupported,
        ] {
            let value = serde_json::to_value(status).expect("serialize");
            let parsed: EmbedCapabilityStatus = serde_json::from_value(value).expect("deserialize");
            assert_eq!(parsed, status);
        }
    }

    #[test]
    fn embed_capability_status_is_available_for_supported_and_partial_only() {
        assert!(EmbedCapabilityStatus::Supported.is_available());
        assert!(EmbedCapabilityStatus::Partial.is_available());
        assert!(!EmbedCapabilityStatus::Unsupported.is_available());
    }

    #[test]
    fn embed_capability_id_as_str_matches_serde_wire_form() {
        for id in [
            EmbedCapabilityId::State,
            EmbedCapabilityId::Trace,
            EmbedCapabilityId::Snapshot,
            EmbedCapabilityId::ArtifactRefs,
            EmbedCapabilityId::DeterministicFixture,
        ] {
            let json = serde_json::to_value(id).expect("serialize");
            assert_eq!(json, json!(id.as_str()));
        }
    }

    #[test]
    fn embed_capability_id_sort_key_uses_discriminant_and_string() {
        // The audit-focus claim: the secondary string key preserves
        // lexicographic order even if discriminants change.
        let state_key = EmbedCapabilityId::State.sort_key();
        let trace_key = EmbedCapabilityId::Trace.sort_key();
        assert_eq!(state_key.0, 0);
        assert_eq!(state_key.1, "state");
        assert!(state_key < trace_key);
    }

    #[test]
    fn sort_capabilities_canonicalises_an_unsorted_vector() {
        let mut list = vec![
            EmbedCapability::supported(EmbedCapabilityId::DeterministicFixture, EvidenceTier::E1),
            EmbedCapability::supported(EmbedCapabilityId::State, EvidenceTier::E2),
            EmbedCapability::supported(EmbedCapabilityId::Trace, EvidenceTier::E1),
        ];
        sort_capabilities(&mut list);
        validate_capability_list(&list).expect("now sorted");
        assert_eq!(list[0].capability_id, EmbedCapabilityId::State);
        assert_eq!(list[1].capability_id, EmbedCapabilityId::Trace);
        assert_eq!(
            list[2].capability_id,
            EmbedCapabilityId::DeterministicFixture
        );
    }
}
