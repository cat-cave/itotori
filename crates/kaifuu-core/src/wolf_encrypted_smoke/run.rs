//! Synthetic archive execution, patching, and verification.

use std::path::Path;

use crate::wolf_protection_detector::{WOLF_ENGINE_FAMILY, WolfProtectionProfile};
use crate::{
    HelperRedactionStatus, KeyMaterialKind, KeyValidationMethod, KeyValidationProof,
    OperationStatus, ProofHash, SecretRef, SecretRefScheme, deterministic_id, read_json,
    redact_for_log_or_report, sha256_hash_bytes,
};

use super::model::*;

pub fn build_synthetic_wolf_encrypted_archive() -> Vec<u8> {
    let secret_ref =
        SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF).expect("fixture ref is valid");
    let key = wolf_key_from_secret_ref_entry(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
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

pub(super) fn apply_trivial_patch(
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

pub(super) fn proof_hash(bytes: &[u8]) -> Result<ProofHash, WolfEncryptedSmokeError> {
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
