//! Synthetic Wolf encrypted-archive fixture and report model.

use serde::{Deserialize, Serialize};
use std::fmt;

use super::run::proof_hash;
use crate::wolf_protection_detector::{WOLF_ENGINE_FAMILY, WolfProtectionProfile};
use crate::{
    CodecTransform, HelperRedactionStatus, KaifuuResult, KeyMaterialKind, KeyValidationProof,
    OperationStatus, ProofHash, SecretRef, SecretRefScheme, SurfaceTransform,
    redact_for_log_or_report,
    secret_holder::{SecretRefSecretResolver, ZeroizingSecretBytes},
    stable_json,
};

/// Stable marker prefix for typed display errors from this module.
pub const WOLF_ENCRYPTED_SMOKE_MARKER: &str = "kaifuu.wolf.encrypted_smoke";
/// Fixture/report schema version.
pub const WOLF_ENCRYPTED_SMOKE_SCHEMA_VERSION: &str = "0.1.0";
/// Capability id surfaced by the smoke.
pub const WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID: &str = "kaifuu-wolf-encrypted-archive-smoke";
/// Synthetic container family label.
pub const WOLF_ENCRYPTED_SMOKE_CONTAINER: &str = "wolf-like-encrypted-archive";
/// Stable secret requirement id for the synthetic archive key.
/// The value is deliberately redaction-SAFE: it must survive
/// [`redact_for_log_or_report`] unchanged so it can appear in reports and in the
/// helper-result diagnostic messages (which are validated to be
/// redaction-clean). A digit-bearing token like `...-k073-...` reads as
/// base64url key material to the raw-key heuristic and would be redacted,
/// silently degrading the evidence — so the node reference is spelled out.
pub const WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID: &str = "kaifuu-wolf-encrypted-archive-key";
/// Valid local secret ref. The ref is reportable; the raw bytes are not.
pub const WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF: &str =
    "local-secret:kaifuu-wolf-archive-fixture-key";
/// Missing ref used by tests/failure callers.
pub const WOLF_ENCRYPTED_SMOKE_MISSING_SECRET_REF: &str =
    "local-secret:kaifuu-wolf-archive-absent-key";
/// Blunt support boundary included in every report.
pub const WOLF_ENCRYPTED_SMOKE_SUPPORT_BOUNDARY: &str = "Kaifuu Wolf encrypted-archive smoke is a bounded SYNTHETIC fixture only: a Wolf-like archive container with encrypted member payloads, a fixture-only XOR crypto profile, key material resolved by local SecretRef, decrypt+extract of text-bearing members, one trivial text replacement, re-encrypt/repack, and re-decrypt verification. It is not commercial Wolf/DXArchive coverage and emits no raw keys, decrypted text, local paths, or retail bytes.";

pub(super) const SYNTHETIC_ARCHIVE_MAGIC: &[u8; 16] = b"KFWOLFSMOKE073\0\0";
pub(super) const SYNTHETIC_FIXTURE_KEY: &[u8; 17] = b"K073-WOLF-FIXTURE";
pub(super) const FIXTURE_MEMBERS: &[(&str, &str)] = &[
    (
        "Data/Scenario/intro.txt",
        "synthetic-wolf-line=before\nvoice=fixture\n",
    ),
    ("Data/System/config.txt", "window=synthetic\nlocale=en\n"),
];
pub(super) const PATCH_MEMBER_ID: &str = "Data/Scenario/intro.txt";
pub(super) const PATCH_FIND: &str = "synthetic-wolf-line=before";
pub(super) const PATCH_REPLACE: &str = "synthetic-wolf-line=after";

/// Declared fixture crypto profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum WolfEncryptedCryptoProfile {
    /// Fixture-only keyed XOR, its own inverse. Not a real Wolf/DXArchive
    /// cipher.
    XorFixture,
}

impl WolfEncryptedCryptoProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::XorFixture => "xor-fixture",
        }
    }
}

/// Where the synthetic encrypted archive bytes come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum WolfEncryptedArchiveSource {
    /// Build the synthetic encrypted archive in-process.
    SyntheticStub,
    /// Optional scoped local evidence. Path is relative to the fixture file.
    LocalFile { path: String },
}

/// Synthetic fixture profile. It carries the key ref, never raw key bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfEncryptedSmokeFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub container: String,
    pub protection_profile: WolfProtectionProfile,
    pub crypto_profile: WolfEncryptedCryptoProfile,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub secret_requirement_id: String,
    pub secret_ref: SecretRef,
    pub archive_source: WolfEncryptedArchiveSource,
    pub expected_member_ids: Vec<String>,
}

impl WolfEncryptedSmokeFixture {
    pub fn synthetic() -> Self {
        Self {
            schema_version: WOLF_ENCRYPTED_SMOKE_SCHEMA_VERSION.to_string(),
            fixture_id: "wolf-encrypted-archive-smoke-synthetic".to_string(),
            source_node_id: "synthetic-fixture".to_string(),
            engine_family: WOLF_ENGINE_FAMILY.to_string(),
            container: WOLF_ENCRYPTED_SMOKE_CONTAINER.to_string(),
            protection_profile: WolfProtectionProfile::Protected,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            codec: CodecTransform::Utf8Text,
            surface: SurfaceTransform::ArchiveEntry,
            secret_requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
            secret_ref: SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF)
                .expect("static synthetic secret ref is valid"),
            archive_source: WolfEncryptedArchiveSource::SyntheticStub,
            expected_member_ids: FIXTURE_MEMBERS
                .iter()
                .map(|(member_id, _)| (*member_id).to_string())
                .collect(),
        }
    }
}

/// Resolved archive key. Raw material lives in the shared non-`Clone`,
/// zeroizing, `Debug`-redacting secret-holder primitive.
/// # Secret boundary
/// There is no Wolf-specific raw-key constructor. Every consumer obtains a key
/// by resolving a [`SecretRef`] through [`WolfEncryptedFixtureSecretResolver`],
/// which hands the key back BY REF and never copies raw bytes out.
pub(crate) type WolfEncryptedArchiveKey = ZeroizingSecretBytes;

pub(crate) trait WolfEncryptedArchiveKeyExt {
    /// sha256 over the raw key material — a one-way proof hash, never the bytes.
    fn material_hash(&self) -> Result<ProofHash, WolfEncryptedSmokeError>;

    fn apply_filter(&self, data: &[u8]) -> Vec<u8>;
}

impl WolfEncryptedArchiveKeyExt for WolfEncryptedArchiveKey {
    fn material_hash(&self) -> Result<ProofHash, WolfEncryptedSmokeError> {
        ProofHash::new(self.sha256_material_hash())
            .map_err(|message| WolfEncryptedSmokeError::Internal { message })
    }

    fn apply_filter(&self, data: &[u8]) -> Vec<u8> {
        self.apply_xor_filter(data, None, false, 0x73)
    }
}

/// Fixture resolver: maps the reportable secret ref to fixture-safe key
/// material. The raw key bytes are never stored bare: each entry holds the
/// material inside a zeroize-on-drop [`WolfEncryptedArchiveKey`], and
/// [`WolfEncryptedFixtureSecretResolver::resolve`] hands the key back BY REF so
/// no raw key is ever copied out, re-stored, or emitted. `Debug` is safe because
/// the key holder redacts its bytes. Deliberately not `Clone`: the resolved key
/// must not be duplicated past this boundary.
#[derive(Debug)]
pub struct WolfEncryptedFixtureSecretResolver {
    entries: SecretRefSecretResolver,
}

impl WolfEncryptedFixtureSecretResolver {
    pub fn fixture_default() -> Self {
        Self::from_entries(vec![(
            WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF.to_string(),
            SYNTHETIC_FIXTURE_KEY.to_vec(),
        )])
    }

    /// Build a resolver from `(secret_ref, raw_bytes)` entries. This
    /// module-private fixture entry consumes synthetic raw key bytes and
    /// immediately mints them into the shared zeroize-on-drop holder.
    pub(super) fn from_entries(entries: Vec<(String, Vec<u8>)>) -> Self {
        Self {
            entries: SecretRefSecretResolver::from_entries(entries),
        }
    }

    /// Build a resolver by binding declared secret refs to existing key
    /// holders. No raw key material leaves a holder; the shared resolver mints
    /// fresh zeroize-on-drop holders internally.
    pub(crate) fn from_key_refs(entries: Vec<(String, &WolfEncryptedArchiveKey)>) -> Self {
        Self {
            entries: SecretRefSecretResolver::from_secret_refs(entries),
        }
    }

    fn into_key(self, secret_ref: &SecretRef) -> Option<WolfEncryptedArchiveKey> {
        self.entries.into_resolved(secret_ref)
    }

    /// Resolve `secret_ref` to fixture-safe key material BY REF, or a typed
    /// missing-secret error citing the requirement id. Never returns or copies
    /// the raw key bytes: the borrow keeps the material inside the resolver's
    /// zeroize-on-drop holder.
    pub(crate) fn resolve(
        &self,
        requirement_id: &str,
        secret_ref: &SecretRef,
    ) -> Result<&WolfEncryptedArchiveKey, WolfEncryptedSmokeError> {
        self.entries
            .resolve(secret_ref)
            .ok_or_else(|| WolfEncryptedSmokeError::MissingSecret {
                requirement_id: requirement_id.to_string(),
                secret_ref_scheme: secret_ref.scheme(),
            })
    }

    /// True iff any held raw key appears verbatim in `haystack`. Backs the
    /// runtime no-leak guard so callers never need direct access to the key
    /// bytes.
    pub(crate) fn any_key_appears_in(&self, haystack: &[u8]) -> bool {
        self.entries.any_key_appears_in(haystack)
    }
}

pub(super) fn wolf_key_from_secret_ref_entry(
    secret_ref: &SecretRef,
    bytes: Vec<u8>,
) -> WolfEncryptedArchiveKey {
    WolfEncryptedFixtureSecretResolver::from_entries(vec![(secret_ref.as_str().to_string(), bytes)])
        .into_key(secret_ref)
        .expect("newly inserted Wolf key must resolve by its SecretRef")
}

/// Fatal errors for the smoke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WolfEncryptedSmokeError {
    MissingSecret {
        requirement_id: String,
        secret_ref_scheme: SecretRefScheme,
    },
    ContainerRead {
        detail: String,
    },
    ContainerFormat {
        detail: String,
    },
    IntegrityCheckFailed {
        member_id: String,
    },
    TextPatchFailed {
        member_id: String,
    },
    ExpectationMismatch {
        detail: String,
    },
    Internal {
        message: String,
    },
}

impl fmt::Display for WolfEncryptedSmokeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingSecret {
                requirement_id,
                secret_ref_scheme,
            } => write!(
                formatter,
                "{WOLF_ENCRYPTED_SMOKE_MARKER}.missing_secret: no key material for requirement {requirement_id} (secret-ref scheme {secret_ref_scheme})"
            ),
            Self::ContainerRead { detail } => write!(
                formatter,
                "{WOLF_ENCRYPTED_SMOKE_MARKER}.container_read: {}",
                redact_for_log_or_report(detail)
            ),
            Self::ContainerFormat { detail } => write!(
                formatter,
                "{WOLF_ENCRYPTED_SMOKE_MARKER}.container_format: {}",
                redact_for_log_or_report(detail)
            ),
            Self::IntegrityCheckFailed { member_id } => write!(
                formatter,
                "{WOLF_ENCRYPTED_SMOKE_MARKER}.integrity_check_failed: member {} failed plaintext hash verification after decrypt",
                redact_for_log_or_report(member_id)
            ),
            Self::TextPatchFailed { member_id } => write!(
                formatter,
                "{WOLF_ENCRYPTED_SMOKE_MARKER}.text_patch_failed: member {} did not contain the trivial fixture text",
                redact_for_log_or_report(member_id)
            ),
            Self::ExpectationMismatch { detail } => write!(
                formatter,
                "{WOLF_ENCRYPTED_SMOKE_MARKER}.expectation_mismatch: {}",
                redact_for_log_or_report(detail)
            ),
            Self::Internal { message } => write!(
                formatter,
                "{WOLF_ENCRYPTED_SMOKE_MARKER}.internal: {}",
                redact_for_log_or_report(message)
            ),
        }
    }
}

impl std::error::Error for WolfEncryptedSmokeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WolfArchiveMember {
    pub(super) member_id: String,
    pub(super) plaintext_hash: ProofHash,
    pub(super) payload: Vec<u8>,
}

/// A decrypted archive member: a member id and its raw plaintext payload
/// (arbitrary bytes — text, a binary text-table for the
/// adapter). Shared `pub(crate)` so the Wolf adapter drives the SAME
/// container+crypto layer rather than reimplementing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WolfPlainMember {
    pub(crate) member_id: String,
    pub(crate) plaintext: Vec<u8>,
}

/// One hash-based extracted member report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfEncryptedMemberDigest {
    pub member_id: String,
    pub plaintext_byte_len: u64,
    pub plaintext_hash: ProofHash,
}

impl WolfEncryptedMemberDigest {
    pub(super) fn from_plain(member: &WolfPlainMember) -> Result<Self, WolfEncryptedSmokeError> {
        Ok(Self {
            member_id: member.member_id.clone(),
            plaintext_byte_len: member.plaintext.len() as u64,
            plaintext_hash: proof_hash(&member.plaintext)?,
        })
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            member_id: redact_for_log_or_report(&self.member_id),
            plaintext_byte_len: self.plaintext_byte_len,
            plaintext_hash: self.plaintext_hash.clone(),
        }
    }
}

/// Ordered smoke stages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WolfEncryptedSmokeStage {
    Decrypt,
    Extract,
    Patch,
    Repack,
    Verify,
}

impl WolfEncryptedSmokeStage {
    pub fn ordered() -> [Self; 5] {
        [
            Self::Decrypt,
            Self::Extract,
            Self::Patch,
            Self::Repack,
            Self::Verify,
        ]
    }
}

/// One stage result in the ordered ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfEncryptedSmokeStageOutcome {
    pub stage: WolfEncryptedSmokeStage,
    pub status: OperationStatus,
    pub detail: String,
}

/// Patch/verify proof. It intentionally carries hashes/counts, not text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfEncryptedPatchProof {
    pub patched_member_id: String,
    pub source_plaintext_hash: ProofHash,
    pub patched_plaintext_hash: ProofHash,
    pub source_byte_len: u64,
    pub patched_byte_len: u64,
    pub patched_text_verified: bool,
    pub unchanged_members_verified: u32,
}

impl WolfEncryptedPatchProof {
    fn redacted_for_report(&self) -> Self {
        Self {
            patched_member_id: redact_for_log_or_report(&self.patched_member_id),
            source_plaintext_hash: self.source_plaintext_hash.clone(),
            patched_plaintext_hash: self.patched_plaintext_hash.clone(),
            source_byte_len: self.source_byte_len,
            patched_byte_len: self.patched_byte_len,
            patched_text_verified: self.patched_text_verified,
            unchanged_members_verified: self.unchanged_members_verified,
        }
    }
}

/// Full smoke report. Serialize through [`WolfEncryptedSmokeReport::stable_json`]
/// for redaction/no-leak discipline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfEncryptedSmokeReport {
    pub schema_version: String,
    pub capability_id: String,
    pub source_node_id: String,
    pub support_boundary: String,
    pub fixture_id: String,
    pub engine_family: String,
    pub container: String,
    pub protection_profile: WolfProtectionProfile,
    pub crypto_profile: WolfEncryptedCryptoProfile,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub secret_requirement_id: String,
    pub secret_ref: SecretRef,
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    pub key_material_kind: KeyMaterialKind,
    pub redaction_status: HelperRedactionStatus,
    pub source_archive_hash: ProofHash,
    pub rebuilt_archive_hash: ProofHash,
    pub stages: Vec<WolfEncryptedSmokeStageOutcome>,
    pub extract_manifest: Vec<WolfEncryptedMemberDigest>,
    pub patch_proof: WolfEncryptedPatchProof,
    pub verify_proof: KeyValidationProof,
    pub delta_package_id: String,
    pub status: OperationStatus,
}

impl WolfEncryptedSmokeReport {
    fn redacted_for_report(&self) -> Self {
        // Mirror (`Xp3CryptReport::redacted_for_report`): every
        // free-text id/label string is scrubbed through
        // `redact_for_log_or_report` at the serialization boundary. Hashes,
        // counts, enums, the reportable `secret_ref`, and the schema version pass
        // through unchanged; the raw key never enters this struct at all.
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            container: redact_for_log_or_report(&self.container),
            protection_profile: self.protection_profile,
            crypto_profile: self.crypto_profile,
            codec: self.codec,
            surface: self.surface,
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            source_archive_hash: self.source_archive_hash.clone(),
            rebuilt_archive_hash: self.rebuilt_archive_hash.clone(),
            stages: self
                .stages
                .iter()
                .map(|stage| WolfEncryptedSmokeStageOutcome {
                    stage: stage.stage,
                    status: stage.status.clone(),
                    detail: redact_for_log_or_report(&stage.detail),
                })
                .collect(),
            extract_manifest: self
                .extract_manifest
                .iter()
                .map(WolfEncryptedMemberDigest::redacted_for_report)
                .collect(),
            patch_proof: self.patch_proof.redacted_for_report(),
            verify_proof: self.verify_proof.clone(),
            delta_package_id: redact_for_log_or_report(&self.delta_package_id),
            status: self.status.clone(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}
