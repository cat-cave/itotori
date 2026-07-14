//! Conformance manifest — the adapter-published declaration of which
//! conformance profiles the adapter claims to satisfy.
//!
//! The manifest is the audit surface a runner (or test harness) checks
//! before driving any conformance lifecycle. It is structurally
//! independent of the engine-port [`crate::port::PortManifest`]; the two
//! manifests reference each other by id only and a separate cross-check
//! helper pairs them when both are present (see
//! [`super::cross_validate_conformance_manifest_against_port_manifest`]).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{EvidenceTier, UtsushiResult};

use super::diagnostics::ConformanceError;
use super::{CONFORMANCE_SCHEMA_VERSION, ProfileId};

/// Conformance ABI version. Independent of
/// [`crate::port::PortManifest::abi_version`]: this version bumps when
/// the result schema gains a breaking field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConformanceAbiVersion(pub u32);

/// Substrate subsystem a profile depends on. Used by
/// [`ConformanceManifest::validate`] to reject a manifest that claims a
/// profile but does not wire the substrate the profile rests on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubsystemRequirement {
    /// VFS ().
    AssetAccess,
    /// Input events / replay ().
    Input,
    /// Logical clock ().
    Clock,
    /// ReplayLog finalisation ().
    ReplayLog,
    /// TextSurfaceSink ().
    TextSink,
    /// FrameArtifactSink ().
    FrameSink,
    /// AudioEventSink ().
    AudioSink,
    /// `RuntimeArtifactRoot` artifact-store policy.
    ArtifactStore,
    /// Reserved for snapshot primitives. Inert in this slice.
    SnapshotPrimitives,
}

impl SubsystemRequirement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AssetAccess => "asset_access",
            Self::Input => "input",
            Self::Clock => "clock",
            Self::ReplayLog => "replay_log",
            Self::TextSink => "text_sink",
            Self::FrameSink => "frame_sink",
            Self::AudioSink => "audio_sink",
            Self::ArtifactStore => "artifact_store",
            Self::SnapshotPrimitives => "snapshot_primitives",
        }
    }
}

/// Declared profile commitment. The adapter promises to attempt the
/// profile during the conformance run; producing `Skip` or `Unsupported`
/// for a declared profile is a validation error at result time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceProfile {
    /// Profile identifier (typed enum, not a free-form string).
    pub id: ProfileId,

    /// Subsystems the adapter declares it has wired. Must be a superset
    /// of `ProfileId::required_subsystems`. Extras are accepted and
    /// surfaced to reviewers verbatim.
    pub required_subsystems: Vec<SubsystemRequirement>,

    /// Maximum evidence tier this adapter will ever claim for this
    /// profile. Must satisfy
    /// `evidence_tier_ceiling <= ProfileId::evidence_tier_ceiling`.
    pub evidence_tier_ceiling: EvidenceTier,
}

/// Optional, audit-visible extension a profile may turn on
/// (e.g. per-frame mode flags or branch-discovery selection rules).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileExtension {
    /// Profile this extension augments. Must match an entry in
    /// `supported_profiles`; orphans are rejected.
    pub profile_id: ProfileId,

    /// Stable, namespaced extension key. Lowercased
    /// `[a-z][a-z0-9-]{0,63}`. Examples: `"rgba8"`, `"monotonic-tick"`
    /// `"lossless-recording"`.
    pub key: String,

    /// Audit-visible note explaining what the extension changes. Plain
    /// public string; never a host path.
    pub note: String,
}

/// Adapter-published declaration of which conformance profiles it
/// claims to satisfy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceManifest {
    /// Schema version pin. Validated literally on `from_json_value`.
    pub schema_version: String,

    /// Stable adapter id. Lowercased kebab, matches the port id pattern
    /// `[a-z][a-z0-9-]{7,63}`.
    pub adapter_id: String,

    /// Conformance ABI version. Distinct from
    /// [`crate::port::PortManifest::abi_version`].
    pub abi_version: ConformanceAbiVersion,

    /// Declared profiles. Order is not significant; duplicates rejected.
    pub supported_profiles: Vec<ConformanceProfile>,

    /// Optional extension flags. Each extension references a profile by
    /// id; orphans rejected.
    #[serde(default)]
    pub optional_extensions: Vec<ProfileExtension>,
}

impl ConformanceManifest {
    /// ABI versions this slice supports. Membership is exact, mirroring
    /// the [`crate::port::Runner::SUPPORTED_ABI_VERSIONS`] precedent.
    pub const SUPPORTED_ABI_VERSIONS: &'static [u32] = &[1];

    /// Validate the manifest against its standalone, manifest-internal
    /// rules. Does NOT cross-check against a `PortManifest` or any
    /// `ConformanceResult`; those are separate helpers.
    pub fn validate(&self) -> Result<(), ConformanceError> {
        if self.schema_version != CONFORMANCE_SCHEMA_VERSION {
            return Err(ConformanceError::UnsupportedSchemaVersion {
                observed: self.schema_version.clone(),
                expected: CONFORMANCE_SCHEMA_VERSION,
            });
        }
        if !is_valid_adapter_id(&self.adapter_id) {
            return Err(ConformanceError::AdapterIdMalformed {
                id: self.adapter_id.clone(),
            });
        }
        if !Self::SUPPORTED_ABI_VERSIONS.contains(&self.abi_version.0) {
            return Err(ConformanceError::UnknownAbiVersion {
                declared: self.abi_version.0,
                supported: Self::SUPPORTED_ABI_VERSIONS,
            });
        }
        if self.supported_profiles.is_empty() {
            return Err(ConformanceError::ManifestEmpty);
        }

        let mut seen_ids: HashSet<ProfileId> = HashSet::new();
        for profile in &self.supported_profiles {
            if !seen_ids.insert(profile.id) {
                return Err(ConformanceError::DuplicateProfile { id: profile.id });
            }
            validate_profile(profile)?;
        }

        let mut seen_ext: HashSet<(ProfileId, String)> = HashSet::new();
        for extension in &self.optional_extensions {
            if !is_valid_extension_key(&extension.key) {
                return Err(ConformanceError::ExtensionKeyMalformed {
                    key: extension.key.clone(),
                });
            }
            if !seen_ids.contains(&extension.profile_id) {
                return Err(ConformanceError::OrphanedExtension {
                    key: extension.key.clone(),
                    profile_id: extension.profile_id,
                });
            }
            if !seen_ext.insert((extension.profile_id, extension.key.clone())) {
                return Err(ConformanceError::DuplicateExtension {
                    profile_id: extension.profile_id,
                    key: extension.key.clone(),
                });
            }
        }
        Ok(())
    }

    /// Serialize to a JSON [`serde_json::Value`] after validation.
    pub fn to_json_value(&self) -> UtsushiResult<serde_json::Value> {
        self.validate()?;
        Ok(serde_json::to_value(self)?)
    }

    /// Deserialize from JSON and validate. Returns a structurally
    /// valid manifest by construction.
    pub fn from_json_value(value: serde_json::Value) -> UtsushiResult<Self> {
        let manifest: Self = serde_json::from_value(value)?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Lookup the declared profile by id, if present.
    pub fn profile(&self, id: ProfileId) -> Option<&ConformanceProfile> {
        self.supported_profiles.iter().find(|p| p.id == id)
    }
}

fn validate_profile(profile: &ConformanceProfile) -> Result<(), ConformanceError> {
    let required = profile.id.required_subsystems();

    // Subsystem duplicate check first so the error mode is deterministic.
    let mut seen: HashSet<SubsystemRequirement> = HashSet::new();
    for subsystem in &profile.required_subsystems {
        if !seen.insert(*subsystem) {
            return Err(ConformanceError::DuplicateSubsystem {
                profile: profile.id,
                subsystem: *subsystem,
            });
        }
    }

    for needed in required {
        if !profile.required_subsystems.contains(needed) {
            return Err(ConformanceError::MissingSubsystem {
                profile: profile.id,
                missing: *needed,
            });
        }
    }

    let ceiling = profile.id.evidence_tier_ceiling();
    if profile.evidence_tier_ceiling > ceiling {
        return Err(ConformanceError::EvidenceTierAboveProfileCeiling {
            profile: profile.id,
            claimed: profile.evidence_tier_ceiling,
            ceiling,
        });
    }
    Ok(())
}

pub(super) fn is_valid_adapter_id(id: &str) -> bool {
    if id.len() < 8 || id.len() > 64 {
        return false;
    }
    let bytes = id.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn is_valid_extension_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 64 {
        return false;
    }
    let bytes = key.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conformance::ConformanceAbiVersion;

    pub(crate) fn baseline_text_trace_manifest() -> ConformanceManifest {
        ConformanceManifest {
            schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
            adapter_id: "utsushi-synthetic".to_string(),
            abi_version: ConformanceAbiVersion(1),
            supported_profiles: vec![ConformanceProfile {
                id: ProfileId::TextTrace,
                required_subsystems: vec![SubsystemRequirement::TextSink],
                evidence_tier_ceiling: EvidenceTier::E1,
            }],
            optional_extensions: Vec::new(),
        }
    }

    #[test]
    fn manifest_round_trips_through_serde_json() {
        let manifest = baseline_text_trace_manifest();
        let value = manifest.to_json_value().expect("validates and serializes");
        let restored = ConformanceManifest::from_json_value(value).expect("restores");
        assert_eq!(manifest, restored);
    }

    #[test]
    fn manifest_to_json_value_uses_camel_case_keys() {
        let manifest = baseline_text_trace_manifest();
        let value = manifest.to_json_value().expect("validates and serializes");
        let object = value.as_object().expect("manifest is a JSON object");
        for key in [
            "schemaVersion",
            "adapterId",
            "abiVersion",
            "supportedProfiles",
        ] {
            assert!(
                object.contains_key(key),
                "manifest JSON is missing camelCase key {key}"
            );
        }
        for snake in ["schema_version", "adapter_id", "abi_version"] {
            assert!(
                !object.contains_key(snake),
                "manifest JSON leaked snake_case key {snake}"
            );
        }
        let profile = object
            .get("supportedProfiles")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_object())
            .expect("supportedProfiles[0] object");
        assert!(profile.contains_key("requiredSubsystems"));
        assert!(profile.contains_key("evidenceTierCeiling"));
    }

    #[test]
    fn manifest_validate_accepts_well_formed_text_trace_manifest() {
        baseline_text_trace_manifest()
            .validate()
            .expect("baseline manifest validates");
    }

    #[test]
    fn manifest_validate_accepts_manifest_with_optional_extension() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.optional_extensions.push(ProfileExtension {
            profile_id: ProfileId::TextTrace,
            key: "monotonic-tick".to_string(),
            note: "tick ordering pinned to LogicalClock monotonic stream".to_string(),
        });
        manifest.validate().expect("extension manifest validates");
    }

    #[test]
    fn manifest_validate_rejects_mismatched_schema_version() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.schema_version = "0.0.0".to_string();
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::UnsupportedSchemaVersion { .. })
        ));
    }

    #[test]
    fn manifest_validate_rejects_adapter_id_with_uppercase() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.adapter_id = "Utsushi-Bad".to_string();
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::AdapterIdMalformed { .. })
        ));
    }

    #[test]
    fn manifest_validate_rejects_unknown_abi_version() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.abi_version = ConformanceAbiVersion(99);
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::UnknownAbiVersion { .. })
        ));
    }

    #[test]
    fn manifest_validate_rejects_empty_profile_list() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.supported_profiles.clear();
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::ManifestEmpty)
        ));
    }

    #[test]
    fn manifest_validate_rejects_duplicate_profile_id() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.supported_profiles.push(ConformanceProfile {
            id: ProfileId::TextTrace,
            required_subsystems: vec![SubsystemRequirement::TextSink],
            evidence_tier_ceiling: EvidenceTier::E1,
        });
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::DuplicateProfile { .. })
        ));
    }

    #[test]
    fn manifest_validate_rejects_profile_missing_required_subsystem() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.supported_profiles[0].required_subsystems.clear();
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::MissingSubsystem {
                missing: SubsystemRequirement::TextSink,
                ..
            })
        ));
    }

    #[test]
    fn manifest_validate_rejects_profile_with_duplicate_subsystem() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.supported_profiles[0]
            .required_subsystems
            .push(SubsystemRequirement::TextSink);
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::DuplicateSubsystem { .. })
        ));
    }

    #[test]
    fn manifest_validate_rejects_profile_evidence_tier_above_profile_ceiling() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.supported_profiles[0].evidence_tier_ceiling = EvidenceTier::E3;
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::EvidenceTierAboveProfileCeiling { .. })
        ));
    }

    #[test]
    fn manifest_validate_rejects_extension_with_unknown_profile_id() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.optional_extensions.push(ProfileExtension {
            profile_id: ProfileId::FrameCapture,
            key: "rgba8".to_string(),
            note: "color depth pin".to_string(),
        });
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::OrphanedExtension { .. })
        ));
    }

    #[test]
    fn manifest_validate_rejects_duplicate_extension_key_per_profile() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.optional_extensions.push(ProfileExtension {
            profile_id: ProfileId::TextTrace,
            key: "monotonic-tick".to_string(),
            note: "first".to_string(),
        });
        manifest.optional_extensions.push(ProfileExtension {
            profile_id: ProfileId::TextTrace,
            key: "monotonic-tick".to_string(),
            note: "duplicate".to_string(),
        });
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::DuplicateExtension { .. })
        ));
    }

    #[test]
    fn manifest_validate_rejects_extension_key_with_uppercase() {
        let mut manifest = baseline_text_trace_manifest();
        manifest.optional_extensions.push(ProfileExtension {
            profile_id: ProfileId::TextTrace,
            key: "Bad-Key".to_string(),
            note: "rejected".to_string(),
        });
        assert!(matches!(
            manifest.validate(),
            Err(ConformanceError::ExtensionKeyMalformed { .. })
        ));
    }
}
