//! KAIFUU-073 - bounded Wolf encrypted-archive decrypt -> extract -> patch ->
//! verify smoke.
//!
//! This module proves one narrow, synthetic Wolf-like encrypted archive path:
//! a deterministic fixture container is built in-process, its text-bearing
//! member payloads are encrypted with a fixture-only XOR profile, the key is
//! resolved by [`SecretRef`], the archive is decrypted/extracted, one trivial
//! replacement is applied, the archive is re-encrypted/repacked, and the rebuilt
//! container is decrypted again to verify the patched text is present.
//!
//! Honest scope: this is NOT commercial Wolf/DXArchive coverage and NOT a real
//! Wolf cipher. It is a bounded synthetic smoke for the Kaifuu secret-ref and
//! decrypt/extract/patch/verify contract. Fixture/report data carry only ids,
//! refs, byte counts, and one-way hashes. Raw key bytes live only inside
//! [`WolfEncryptedArchiveKey`], whose `Debug` is redacted and whose buffer is
//! zeroized on drop.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::wolf_protection_detector::{WOLF_ENGINE_FAMILY, WolfProtectionProfile};
use crate::{
    CodecTransform, HelperRedactionStatus, KaifuuResult, KeyMaterialKind, KeyValidationMethod,
    KeyValidationProof, OperationStatus, ProofHash, SecretRef, SecretRefScheme, SurfaceTransform,
    deterministic_id, read_json, redact_for_log_or_report, sha256_hash_bytes, stable_json,
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
pub const WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID: &str = "kaifuu-k073-wolf-archive-key";
/// Valid local secret ref. The ref is reportable; the raw bytes are not.
pub const WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF: &str =
    "local-secret:kaifuu-wolf-archive-fixture-key";
/// Missing ref used by tests/failure callers.
pub const WOLF_ENCRYPTED_SMOKE_MISSING_SECRET_REF: &str =
    "local-secret:kaifuu-wolf-archive-absent-key";
/// Blunt support boundary included in every report.
pub const WOLF_ENCRYPTED_SMOKE_SUPPORT_BOUNDARY: &str = "Kaifuu Wolf encrypted-archive smoke is a bounded SYNTHETIC fixture only: a Wolf-like archive container with encrypted member payloads, a fixture-only XOR crypto profile, key material resolved by local SecretRef, decrypt+extract of text-bearing members, one trivial text replacement, re-encrypt/repack, and re-decrypt verification. It is not commercial Wolf/DXArchive coverage and emits no raw keys, decrypted text, local paths, or retail bytes.";

const SYNTHETIC_ARCHIVE_MAGIC: &[u8; 16] = b"KFWOLFSMOKE073\0\0";
const SYNTHETIC_FIXTURE_KEY: &[u8; 17] = b"K073-WOLF-FIXTURE";
const FIXTURE_MEMBERS: &[(&str, &str)] = &[
    (
        "Data/Scenario/intro.txt",
        "synthetic-wolf-line=before\nvoice=fixture\n",
    ),
    ("Data/System/config.txt", "window=synthetic\nlocale=en\n"),
];
const PATCH_MEMBER_ID: &str = "Data/Scenario/intro.txt";
const PATCH_FIND: &str = "synthetic-wolf-line=before";
const PATCH_REPLACE: &str = "synthetic-wolf-line=after";

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
            source_node_id: "KAIFUU-073".to_string(),
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

/// Resolved archive key. Raw bytes are private, redacted in `Debug`, and
/// zeroized on drop.
pub(crate) struct WolfEncryptedArchiveKey {
    bytes: Vec<u8>,
}

impl WolfEncryptedArchiveKey {
    fn from_resolved_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    /// Resolved key length in bytes. Reportable (a count, never the bytes).
    pub(crate) fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    /// sha256 over the raw key material — a one-way proof hash, never the bytes.
    pub(crate) fn material_hash(&self) -> Result<ProofHash, WolfEncryptedSmokeError> {
        proof_hash(&self.bytes)
    }

    fn apply_filter(&self, data: &[u8]) -> Vec<u8> {
        if self.bytes.is_empty() {
            return data.to_vec();
        }
        data.iter()
            .enumerate()
            .map(|(index, byte)| byte ^ self.bytes[index % self.bytes.len()] ^ 0x73)
            .collect()
    }

    pub(crate) fn appears_in(&self, haystack: &[u8]) -> bool {
        !self.bytes.is_empty()
            && self.bytes.len() <= haystack.len()
            && haystack
                .windows(self.bytes.len())
                .any(|window| window == self.bytes)
    }
}

impl Drop for WolfEncryptedArchiveKey {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

impl fmt::Debug for WolfEncryptedArchiveKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WolfEncryptedArchiveKey")
            .field("bytes", &"[REDACTED:kaifuu.secret_redacted]")
            .field("byte_len", &self.bytes.len())
            .finish()
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
    entries: Vec<(String, WolfEncryptedArchiveKey)>,
}

impl WolfEncryptedFixtureSecretResolver {
    pub fn fixture_default() -> Self {
        Self {
            entries: vec![(
                WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF.to_string(),
                WolfEncryptedArchiveKey::from_resolved_bytes(SYNTHETIC_FIXTURE_KEY.to_vec()),
            )],
        }
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
            .iter()
            .find(|(candidate, _)| candidate == secret_ref.as_str())
            .map(|(_, key)| key)
            .ok_or_else(|| WolfEncryptedSmokeError::MissingSecret {
                requirement_id: requirement_id.to_string(),
                secret_ref_scheme: secret_ref.scheme(),
            })
    }
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
struct WolfArchiveMember {
    member_id: String,
    plaintext_hash: ProofHash,
    payload: Vec<u8>,
}

/// A decrypted archive member: a member id and its raw plaintext payload
/// (arbitrary bytes — text for KAIFUU-073, a binary text-table for the
/// KAIFUU-012 adapter). Shared `pub(crate)` so the Wolf adapter drives the SAME
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
    fn from_plain(member: &WolfPlainMember) -> Result<Self, WolfEncryptedSmokeError> {
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
        // Mirror KAIFUU-072 (`Xp3CryptReport::redacted_for_report`): every
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

/// Build the synthetic encrypted Wolf-like archive.
pub fn build_synthetic_wolf_encrypted_archive() -> Vec<u8> {
    let key = WolfEncryptedArchiveKey::from_resolved_bytes(SYNTHETIC_FIXTURE_KEY.to_vec());
    let members = FIXTURE_MEMBERS
        .iter()
        .map(|(member_id, text)| WolfPlainMember {
            member_id: (*member_id).to_string(),
            plaintext: text.as_bytes().to_vec(),
        })
        .collect::<Vec<_>>();
    pack_encrypted_archive(&members, &key).expect("synthetic Wolf-like archive encodes")
}

/// Run the bounded decrypt -> extract -> patch -> verify smoke from fixture
/// data.
pub fn run_wolf_encrypted_smoke_from_fixture(
    fixture: &WolfEncryptedSmokeFixture,
    fixture_dir: &Path,
) -> Result<WolfEncryptedSmokeReport, WolfEncryptedSmokeError> {
    validate_fixture(fixture)?;
    let source_archive = resolve_archive_bytes(&fixture.archive_source, fixture_dir)?;
    let source_archive_hash = proof_hash(&source_archive)?;

    let resolver = WolfEncryptedFixtureSecretResolver::fixture_default();
    let key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;
    let key_material_hash = key.material_hash()?;
    let key_bytes = u32::try_from(key.byte_len()).unwrap_or(u32::MAX);

    let extracted = decrypt_archive_members(&source_archive, key)?;
    let extracted_ids: Vec<&str> = extracted
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    if extracted_ids != fixture.expected_member_ids {
        return Err(WolfEncryptedSmokeError::ExpectationMismatch {
            detail: "extracted member set did not match declared expected_member_ids".to_string(),
        });
    }
    let extract_manifest = extracted
        .iter()
        .map(WolfEncryptedMemberDigest::from_plain)
        .collect::<Result<Vec<_>, _>>()?;

    let patched = apply_trivial_patch(&extracted)?;
    let rebuilt_archive = pack_encrypted_archive(&patched, key)?;
    let rebuilt_archive_hash = proof_hash(&rebuilt_archive)?;
    let verified = decrypt_archive_members(&rebuilt_archive, key)?;
    let patch_proof = verify_patch(&extracted, &verified)?;
    let verify_proof = build_verify_proof(&verified)?;

    let report = WolfEncryptedSmokeReport {
        schema_version: WOLF_ENCRYPTED_SMOKE_SCHEMA_VERSION.to_string(),
        capability_id: WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID.to_string(),
        source_node_id: fixture.source_node_id.clone(),
        support_boundary: WOLF_ENCRYPTED_SMOKE_SUPPORT_BOUNDARY.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        engine_family: fixture.engine_family.clone(),
        container: fixture.container.clone(),
        protection_profile: fixture.protection_profile,
        crypto_profile: fixture.crypto_profile,
        codec: fixture.codec,
        surface: fixture.surface,
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        key_material_hash,
        key_bytes,
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        source_archive_hash,
        rebuilt_archive_hash,
        stages: build_stage_ledger(extract_manifest.len(), &patch_proof),
        extract_manifest,
        patch_proof,
        verify_proof,
        delta_package_id: deterministic_id("kaifuu-wolf-encrypted-delta", 73),
        status: OperationStatus::Passed,
    };

    let json = report
        .stable_json()
        .map_err(|error| WolfEncryptedSmokeError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) {
        return Err(WolfEncryptedSmokeError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Read a fixture JSON and run the smoke against its directory.
pub fn run_wolf_encrypted_smoke_from_path(
    fixture_path: &Path,
) -> Result<WolfEncryptedSmokeReport, WolfEncryptedSmokeError> {
    let fixture: WolfEncryptedSmokeFixture =
        read_json(fixture_path).map_err(|error| WolfEncryptedSmokeError::Internal {
            message: error.to_string(),
        })?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or_else(|| WolfEncryptedSmokeError::Internal {
            message: "fixture path must have a parent directory".to_string(),
        })?;
    run_wolf_encrypted_smoke_from_fixture(&fixture, fixture_dir)
}

fn validate_fixture(fixture: &WolfEncryptedSmokeFixture) -> Result<(), WolfEncryptedSmokeError> {
    if fixture.engine_family != WOLF_ENGINE_FAMILY {
        return Err(WolfEncryptedSmokeError::ExpectationMismatch {
            detail: format!(
                "engine_family {} is not {WOLF_ENGINE_FAMILY}",
                fixture.engine_family
            ),
        });
    }
    if fixture.container != WOLF_ENCRYPTED_SMOKE_CONTAINER {
        return Err(WolfEncryptedSmokeError::ExpectationMismatch {
            detail: format!(
                "container {} is not {WOLF_ENCRYPTED_SMOKE_CONTAINER}",
                fixture.container
            ),
        });
    }
    if fixture.protection_profile != WolfProtectionProfile::Protected {
        return Err(WolfEncryptedSmokeError::ExpectationMismatch {
            detail: "Wolf encrypted smoke requires a protected keyRef-bound profile".to_string(),
        });
    }
    if fixture.secret_ref.scheme() != SecretRefScheme::LocalSecret {
        return Err(WolfEncryptedSmokeError::ExpectationMismatch {
            detail: "Wolf encrypted smoke resolves only local-secret refs".to_string(),
        });
    }
    Ok(())
}

fn resolve_archive_bytes(
    source: &WolfEncryptedArchiveSource,
    fixture_dir: &Path,
) -> Result<Vec<u8>, WolfEncryptedSmokeError> {
    match source {
        WolfEncryptedArchiveSource::SyntheticStub => Ok(build_synthetic_wolf_encrypted_archive()),
        WolfEncryptedArchiveSource::LocalFile { path } => std::fs::read(fixture_dir.join(path))
            .map_err(|error| WolfEncryptedSmokeError::ContainerRead {
                // The OS error string embeds the joined local path. Redact at the
                // boundary so the detail is scrubbed even before it reaches
                // `Display`, never carrying a local path into any diagnostic.
                detail: redact_for_log_or_report(&format!("read local Wolf archive: {error}")),
            }),
    }
}

pub(crate) fn pack_encrypted_archive(
    members: &[WolfPlainMember],
    key: &WolfEncryptedArchiveKey,
) -> Result<Vec<u8>, WolfEncryptedSmokeError> {
    let mut out = Vec::new();
    out.extend_from_slice(SYNTHETIC_ARCHIVE_MAGIC);
    write_u32(&mut out, members.len())?;
    for member in members {
        let member_id = member.member_id.as_bytes();
        let ciphertext = key.apply_filter(&member.plaintext);
        write_u32(&mut out, member_id.len())?;
        write_u64(&mut out, member.plaintext.len())?;
        write_u64(&mut out, ciphertext.len())?;
        out.extend_from_slice(proof_hash(&member.plaintext)?.as_str().as_bytes());
        out.extend_from_slice(member_id);
        out.extend_from_slice(&ciphertext);
    }
    Ok(out)
}

fn read_encrypted_archive(bytes: &[u8]) -> Result<Vec<WolfArchiveMember>, WolfEncryptedSmokeError> {
    let mut cursor = ByteCursor::new(bytes);
    let magic = cursor.take(SYNTHETIC_ARCHIVE_MAGIC.len())?;
    if magic != SYNTHETIC_ARCHIVE_MAGIC {
        return Err(WolfEncryptedSmokeError::ContainerFormat {
            detail: "synthetic Wolf-like archive magic did not match".to_string(),
        });
    }
    let member_count = cursor.read_u32()? as usize;
    let mut members = Vec::with_capacity(member_count);
    for _ in 0..member_count {
        let member_id_len = cursor.read_u32()? as usize;
        let _plaintext_len = cursor.read_u64()? as usize;
        let ciphertext_len = cursor.read_u64()? as usize;
        let plaintext_hash_bytes = cursor.take(71)?;
        let plaintext_hash = std::str::from_utf8(plaintext_hash_bytes).map_err(|_| {
            WolfEncryptedSmokeError::ContainerFormat {
                detail: "plaintext proof hash was not UTF-8".to_string(),
            }
        })?;
        let plaintext_hash = ProofHash::new(plaintext_hash.to_string())
            .map_err(|message| WolfEncryptedSmokeError::ContainerFormat { detail: message })?;
        let member_id_bytes = cursor.take(member_id_len)?;
        let member_id = std::str::from_utf8(member_id_bytes)
            .map_err(|_| WolfEncryptedSmokeError::ContainerFormat {
                detail: "member id was not UTF-8".to_string(),
            })?
            .to_string();
        let payload = cursor.take(ciphertext_len)?.to_vec();
        members.push(WolfArchiveMember {
            member_id,
            plaintext_hash,
            payload,
        });
    }
    if !cursor.is_finished() {
        return Err(WolfEncryptedSmokeError::ContainerFormat {
            detail: "synthetic Wolf-like archive had trailing bytes".to_string(),
        });
    }
    Ok(members)
}

pub(crate) fn decrypt_archive_members(
    archive: &[u8],
    key: &WolfEncryptedArchiveKey,
) -> Result<Vec<WolfPlainMember>, WolfEncryptedSmokeError> {
    read_encrypted_archive(archive)?
        .into_iter()
        .map(|member| {
            let plaintext = key.apply_filter(&member.payload);
            if proof_hash(&plaintext)?.as_str() != member.plaintext_hash.as_str() {
                return Err(WolfEncryptedSmokeError::IntegrityCheckFailed {
                    member_id: member.member_id,
                });
            }
            Ok(WolfPlainMember {
                member_id: member.member_id,
                plaintext,
            })
        })
        .collect()
}

fn apply_trivial_patch(
    source: &[WolfPlainMember],
) -> Result<Vec<WolfPlainMember>, WolfEncryptedSmokeError> {
    source
        .iter()
        .map(|member| {
            if member.member_id != PATCH_MEMBER_ID {
                return Ok(member.clone());
            }
            let text = std::str::from_utf8(&member.plaintext).map_err(|_| {
                WolfEncryptedSmokeError::TextPatchFailed {
                    member_id: member.member_id.clone(),
                }
            })?;
            if !text.contains(PATCH_FIND) {
                return Err(WolfEncryptedSmokeError::TextPatchFailed {
                    member_id: member.member_id.clone(),
                });
            }
            Ok(WolfPlainMember {
                member_id: member.member_id.clone(),
                plaintext: text.replacen(PATCH_FIND, PATCH_REPLACE, 1).into_bytes(),
            })
        })
        .collect()
}

fn verify_patch(
    source: &[WolfPlainMember],
    verified: &[WolfPlainMember],
) -> Result<WolfEncryptedPatchProof, WolfEncryptedSmokeError> {
    let source_patch = source
        .iter()
        .find(|member| member.member_id == PATCH_MEMBER_ID)
        .ok_or_else(|| WolfEncryptedSmokeError::ExpectationMismatch {
            detail: "source patch member missing".to_string(),
        })?;
    let verified_patch = verified
        .iter()
        .find(|member| member.member_id == PATCH_MEMBER_ID)
        .ok_or_else(|| WolfEncryptedSmokeError::ExpectationMismatch {
            detail: "verified patch member missing".to_string(),
        })?;
    let verified_text = std::str::from_utf8(&verified_patch.plaintext).map_err(|_| {
        WolfEncryptedSmokeError::ExpectationMismatch {
            detail: "verified patch member was not UTF-8".to_string(),
        }
    })?;
    let patched_text_verified =
        verified_text.contains(PATCH_REPLACE) && !verified_text.contains(PATCH_FIND);
    if !patched_text_verified {
        return Err(WolfEncryptedSmokeError::ExpectationMismatch {
            detail: "rebuilt archive did not verify the trivial patched text".to_string(),
        });
    }

    let mut unchanged_members_verified = 0u32;
    for source_member in source {
        if source_member.member_id == PATCH_MEMBER_ID {
            continue;
        }
        let verified_member = verified
            .iter()
            .find(|member| member.member_id == source_member.member_id)
            .ok_or_else(|| WolfEncryptedSmokeError::ExpectationMismatch {
                detail: "verified member set dropped an unchanged member".to_string(),
            })?;
        if verified_member.plaintext != source_member.plaintext {
            return Err(WolfEncryptedSmokeError::ExpectationMismatch {
                detail: "unchanged member was not byte-identical after rebuild".to_string(),
            });
        }
        unchanged_members_verified += 1;
    }

    Ok(WolfEncryptedPatchProof {
        patched_member_id: PATCH_MEMBER_ID.to_string(),
        source_plaintext_hash: proof_hash(&source_patch.plaintext)?,
        patched_plaintext_hash: proof_hash(&verified_patch.plaintext)?,
        source_byte_len: source_patch.plaintext.len() as u64,
        patched_byte_len: verified_patch.plaintext.len() as u64,
        patched_text_verified,
        unchanged_members_verified,
    })
}

fn build_verify_proof(
    verified: &[WolfPlainMember],
) -> Result<KeyValidationProof, WolfEncryptedSmokeError> {
    let mut proof_material = Vec::new();
    for member in verified {
        proof_material.extend_from_slice(member.member_id.as_bytes());
        proof_material.extend_from_slice(proof_hash(&member.plaintext)?.as_str().as_bytes());
    }
    Ok(KeyValidationProof {
        method: KeyValidationMethod::FixtureRoundTripProof,
        proof_hash: proof_hash(&proof_material)?,
    })
}

fn build_stage_ledger(
    member_count: usize,
    patch_proof: &WolfEncryptedPatchProof,
) -> Vec<WolfEncryptedSmokeStageOutcome> {
    let passed = |stage: WolfEncryptedSmokeStage, detail: String| WolfEncryptedSmokeStageOutcome {
        stage,
        status: OperationStatus::Passed,
        detail,
    };
    vec![
        passed(
            WolfEncryptedSmokeStage::Decrypt,
            "archive decrypted using local SecretRef fixture key".to_string(),
        ),
        passed(
            WolfEncryptedSmokeStage::Extract,
            format!("{member_count} text-bearing member(s) extracted"),
        ),
        passed(
            WolfEncryptedSmokeStage::Patch,
            "one trivial text replacement applied".to_string(),
        ),
        passed(
            WolfEncryptedSmokeStage::Repack,
            "archive re-encrypted and repacked with the same key ref".to_string(),
        ),
        passed(
            WolfEncryptedSmokeStage::Verify,
            format!(
                "patched text verified; {} unchanged member(s) byte-identical",
                patch_proof.unchanged_members_verified
            ),
        ),
    ]
}

fn write_u32(out: &mut Vec<u8>, value: usize) -> Result<(), WolfEncryptedSmokeError> {
    let value = u32::try_from(value).map_err(|_| WolfEncryptedSmokeError::Internal {
        message: "synthetic archive u32 field overflow".to_string(),
    })?;
    out.extend_from_slice(&value.to_le_bytes());
    Ok(())
}

fn write_u64(out: &mut Vec<u8>, value: usize) -> Result<(), WolfEncryptedSmokeError> {
    let value = u64::try_from(value).map_err(|_| WolfEncryptedSmokeError::Internal {
        message: "synthetic archive u64 field overflow".to_string(),
    })?;
    out.extend_from_slice(&value.to_le_bytes());
    Ok(())
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, WolfEncryptedSmokeError> {
    ProofHash::new(sha256_hash_bytes(bytes))
        .map_err(|message| WolfEncryptedSmokeError::Internal { message })
}

struct ByteCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ByteCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], WolfEncryptedSmokeError> {
        let end = self.offset.checked_add(len).ok_or_else(|| {
            WolfEncryptedSmokeError::ContainerFormat {
                detail: "synthetic archive cursor overflowed".to_string(),
            }
        })?;
        if end > self.bytes.len() {
            return Err(WolfEncryptedSmokeError::ContainerFormat {
                detail: "synthetic archive ended early".to_string(),
            });
        }
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn read_u32(&mut self) -> Result<u32, WolfEncryptedSmokeError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .expect("take(4) returns four bytes");
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_u64(&mut self) -> Result<u64, WolfEncryptedSmokeError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .expect("take(8) returns eight bytes");
        Ok(u64::from_le_bytes(bytes))
    }

    fn is_finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> WolfEncryptedSmokeFixture {
        WolfEncryptedSmokeFixture::synthetic()
    }

    #[test]
    fn synthetic_archive_is_encrypted_not_plaintext() {
        let archive = build_synthetic_wolf_encrypted_archive();
        for (_, text) in FIXTURE_MEMBERS {
            assert!(
                !archive
                    .windows(text.len())
                    .any(|window| window == text.as_bytes()),
                "synthetic plaintext leaked into encrypted archive"
            );
        }
    }

    #[test]
    fn full_smoke_decrypts_extracts_patches_reencrypts_and_verifies() {
        let report = run_wolf_encrypted_smoke_from_fixture(&fixture(), Path::new("."))
            .expect("Wolf encrypted smoke runs");
        assert_eq!(report.status, OperationStatus::Passed);
        let stages: Vec<WolfEncryptedSmokeStage> =
            report.stages.iter().map(|stage| stage.stage).collect();
        assert_eq!(stages, WolfEncryptedSmokeStage::ordered().to_vec());
        assert_eq!(report.extract_manifest.len(), FIXTURE_MEMBERS.len());
        assert!(report.patch_proof.patched_text_verified);
        assert_eq!(report.patch_proof.unchanged_members_verified, 1);
        assert_ne!(
            report.source_archive_hash.as_str(),
            report.rebuilt_archive_hash.as_str()
        );
        assert_eq!(
            report.secret_ref.as_str(),
            WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF
        );
        assert_eq!(report.key_bytes, SYNTHETIC_FIXTURE_KEY.len() as u32);
    }

    #[test]
    fn rebuilt_archive_decrypts_to_the_patched_text() {
        let resolver = WolfEncryptedFixtureSecretResolver::fixture_default();
        let key = resolver
            .resolve(
                WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID,
                &SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF).unwrap(),
            )
            .expect("fixture key resolves");
        let source = build_synthetic_wolf_encrypted_archive();
        let extracted = decrypt_archive_members(&source, key).expect("source decrypts");
        let patched = apply_trivial_patch(&extracted).expect("patch applies");
        let rebuilt = pack_encrypted_archive(&patched, key).expect("repack succeeds");
        let verified = decrypt_archive_members(&rebuilt, key).expect("rebuilt decrypts");
        let patched_member = verified
            .iter()
            .find(|member| member.member_id == PATCH_MEMBER_ID)
            .expect("patched member exists");
        let patched_text = std::str::from_utf8(&patched_member.plaintext).unwrap();
        assert!(patched_text.contains(PATCH_REPLACE));
        assert!(!patched_text.contains(PATCH_FIND));
    }

    #[test]
    fn missing_secret_ref_is_typed_and_ref_only() {
        let mut fixture = fixture();
        fixture.secret_ref = SecretRef::new(WOLF_ENCRYPTED_SMOKE_MISSING_SECRET_REF).unwrap();
        let err = run_wolf_encrypted_smoke_from_fixture(&fixture, Path::new("."))
            .expect_err("missing key must fail");
        assert!(matches!(err, WolfEncryptedSmokeError::MissingSecret { .. }));
        assert!(err.to_string().starts_with(WOLF_ENCRYPTED_SMOKE_MARKER));
        assert!(!err.to_string().contains("K073-WOLF-FIXTURE"));
    }

    #[test]
    fn report_is_redaction_clean_and_no_raw_key_or_plaintext_leaks() {
        let report =
            run_wolf_encrypted_smoke_from_fixture(&fixture(), Path::new(".")).expect("smoke runs");
        let json = report.stable_json().expect("stable json");
        assert!(json.contains(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF));
        assert!(!json.contains("K073-WOLF-FIXTURE"));
        assert!(!json.contains(PATCH_FIND));
        assert!(!json.contains(PATCH_REPLACE));
        for (_, text) in FIXTURE_MEMBERS {
            assert!(!json.contains(text));
        }
        assert!(!json.contains("/scratch/"));
        assert!(!json.contains("/home/"));
    }

    #[test]
    fn key_debug_is_redacted() {
        let key = WolfEncryptedArchiveKey::from_resolved_bytes(SYNTHETIC_FIXTURE_KEY.to_vec());
        let debug = format!("{key:?}");
        assert!(debug.contains("[REDACTED:kaifuu.secret_redacted]"));
        assert!(!debug.contains("K073-WOLF-FIXTURE"));
    }

    #[test]
    fn resolver_holds_key_ref_only_and_never_emits_raw_bytes() {
        // The resolver now stores the key material inside a zeroize-on-drop
        // holder, so even its own `Debug` must not leak the raw bytes.
        let resolver = WolfEncryptedFixtureSecretResolver::fixture_default();
        let debug = format!("{resolver:?}");
        assert!(debug.contains("[REDACTED:kaifuu.secret_redacted]"));
        assert!(!debug.contains("K073-WOLF-FIXTURE"));

        // Resolution returns a borrow of the held key; the raw bytes are never
        // copied out or serialized. The no-leak guard proves the material does
        // not appear in the emitted report.
        let key = resolver
            .resolve(
                WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID,
                &SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF).unwrap(),
            )
            .expect("fixture key resolves");
        let report =
            run_wolf_encrypted_smoke_from_fixture(&fixture(), Path::new(".")).expect("smoke runs");
        let json = report.stable_json().expect("stable json");
        assert!(!key.appears_in(json.as_bytes()));
        assert!(!json.contains("K073-WOLF-FIXTURE"));
    }
}
