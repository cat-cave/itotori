use serde::{Deserialize, Serialize};

use kaifuu_core::{
    HelperRedactionStatus, KaifuuResult, KeyMaterialKind, KeyValidationProof, OperationStatus,
    ProofHash, SecretRef, redact_for_log_or_report, stable_json,
};

use super::{
    KNOWN_KEY_SMOKE_CAPABILITY_ID, KNOWN_KEY_SMOKE_SUPPORT_BOUNDARY,
    model::{SiglusKnownKeyCompression, SiglusKnownKeyEncoding, SiglusKnownKeyProfile},
};

/// The narrow known-key smoke capability descriptor. Records the mechanical
/// facts: in-process, no shell-out, redacted, and — crucially —
/// `broad_siglus_support = false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusKnownKeyCapability {
    /// Capability id.
    pub capability_id: String,
    /// Engine family (`siglus`).
    pub engine_family: String,
    /// Always `false`: this crate never shells out.
    pub shells_out: bool,
    /// Always `false`: honest scope — this is a narrow known-key smoke, NOT
    /// broad Siglus Scene.pck/Gameexe.dat coverage.
    pub broad_siglus_support: bool,
    /// The in-profile encoding.
    pub encoding: SiglusKnownKeyEncoding,
    /// The in-profile compression.
    pub in_profile_compression: SiglusKnownKeyCompression,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// The blunt support boundary.
    pub support_boundary: String,
}

impl SiglusKnownKeyCapability {
    pub(super) fn narrow(profile: &SiglusKnownKeyProfile) -> Self {
        Self {
            capability_id: KNOWN_KEY_SMOKE_CAPABILITY_ID.to_string(),
            engine_family: "siglus".to_string(),
            shells_out: false,
            broad_siglus_support: false,
            encoding: profile.encoding,
            in_profile_compression: profile.compression,
            redaction_status: HelperRedactionStatus::Redacted,
            support_boundary: KNOWN_KEY_SMOKE_SUPPORT_BOUNDARY.to_string(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            capability_id: redact_for_log_or_report(&self.capability_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            shells_out: self.shells_out,
            broad_siglus_support: self.broad_siglus_support,
            encoding: self.encoding,
            in_profile_compression: self.in_profile_compression,
            redaction_status: self.redaction_status,
            support_boundary: redact_for_log_or_report(&self.support_boundary),
        }
    }
}

/// Per-scene-unit metadata carried in the report: structural key + byte length +
/// a one-way sha256 commitment to the text — NEVER the text itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneUnitDigest {
    /// Canonical source-unit key.
    pub source_unit_key: String,
    /// UTF-16LE byte length of the decoded text.
    pub text_byte_len: u32,
    /// sha256 commitment to the decoded text (never the text).
    pub text_hash: ProofHash,
}

/// The scene extraction section of the report (counts + digests, no text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneExtractionReport {
    /// `SceneList` scene id.
    pub scene_id: u32,
    /// Number of extracted units.
    pub unit_count: u32,
    /// Per-unit digests.
    pub units: Vec<SceneUnitDigest>,
}

/// A `Gameexe` entry digest: structural key + value byte length + value hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeEntryDigest {
    /// Configuration key (structural).
    pub key: String,
    /// UTF-16LE byte length of the value.
    pub value_byte_len: u32,
    /// sha256 commitment to the value (never the value text).
    pub value_hash: ProofHash,
}

/// The gameexe extraction section of the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeExtractionReport {
    /// Number of extracted entries.
    pub entry_count: u32,
    /// Per-entry digests.
    pub entries: Vec<GameexeEntryDigest>,
}

/// The trivial-patch round-trip section of the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRoundTripReport {
    /// The patched target unit key.
    pub target_source_unit_key: String,
    /// sha256 commitment to the translated text (never the text).
    pub translated_text_hash: ProofHash,
    /// Whether the round-trip fully verified.
    pub verified: bool,
    /// Whether every non-target unit was preserved.
    pub other_units_preserved: bool,
    /// The round-trip proof (method + hash over the re-emitted container).
    pub proof: KeyValidationProof,
}

/// The out-of-profile section: proves out-of-scope cases are typed
/// not-implemented, not silent passes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutOfProfileReport {
    /// The out-of-profile compression that was attempted.
    pub attempted_compression: String,
    /// Always `true`: the attempt was refused with a typed error.
    pub typed_not_implemented: bool,
    /// The stable diagnostic code the refusal carried.
    pub diagnostic_code: String,
}

/// The full known-key smoke report. Redact before serialization via
/// [`SiglusKnownKeySmokeReport::stable_json`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusKnownKeySmokeReport {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// The spec-DAG node id this smoke is authored for.
    pub source_node_id: String,
    /// Engine family.
    pub engine_family: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// The declared profile id.
    pub profile_id: String,
    /// The structured secret-ref the known key is published under.
    pub secret_ref: SecretRef,
    /// One-way sha256 commitment to the known-key bytes (never the key).
    pub key_material_hash: ProofHash,
    /// Known-key byte length.
    pub key_bytes: u32,
    /// Key material kind.
    pub key_material_kind: KeyMaterialKind,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// The narrow capability descriptor.
    pub capability: SiglusKnownKeyCapability,
    /// Scene extraction section.
    pub scene: SceneExtractionReport,
    /// Gameexe extraction section.
    pub gameexe: GameexeExtractionReport,
    /// Trivial patch round-trip section.
    pub patch: PatchRoundTripReport,
    /// Out-of-profile handling section.
    pub out_of_profile: OutOfProfileReport,
    /// Overall status.
    pub status: OperationStatus,
}

impl SiglusKnownKeySmokeReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            profile_id: redact_for_log_or_report(&self.profile_id),
            secret_ref: self.secret_ref.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            capability: self.capability.redacted_for_report(),
            scene: self.scene.clone(),
            gameexe: self.gameexe.clone(),
            patch: self.patch.clone(),
            out_of_profile: self.out_of_profile.clone(),
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no text).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

/// The known-key smoke fixture manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusKnownKeySmokeFixture {
    /// Schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// The spec-DAG node id (e.g. ``).
    pub source_node_id: String,
    /// Engine family.
    pub engine_family: String,
    /// The narrow known-key profile.
    pub profile: SiglusKnownKeyProfile,
    /// The trivial translated patch to apply + verify.
    pub patch: SiglusKnownKeyPatchSpec,
}

/// The trivial translated change a smoke applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusKnownKeyPatchSpec {
    /// The target unit key (`siglus:scene-NNNN#OOOO`).
    pub target_source_unit_key: String,
    /// The replacement (translated) text.
    pub translated_text: String,
}
