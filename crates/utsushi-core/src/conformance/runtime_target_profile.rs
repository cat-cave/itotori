//! Runtime target profile read model ().
//!
//! A DATA-ONLY read model that BINDS an Utsushi alpha runtime-validation
//! target to the MEANINGFUL candidate metadata it must run against, so a
//! runtime proof run targets a real work/edition — NOT an arbitrary
//! fixture. It links four existing identity surfaces into one profile:
//!
//! - **Catalog work identity** — the carved work id
//!   (`apps/itotori` work-scope `CarvedWork.workId`
//!   `WorkScope.workId`, and the catalog `catalog-work` stable id in
//!   `packages/itotori-db`) plus its optional catalog **edition** id (the
//!   specific distribution — platform / shipped languages / edition —
//!   `docs/itotori-vault-source-adapter.md`). The edition id is recorded
//!   "when known"; a profile that names only the work is still meaningful.
//! - **Local-corpus source revision** — the `sourceRevision` the runtime
//!   linkage envelope stamps (`sourceRevision.revisionId`), the revision
//!   of the local corpus the target was extracted from.
//! - **Bridge-unit fixture revision** — the revision of the bridge-unit
//!   bundle the runtime target consumes (the Kaifuu bridge fixture
//!   revision), distinct from the raw source revision.
//! - **Runtime target + proof manifest** — the
//!   `runtimeTargetId` the launched runtime observation stamps, and the
//!   alpha proof manifest id (`proofId`) that attests the target's
//!   runtime observation, at a declared **readiness level** (the four-tier
//!   `docs/project-readiness.md` model).
//!
//! This module NEVER launches a runtime host, plays back a browser
//! captures a screenshot, or reads game bytes. It only records and
//! validates identity bindings that other nodes already produced. Its
//! only dependency is `serde`.
//!
//! Validation has two layers:
//!
//! 1. **Well-formed** ([`RuntimeTargetProfile::validate`]) — every
//!    required binding is present and every id is well-shaped (non-empty
//!    bounded, no whitespace, not a local path). The optional edition id
//!    when present, is held to the same shape.
//! 2. **Resolves against referenced metadata**
//!    ([`resolve_runtime_target_profile`]) — the profile's ids name REAL
//!    members of a supplied [`RuntimeTargetMetadata`] catalog (known work
//!    ids, edition ids, source revisions, bridge-unit fixture revisions
//!    runtime target ids, proof manifest ids). A profile that binds an
//!    arbitrary fixture — an id absent from the catalog — is rejected.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::looks_like_local_path;

/// Stable schema id for the serialized profile + fixtures.
pub const RUNTIME_TARGET_PROFILE_SCHEMA_VERSION: &str = "utsushi.runtime_target_profile.v0.1";

/// The alpha runtime-validation readiness level a profile declares.
///
/// The four-tier milestone model (`docs/project-readiness.md`): a
/// candidate target advances from building-blocks-present through the
/// single-game alpha gate to multi-game beta and full release. The
/// readiness level is the tier the profile CLAIMS the bound candidate is
/// ready to be runtime-validated at; the proof manifest is what attests
/// whether it actually met that bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadinessLevel {
    /// Building blocks present, parsing/extraction layer proven — ready to
    /// be pointed at a real game for testing.
    RealGameTestingReady,
    /// The full pipeline fires end-to-end on this single real target.
    Alpha,
    /// The engine family clears on ≥2 real games.
    Beta,
    /// The asymptote — most games in most common engines.
    FullRelease,
}

impl ReadinessLevel {
    /// All readiness levels in ascending order.
    pub const ALL: &'static [ReadinessLevel] = &[
        ReadinessLevel::RealGameTestingReady,
        ReadinessLevel::Alpha,
        ReadinessLevel::Beta,
        ReadinessLevel::FullRelease,
    ];

    /// Stable kebab-case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RealGameTestingReady => "real-game-testing-ready",
            Self::Alpha => "alpha",
            Self::Beta => "beta",
            Self::FullRelease => "full-release",
        }
    }
}

/// One runtime target profile: the meaningful candidate bindings a runtime
/// proof run targets.
///
/// Records exactly the identities the acceptance requires: work id
/// edition id (when known), source revision, bridge-unit fixture revision
/// runtime target id, readiness level, and proof manifest id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTargetProfile {
    /// Schema pin for the serialized profile.
    #[serde(default = "default_schema_version")]
    pub schema_version: String,
    /// Catalog work identity — the narrative work the target realises
    /// (`CarvedWork.workId` / catalog `catalog-work` id). REQUIRED: a
    /// runtime target that binds no work is not a meaningful candidate.
    pub work_id: String,
    /// Catalog edition id — the specific distribution (platform / shipped
    /// languages / edition). Recorded "when known"; `None` is allowed (a
    /// work-only profile is still meaningful), but when present it must
    /// resolve against a known edition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edition_id: Option<String>,
    /// Local-corpus source revision the target was extracted from
    /// (`sourceRevision.revisionId`). REQUIRED.
    pub source_revision: String,
    /// Bridge-unit fixture revision the runtime target consumes. REQUIRED.
    pub bridge_unit_fixture_revision: String,
    /// The `runtimeTargetId` the launched observation
    /// stamps. REQUIRED.
    pub runtime_target_id: String,
    /// Declared readiness level (the four-tier model). REQUIRED.
    pub readiness_level: ReadinessLevel,
    /// The alpha proof manifest id (`proofId`) attesting this target's
    /// runtime observation. REQUIRED.
    pub proof_manifest_id: String,
}

fn default_schema_version() -> String {
    RUNTIME_TARGET_PROFILE_SCHEMA_VERSION.to_string()
}

/// The known catalog/corpus/bridge/proof metadata a profile resolves
/// against. A profile is a MEANINGFUL candidate only when its ids name
/// real members of these sets — never an arbitrary fixture.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTargetMetadata {
    /// Known catalog work ids.
    #[serde(default)]
    pub work_ids: BTreeSet<String>,
    /// Known catalog edition ids.
    #[serde(default)]
    pub edition_ids: BTreeSet<String>,
    /// Known local-corpus source revisions.
    #[serde(default)]
    pub source_revisions: BTreeSet<String>,
    /// Known bridge-unit fixture revisions.
    #[serde(default)]
    pub bridge_unit_fixture_revisions: BTreeSet<String>,
    /// Known runtime target ids.
    #[serde(default)]
    pub runtime_target_ids: BTreeSet<String>,
    /// Known alpha proof manifest ids.
    #[serde(default)]
    pub proof_manifest_ids: BTreeSet<String>,
}

/// Well-formedness error: a required binding is absent or an id is
/// malformed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeTargetProfileError {
    /// A required id was empty / blank.
    MissingField { field: &'static str },
    /// An id was present but malformed (whitespace, over-long, or a local
    /// path leaked in where an opaque id belongs).
    FieldMalformed { field: &'static str, value: String },
}

impl std::fmt::Display for RuntimeTargetProfileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingField { field } => {
                write!(
                    formatter,
                    "required runtime-target binding {field:?} is missing"
                )
            }
            Self::FieldMalformed { field, value } => write!(
                formatter,
                "runtime-target binding {field:?} value {value:?} is malformed"
            ),
        }
    }
}

impl std::error::Error for RuntimeTargetProfileError {}

/// Resolution error: the profile is well-formed but binds metadata that
/// does not exist in the catalog (an arbitrary fixture, not a real
/// candidate).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeTargetResolutionError {
    /// The profile is not well-formed to begin with.
    Malformed(RuntimeTargetProfileError),
    /// The bound work id is not a known catalog work.
    UnknownWork { work_id: String },
    /// The bound edition id is not a known catalog edition.
    UnknownEdition { edition_id: String },
    /// The bound source revision is not a known local-corpus revision.
    UnknownSourceRevision { source_revision: String },
    /// The bound bridge-unit fixture revision is not known.
    UnknownBridgeUnitFixtureRevision { revision: String },
    /// The bound runtime target id is not known.
    UnknownRuntimeTarget { runtime_target_id: String },
    /// The bound proof manifest id is not a known alpha proof.
    UnknownProofManifest { proof_manifest_id: String },
}

impl std::fmt::Display for RuntimeTargetResolutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(error) => write!(formatter, "profile not well-formed: {error}"),
            Self::UnknownWork { work_id } => write!(
                formatter,
                "work id {work_id:?} is not a known catalog work (arbitrary target)"
            ),
            Self::UnknownEdition { edition_id } => write!(
                formatter,
                "edition id {edition_id:?} is not a known catalog edition"
            ),
            Self::UnknownSourceRevision { source_revision } => write!(
                formatter,
                "source revision {source_revision:?} is not a known local-corpus revision"
            ),
            Self::UnknownBridgeUnitFixtureRevision { revision } => write!(
                formatter,
                "bridge-unit fixture revision {revision:?} is not known"
            ),
            Self::UnknownRuntimeTarget { runtime_target_id } => write!(
                formatter,
                "runtime target id {runtime_target_id:?} is not known"
            ),
            Self::UnknownProofManifest { proof_manifest_id } => write!(
                formatter,
                "proof manifest id {proof_manifest_id:?} is not a known alpha proof"
            ),
        }
    }
}

impl std::error::Error for RuntimeTargetResolutionError {}

/// Well-shaped id token: non-empty, bounded, no whitespace, not a local
/// path. Mirrors the branch-coverage read model's `validate_token`.
fn is_well_shaped(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|c| !c.is_whitespace())
        && !looks_like_local_path(value)
}

/// Check one required id: present (non-blank) AND well-shaped.
fn require_field(field: &'static str, value: &str) -> Result<(), RuntimeTargetProfileError> {
    if value.trim().is_empty() {
        return Err(RuntimeTargetProfileError::MissingField { field });
    }
    if !is_well_shaped(value) {
        return Err(RuntimeTargetProfileError::FieldMalformed {
            field,
            value: value.to_string(),
        });
    }
    Ok(())
}

impl RuntimeTargetProfile {
    /// Validate that the profile is WELL-FORMED: every required binding is
    /// present and every id is well-shaped. The optional edition id, when
    /// present, is held to the same shape. This is a shape check only — it
    /// does NOT confirm the ids name real metadata (see
    /// [`resolve_runtime_target_profile`]).
    pub fn validate(&self) -> Result<(), RuntimeTargetProfileError> {
        require_field("workId", &self.work_id)?;
        require_field("sourceRevision", &self.source_revision)?;
        require_field(
            "bridgeUnitFixtureRevision",
            &self.bridge_unit_fixture_revision,
        )?;
        require_field("runtimeTargetId", &self.runtime_target_id)?;
        require_field("proofManifestId", &self.proof_manifest_id)?;
        if let Some(edition_id) = self.edition_id.as_deref() {
            // "when known": an edition id may be absent, but if present it
            // must not be a blank/malformed placeholder.
            require_field("editionId", edition_id)?;
        }
        Ok(())
    }
}

/// Resolve a profile against the referenced metadata: it is a MEANINGFUL
/// candidate iff it is well-formed AND every id names a real member of the
/// catalog. A profile that binds an arbitrary fixture — an id absent from
/// `metadata` — is rejected. The optional edition id is resolved only
/// "when known" (a work-only profile still resolves).
pub fn resolve_runtime_target_profile(
    profile: &RuntimeTargetProfile,
    metadata: &RuntimeTargetMetadata,
) -> Result<(), RuntimeTargetResolutionError> {
    profile
        .validate()
        .map_err(RuntimeTargetResolutionError::Malformed)?;

    if !metadata.work_ids.contains(&profile.work_id) {
        return Err(RuntimeTargetResolutionError::UnknownWork {
            work_id: profile.work_id.clone(),
        });
    }
    if let Some(edition_id) = profile.edition_id.as_deref()
        && !metadata.edition_ids.contains(edition_id)
    {
        return Err(RuntimeTargetResolutionError::UnknownEdition {
            edition_id: edition_id.to_string(),
        });
    }
    if !metadata.source_revisions.contains(&profile.source_revision) {
        return Err(RuntimeTargetResolutionError::UnknownSourceRevision {
            source_revision: profile.source_revision.clone(),
        });
    }
    if !metadata
        .bridge_unit_fixture_revisions
        .contains(&profile.bridge_unit_fixture_revision)
    {
        return Err(
            RuntimeTargetResolutionError::UnknownBridgeUnitFixtureRevision {
                revision: profile.bridge_unit_fixture_revision.clone(),
            },
        );
    }
    if !metadata
        .runtime_target_ids
        .contains(&profile.runtime_target_id)
    {
        return Err(RuntimeTargetResolutionError::UnknownRuntimeTarget {
            runtime_target_id: profile.runtime_target_id.clone(),
        });
    }
    if !metadata
        .proof_manifest_ids
        .contains(&profile.proof_manifest_id)
    {
        return Err(RuntimeTargetResolutionError::UnknownProofManifest {
            proof_manifest_id: profile.proof_manifest_id.clone(),
        });
    }
    Ok(())
}

/// Serializable fixture wrapper: the known metadata catalog plus the
/// candidate profiles that MUST resolve and the profiles that MUST be
/// rejected. Mirrors the branch-coverage / trace-branch fixture
/// convention so reviewers can read the bindings as committed data.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTargetProfileFixture {
    pub metadata: RuntimeTargetMetadata,
    /// Meaningful candidates: well-formed AND resolve against `metadata`.
    #[serde(default)]
    pub candidates: Vec<RuntimeTargetProfile>,
    /// Rejected profiles: each fails validation or resolution (unbound
    /// arbitrary fixture).
    #[serde(default)]
    pub rejected: Vec<RuntimeTargetProfile>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> RuntimeTargetMetadata {
        RuntimeTargetMetadata {
            work_ids: ["fixture-archive#work:2:0".to_string()]
                .into_iter()
                .collect(),
            edition_ids: ["fixture-archive#edition:steam-jp".to_string()]
                .into_iter()
                .collect(),
            source_revisions: ["fixture-source-v0.1".to_string()].into_iter().collect(),
            bridge_unit_fixture_revisions: ["fixture-bridge-rev-v0.1".to_string()]
                .into_iter()
                .collect(),
            runtime_target_ids: ["fixture:mvmz-patched-fixture".to_string()]
                .into_iter()
                .collect(),
            proof_manifest_ids: ["cac432af-03e2-7aa5-955b-bc1d66a3629a".to_string()]
                .into_iter()
                .collect(),
        }
    }

    fn bound_profile() -> RuntimeTargetProfile {
        RuntimeTargetProfile {
            schema_version: RUNTIME_TARGET_PROFILE_SCHEMA_VERSION.to_string(),
            work_id: "fixture-archive#work:2:0".to_string(),
            edition_id: Some("fixture-archive#edition:steam-jp".to_string()),
            source_revision: "fixture-source-v0.1".to_string(),
            bridge_unit_fixture_revision: "fixture-bridge-rev-v0.1".to_string(),
            runtime_target_id: "fixture:mvmz-patched-fixture".to_string(),
            readiness_level: ReadinessLevel::Alpha,
            proof_manifest_id: "cac432af-03e2-7aa5-955b-bc1d66a3629a".to_string(),
        }
    }

    #[test]
    fn well_formed_bound_profile_validates_and_resolves() {
        let profile = bound_profile();
        profile.validate().expect("well-formed");
        resolve_runtime_target_profile(&profile, &metadata()).expect("binds real metadata");
    }

    #[test]
    fn edition_id_is_optional_when_not_known() {
        let mut profile = bound_profile();
        profile.edition_id = None;
        profile.validate().expect("well-formed without edition");
        resolve_runtime_target_profile(&profile, &metadata())
            .expect("work-only profile still resolves");
    }

    #[test]
    fn missing_required_binding_is_rejected_as_not_well_formed() {
        let mut profile = bound_profile();
        profile.proof_manifest_id = String::new();
        assert_eq!(
            profile.validate(),
            Err(RuntimeTargetProfileError::MissingField {
                field: "proofManifestId"
            })
        );
        assert_eq!(
            resolve_runtime_target_profile(&profile, &metadata()),
            Err(RuntimeTargetResolutionError::Malformed(
                RuntimeTargetProfileError::MissingField {
                    field: "proofManifestId"
                }
            ))
        );
    }

    #[test]
    fn local_path_id_is_malformed() {
        let mut profile = bound_profile();
        profile.runtime_target_id = "/home/trevor/scratch/fixture.json".to_string();
        assert!(matches!(
            profile.validate(),
            Err(RuntimeTargetProfileError::FieldMalformed { field, .. }) if field == "runtimeTargetId"
        ));
    }

    #[test]
    fn arbitrary_fixture_target_is_rejected_on_resolution() {
        // Well-formed but binds a runtime target absent from the catalog:
        // an arbitrary fixture, not a meaningful candidate.
        let mut profile = bound_profile();
        profile.runtime_target_id = "fixture:arbitrary-unregistered".to_string();
        profile.validate().expect("still well-formed");
        assert_eq!(
            resolve_runtime_target_profile(&profile, &metadata()),
            Err(RuntimeTargetResolutionError::UnknownRuntimeTarget {
                runtime_target_id: "fixture:arbitrary-unregistered".to_string()
            })
        );
    }

    #[test]
    fn unknown_work_is_rejected() {
        let mut profile = bound_profile();
        profile.work_id = "some-other-archive#work:9:9".to_string();
        assert_eq!(
            resolve_runtime_target_profile(&profile, &metadata()),
            Err(RuntimeTargetResolutionError::UnknownWork {
                work_id: "some-other-archive#work:9:9".to_string()
            })
        );
    }

    #[test]
    fn unknown_edition_when_present_is_rejected() {
        let mut profile = bound_profile();
        profile.edition_id = Some("fixture-archive#edition:unregistered".to_string());
        assert_eq!(
            resolve_runtime_target_profile(&profile, &metadata()),
            Err(RuntimeTargetResolutionError::UnknownEdition {
                edition_id: "fixture-archive#edition:unregistered".to_string()
            })
        );
    }

    #[test]
    fn profile_round_trips_through_json() {
        let profile = bound_profile();
        let bytes = serde_json::to_string(&profile).expect("serialize");
        let restored: RuntimeTargetProfile = serde_json::from_str(&bytes).expect("deserialize");
        assert_eq!(profile, restored);
    }

    #[test]
    fn readiness_level_round_trips_kebab_case() {
        for level in ReadinessLevel::ALL {
            let value = serde_json::to_value(level).expect("serialize");
            assert_eq!(value.as_str().expect("string"), level.as_str());
            let restored: ReadinessLevel = serde_json::from_value(value).expect("deserialize");
            assert_eq!(restored, *level);
        }
        assert_eq!(
            serde_json::to_string(&ReadinessLevel::RealGameTestingReady).expect("serialize"),
            "\"real-game-testing-ready\""
        );
    }

    #[test]
    fn schema_version_defaults_when_absent_from_json() {
        let value = serde_json::json!({
            "workId": "fixture-archive#work:2:0",
            "sourceRevision": "fixture-source-v0.1",
            "bridgeUnitFixtureRevision": "fixture-bridge-rev-v0.1",
            "runtimeTargetId": "fixture:mvmz-patched-fixture",
            "readinessLevel": "alpha",
            "proofManifestId": "cac432af-03e2-7aa5-955b-bc1d66a3629a"
        });
        let profile: RuntimeTargetProfile = serde_json::from_value(value).expect("parse");
        assert_eq!(
            profile.schema_version,
            RUNTIME_TARGET_PROFILE_SCHEMA_VERSION
        );
        assert!(profile.edition_id.is_none());
        resolve_runtime_target_profile(&profile, &metadata()).expect("resolves");
    }
}
