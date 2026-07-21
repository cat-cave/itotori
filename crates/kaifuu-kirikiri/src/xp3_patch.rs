//! profiled XP3 **patch-back** round-trip on the crypt
//! fixture.
//! # What this is (and is not)
//! This module proves the **patch-back** capability for a profiled encrypted
//! KiriKiri XP3 archive end-to-end, on the same **synthetic, fixture-safe**
//! archive the [`crate::xp3_crypt`] decrypt smoke owns
//! 1. it resolves the decrypt key through the fixture's declared **secret ref**
//!    (a requirement id resolved to fixture-safe key material — never a raw key)
//!    and decrypts + integrity-verifies every member (the path)
//! 2. it proves the **identity** round-trip: rebuild(extract(x)) with **no**
//!    change is **byte-identical** to the source encrypted container;
//! 3. it applies one **trivial text replacement** (a length-changing localization
//!    described by a [`Xp3PatchManifest`]) to exactly one member, re-enciphers
//!    every member with the same key, recomputes each member's `adlr` adler-32
//!    over the **new** plaintext, and repacks the archive through the shared
//!    encoder (patch-back mode = **`repack_archive`**);
//! 4. it **verifies the patch output against the declared fixture profile + the
//!    declared secret requirement id**: the rebuilt container is re-opened and
//!    decrypted through the *declared* secret ref, every member passes the
//!    integrity check against its recomputed `adlr`, the patched member carries
//!    the **new** text and not the old, and **every other member is
//!    byte-identical** to the source plaintext.
//!    The capability output records the **patch-back mode**
//!    ([`kaifuu_core::PatchBackTransform::RepackArchive`]), the **crypto profile**
//!    ([`Xp3CryptoProfile`]), the surface, and **coverage** (members total /
//!    patched / byte-preserved, replacements applied).
//! ## Honest scope
//! Everything the crypt boundary says still holds: the container is a
//! genuine plain-XP3 archive, only member **file data** is enciphered, the
//! integrity oracle is KiriKiri's real `adlr` adler-32, and the crypt filter is
//! a declared **fixture** XOR analogue — NOT a real per-title CxDec/TVP filter.
//! Patch-back here is *repack the whole archive*: the localized member changes
//! length, so member sizes and the XP3 index offsets are recomputed by the
//! deterministic shared encoder (proved by the non-zero length delta plus the
//! byte-identical identity round-trip). No retail bytes, no real key material:
//! the members are clearly-synthetic authored text and the key is a fixture
//! constant that never leaves [`crate::xp3_crypt`].

use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::{
    HelperRedactionStatus, KaifuuResult, KeyValidationMethod, KeyValidationProof, OperationStatus,
    PatchBackTransform, ProofHash, SecretRef, redact_for_log_or_report, sha256_hash_bytes,
    stable_json,
};
use std::path::Path;

use crate::xp3_crypt::{
    FixtureSecretResolver, KirikiriXp3Surface, Xp3CryptError, Xp3CryptFixture,
    Xp3CryptMemberDigest, Xp3CryptoProfile, decrypt_members, encode_encrypted_xp3,
    member_digest_from_plaintext, resolve_container_bytes,
};

/// Every typed error's `Display` starts here so an audit can pin the module.
pub const XP3_PATCH_MARKER: &str = "kaifuu.kirikiri.xp3_patch";

/// Schema version of the patch manifest + report.
pub const XP3_PATCH_SCHEMA_VERSION: &str = "0.1.0";

/// Canonical capability id surfaced in the report.
pub const XP3_PATCH_CAPABILITY_ID: &str = "kaifuu-kirikiri-xp3-patch-back-smoke";

/// The blunt support boundary carried in every report.
pub const XP3_PATCH_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3 patch-back smoke extends the KAIFUU-100 profiled decrypt fixture: it decrypts a SYNTHETIC encrypted XP3 through the declared fixture secret ref, applies one trivial text replacement to a single member, re-enciphers with the same fixture key, recomputes each member adlr adler-32, and repacks the whole archive (patch-back mode repack_archive). The patched output is re-decrypted through the DECLARED secret requirement id and verified against the declared fixture profile: the patched member carries the new text and every other member is byte-identical. The identity rebuild (no change) is byte-identical to the source. This is NOT commercial encrypted-XP3 coverage and the fixture crypt filter is NOT a real per-title CxDec/TVP filter. No retail bytes and no raw key material leave the module.";

/// One trivial text replacement: within `member_id`, replace the first
/// occurrence of `find` with `replace`. Fixture-safe, public synthetic text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3TextReplacement {
    /// The in-archive member id to patch.
    pub member_id: String,
    /// The exact substring to find (must be present exactly once).
    pub find: String,
    /// The replacement substring (a length change is allowed and expected).
    pub replace: String,
}

/// The trivial replacement manifest a patch-back run applies. Declares its own
/// id + source node so it is queryable from the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3PatchManifest {
    /// Schema version.
    pub schema_version: String,
    /// Stable manifest id.
    pub manifest_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    /// The trivial replacements to apply (this fixture declares exactly one).
    pub replacements: Vec<Xp3TextReplacement>,
}

impl Xp3PatchManifest {
    /// The canonical fixture manifest: one length-changing localization of the
    /// first scenario line.
    #[must_use]
    pub fn fixture_default() -> Self {
        Self {
            schema_version: XP3_PATCH_SCHEMA_VERSION.to_string(),
            manifest_id: "kirikiri-xp3-patch-back-manifest".to_string(),
            source_node_id: "KAIFUU-101".to_string(),
            replacements: vec![Xp3TextReplacement {
                member_id: "scenario/intro.ks".to_string(),
                find: "[synthetic-kirikiri-xp3-crypt-line-0]".to_string(),
                // Deliberately a different length than `find`, so the rebuild
                // must recompute member sizes + index offsets (repack), not a
                // same-length in-place poke.
                replace: "[localized-kirikiri-xp3-patch-back-line-0-JA]".to_string(),
            }],
        }
    }
}

/// Fatal errors raised by the XP3 patch-back path. Every variant's `Display`
/// begins with [`XP3_PATCH_MARKER`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Xp3PatchError {
    /// The underlying crypt/decrypt path failed (missing/wrong key, container
    /// read, integrity). Carried through so failure modes stay typed.
    #[error("{XP3_PATCH_MARKER}.crypt: {0}")]
    Crypt(#[from] Xp3CryptError),
    /// A replacement targeted a member id that is not in the archive.
    #[error(
        "{XP3_PATCH_MARKER}.unknown_member: replacement targets member {member_id} not in the archive"
    )]
    UnknownMember {
        /// The member id that was not found.
        member_id: String,
    },
    /// A replacement's `find` substring was not present exactly once in the
    /// target member. Refused rather than applying a no-op / ambiguous patch.
    #[error(
        "{XP3_PATCH_MARKER}.replacement_not_applicable: `find` for member {member_id} occurred {occurrences} times (want exactly 1)"
    )]
    ReplacementNotApplicable {
        /// The member id the replacement targeted.
        member_id: String,
        /// How many times `find` occurred.
        occurrences: usize,
    },
    /// The identity rebuild (no change) was not byte-identical to the source —
    /// the encode path is not byte-preserving, so patch-back cannot be trusted.
    #[error(
        "{XP3_PATCH_MARKER}.identity_not_byte_preserving: rebuild(extract(x)) with no change diverged from the source"
    )]
    IdentityNotBytePreserving,
    /// The verification of the patched output against the declared profile /
    /// secret requirement id failed.
    #[error("{XP3_PATCH_MARKER}.verification_failed: {detail}")]
    VerificationFailed {
        /// What did not verify.
        detail: String,
    },
    /// An internal proof/serialization failure (redacted).
    #[error("{XP3_PATCH_MARKER}.internal: {message}")]
    Internal {
        /// Redacted internal detail.
        message: String,
    },
}

/// Patch-back coverage counters: how much of the archive the round-trip
/// touched vs. preserved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PatchCoverage {
    /// Members in the archive.
    pub total_members: u32,
    /// Members the manifest changed.
    pub members_patched: u32,
    /// Members that stayed byte-identical (plaintext) across the rebuild.
    pub members_byte_preserved: u32,
    /// Trivial replacements successfully applied.
    pub replacements_applied: u32,
}

/// The patch-back capability output: the declared patch-back mode, crypto
/// profile, surface, and coverage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PatchCapability {
    /// The declared patch-back mode this round-trip exercised.
    pub patch_back_mode: PatchBackTransform,
    /// The declared crypt filter / cipher.
    pub crypto_profile: Xp3CryptoProfile,
    /// The declared extracted-content surface.
    pub surface: KirikiriXp3Surface,
    /// Coverage counters.
    pub coverage: Xp3PatchCoverage,
}

/// The identity round-trip proof: rebuild(extract(x)) with no change == x.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PatchIdentityReport {
    /// The rebuilt encrypted container was byte-identical to the source.
    pub byte_identical: bool,
    /// sha-256 of the source encrypted container.
    pub source_hash: ProofHash,
    /// sha-256 of the identity-rebuilt encrypted container.
    pub rebuilt_hash: ProofHash,
    /// Source container byte length.
    pub source_bytes: u64,
    /// Rebuilt container byte length.
    pub rebuilt_bytes: u64,
}

/// The trivial-change proof: the localized text is present, the old text is
/// gone, and every other member's plaintext stayed byte-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PatchChangeReport {
    /// The patched member id.
    pub member_id: String,
    /// The old text was present in the source member plaintext.
    pub old_present_in_source: bool,
    /// The new text is present in the rebuilt (re-decrypted) member plaintext.
    pub new_present_in_rebuilt: bool,
    /// The old text is absent from the rebuilt (re-decrypted) member plaintext.
    pub old_absent_in_rebuilt: bool,
    /// Byte-length delta of the patched member's plaintext (non-zero → the
    /// encoder recomputed sizes / offsets, i.e. a real repack).
    pub length_delta: i64,
    /// Every member other than the patched one is byte-identical (plaintext)
    /// across the rebuild.
    pub other_members_byte_identical: bool,
}

/// The verification of the patched output against the declared profile + secret
/// requirement id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PatchVerification {
    /// The declared engine/container/crypto/surface matched the fixture profile.
    pub profile_matched: bool,
    /// The secret requirement id the rebuilt output was re-decrypted through.
    pub secret_requirement_id: String,
    /// The rebuilt output decrypted + integrity-verified through the declared
    /// secret ref (the requirement id resolved and every `adlr` matched).
    pub secret_requirement_verified: bool,
    /// The patched decrypt/extract manifest (hash-based; no raw plaintext).
    pub patched_manifest: Vec<Xp3CryptMemberDigest>,
    /// A hash over the patched manifest member commitments (proves the rebuild
    /// produced this exact patched manifest).
    pub verification_proof: KeyValidationProof,
}

/// The full XP3 patch-back smoke report. Redact before serialization via
/// [`Xp3PatchReport::stable_json`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PatchReport {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// Fixture id (from the declared fixture profile).
    pub fixture_id: String,
    /// The trivial replacement manifest id.
    pub manifest_id: String,
    /// Engine family (`kirikiri`).
    pub engine_family: String,
    /// Container (`xp3`).
    pub container: String,
    /// The secret requirement id (never raw key material).
    pub secret_requirement_id: String,
    /// The structured secret ref the decrypt key was resolved through.
    pub secret_ref: SecretRef,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// The patch-back capability output (patch-back mode / crypto profile /
    /// surface / coverage).
    pub capability: Xp3PatchCapability,
    /// The identity round-trip proof.
    pub identity: Xp3PatchIdentityReport,
    /// The trivial-change proof.
    pub patch: Xp3PatchChangeReport,
    /// The verification against the declared profile + secret requirement id.
    pub verification: Xp3PatchVerification,
    /// Overall status.
    pub status: OperationStatus,
}

impl Xp3PatchReport {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            manifest_id: redact_for_log_or_report(&self.manifest_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            container: redact_for_log_or_report(&self.container),
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            redaction_status: self.redaction_status,
            capability: self.capability,
            identity: self.identity.clone(),
            patch: Xp3PatchChangeReport {
                member_id: redact_for_log_or_report(&self.patch.member_id),
                old_present_in_source: self.patch.old_present_in_source,
                new_present_in_rebuilt: self.patch.new_present_in_rebuilt,
                old_absent_in_rebuilt: self.patch.old_absent_in_rebuilt,
                length_delta: self.patch.length_delta,
                other_members_byte_identical: self.patch.other_members_byte_identical,
            },
            verification: Xp3PatchVerification {
                profile_matched: self.verification.profile_matched,
                secret_requirement_id: redact_for_log_or_report(
                    &self.verification.secret_requirement_id,
                ),
                secret_requirement_verified: self.verification.secret_requirement_verified,
                patched_manifest: self
                    .verification
                    .patched_manifest
                    .iter()
                    .map(redacted_member_digest)
                    .collect(),
                verification_proof: self.verification.verification_proof.clone(),
            },
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no plaintext).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    /// True when the round-trip passed.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }
}

fn redacted_member_digest(digest: &Xp3CryptMemberDigest) -> Xp3CryptMemberDigest {
    Xp3CryptMemberDigest {
        member_id: redact_for_log_or_report(&digest.member_id),
        plaintext_byte_len: digest.plaintext_byte_len,
        plaintext_hash: digest.plaintext_hash.clone(),
        adler32: redact_for_log_or_report(&digest.adler32),
    }
}

/// One decrypted member as `(member id, plaintext bytes)`.
type MemberPlaintext = (String, Vec<u8>);

/// Apply the manifest's replacements to the decrypted member plaintexts,
/// returning the patched plaintexts and the count of members changed. Each
/// replacement's `find` must occur exactly once in its target member.
pub(crate) fn apply_replacements(
    members: &[MemberPlaintext],
    manifest: &Xp3PatchManifest,
) -> Result<(Vec<MemberPlaintext>, Vec<String>), Xp3PatchError> {
    let mut patched: Vec<MemberPlaintext> = members.to_vec();
    let mut changed_ids: Vec<String> = Vec::new();
    for replacement in &manifest.replacements {
        let entry = patched
            .iter_mut()
            .find(|(id, _)| id == &replacement.member_id)
            .ok_or_else(|| Xp3PatchError::UnknownMember {
                member_id: replacement.member_id.clone(),
            })?;
        let text = String::from_utf8(entry.1.clone()).map_err(|_| Xp3PatchError::Internal {
            message: "fixture member was not valid utf-8".to_string(),
        })?;
        let occurrences = text.matches(&replacement.find).count();
        if occurrences != 1 {
            return Err(Xp3PatchError::ReplacementNotApplicable {
                member_id: replacement.member_id.clone(),
                occurrences,
            });
        }
        let new_text = text.replacen(&replacement.find, &replacement.replace, 1);
        entry.1 = new_text.into_bytes();
        if !changed_ids.contains(&replacement.member_id) {
            changed_ids.push(replacement.member_id.clone());
        }
    }
    Ok((patched, changed_ids))
}

/// Run the full XP3 patch-back smoke: decrypt the fixture through the declared
/// secret ref, prove the identity rebuild is byte-identical, apply the trivial
/// replacement manifest, repack, and verify the patched output against the
/// declared fixture profile + secret requirement id. Returns a redactable
/// report.
pub fn run_xp3_patch_smoke_from_fixture(
    fixture: &Xp3CryptFixture,
    manifest: &Xp3PatchManifest,
    fixture_dir: &Path,
) -> Result<Xp3PatchReport, Xp3PatchError> {
    // The patch-back mode this fixture declares + exercises: a length-changing
    // localization forces a full archive repack.
    let patch_back_mode = PatchBackTransform::RepackArchive;

    // The crypt scheme is DATA: the declared profile selects the byte transform.
    let scheme = fixture.crypto_profile.scheme();

    // (0) Resolve the source container + the declared secret ref → key.
    let source = resolve_container_bytes(&fixture.container_source, fixture_dir)?;
    let resolver = FixtureSecretResolver::fixture_default();
    let key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;

    // (1) Decrypt + integrity-verify the source members (the path).
    let source_members: Vec<(String, Vec<u8>)> = decrypt_members(&source, key, scheme)?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();

    // (2) Identity round-trip: re-encipher + repack with NO change must be
    // byte-identical to the source encrypted container.
    let identity_rebuilt = encode_encrypted_xp3(&source_members, key, scheme);
    let byte_identical = identity_rebuilt == source;
    if !byte_identical {
        return Err(Xp3PatchError::IdentityNotBytePreserving);
    }
    let identity = Xp3PatchIdentityReport {
        byte_identical,
        source_hash: proof_hash(&source)?,
        rebuilt_hash: proof_hash(&identity_rebuilt)?,
        source_bytes: source.len() as u64,
        rebuilt_bytes: identity_rebuilt.len() as u64,
    };

    // (3) Apply the trivial replacement manifest + repack (patch-back).
    let (patched_members, changed_ids) = apply_replacements(&source_members, manifest)?;
    let rebuilt = encode_encrypted_xp3(&patched_members, key, scheme);

    // The fixture declares exactly one changed member for the trivial-change
    // proof.
    let patched_member_id =
        changed_ids
            .first()
            .cloned()
            .ok_or_else(|| Xp3PatchError::VerificationFailed {
                detail: "manifest applied no replacements".to_string(),
            })?;

    // (4) VERIFY against the declared secret requirement id: re-open the rebuilt
    // container and decrypt through the DECLARED secret ref. Integrity must
    // pass for every member against its recomputed adlr.
    let rebuilt_key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;
    let rebuilt_members: Vec<(String, Vec<u8>)> = decrypt_members(&rebuilt, rebuilt_key, scheme)?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();

    // (5) VERIFY against the declared fixture profile: engine/container/crypto/
    // surface + the declared expected member set.
    let profile_matched = fixture.engine_family == crate::xp3_crypt::XP3_CRYPT_ENGINE_FAMILY
        && fixture.container == crate::xp3_crypt::XP3_CRYPT_CONTAINER
        && rebuilt_members
            .iter()
            .map(|(id, _)| id.as_str())
            .eq(fixture.expected_member_ids.iter().map(String::as_str));
    if !profile_matched {
        return Err(Xp3PatchError::VerificationFailed {
            detail: "rebuilt output did not match the declared fixture profile".to_string(),
        });
    }

    // (6) Trivial-change proof: locate the patched member in source + rebuilt,
    // confirm the new text is present, the old text is gone, and every other
    // member is byte-identical.
    let replacement = manifest
        .replacements
        .iter()
        .find(|r| r.member_id == patched_member_id)
        .ok_or_else(|| Xp3PatchError::Internal {
            message: "changed member has no manifest replacement".to_string(),
        })?;
    let source_member = find_member(&source_members, &patched_member_id)?;
    let rebuilt_member = find_member(&rebuilt_members, &patched_member_id)?;
    let source_text = String::from_utf8_lossy(source_member);
    let rebuilt_text = String::from_utf8_lossy(rebuilt_member);

    let mut other_members_byte_identical = true;
    for (id, source_plain) in &source_members {
        if id == &patched_member_id {
            continue;
        }
        let rebuilt_plain = find_member(&rebuilt_members, id)?;
        if rebuilt_plain != source_plain.as_slice() {
            other_members_byte_identical = false;
        }
    }

    let patch = Xp3PatchChangeReport {
        member_id: patched_member_id.clone(),
        old_present_in_source: source_text.contains(&replacement.find),
        new_present_in_rebuilt: rebuilt_text.contains(&replacement.replace),
        old_absent_in_rebuilt: !rebuilt_text.contains(&replacement.find),
        length_delta: rebuilt_member.len() as i64 - source_member.len() as i64,
        other_members_byte_identical,
    };
    if !(patch.old_present_in_source
        && patch.new_present_in_rebuilt
        && patch.old_absent_in_rebuilt
        && patch.other_members_byte_identical)
    {
        return Err(Xp3PatchError::VerificationFailed {
            detail: "trivial-change proof did not hold (new text / old text / isolation)"
                .to_string(),
        });
    }

    // (7) The verification manifest (hash-based) + a proof over its member
    // commitments.
    let patched_manifest: Vec<Xp3CryptMemberDigest> = rebuilt_members
        .iter()
        .map(|(id, plaintext)| member_digest_from_plaintext(id, plaintext))
        .collect::<Result<Vec<_>, Xp3CryptError>>()?;
    let mut proof_material = Vec::new();
    for digest in &patched_manifest {
        proof_material.extend_from_slice(digest.member_id.as_bytes());
        proof_material.extend_from_slice(digest.plaintext_hash.as_str().as_bytes());
    }
    let verification = Xp3PatchVerification {
        profile_matched,
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_requirement_verified: true,
        patched_manifest,
        verification_proof: KeyValidationProof {
            method: KeyValidationMethod::DecryptHeaderProof,
            proof_hash: proof_hash(&proof_material)?,
        },
    };

    let total_members = u32::try_from(source_members.len()).unwrap_or(u32::MAX);
    let members_patched = u32::try_from(changed_ids.len()).unwrap_or(u32::MAX);
    let coverage = Xp3PatchCoverage {
        total_members,
        members_patched,
        members_byte_preserved: total_members.saturating_sub(members_patched),
        replacements_applied: u32::try_from(manifest.replacements.len()).unwrap_or(u32::MAX),
    };

    let report = Xp3PatchReport {
        schema_version: XP3_PATCH_SCHEMA_VERSION.to_string(),
        capability_id: XP3_PATCH_CAPABILITY_ID.to_string(),
        source_node_id: manifest.source_node_id.clone(),
        support_boundary: XP3_PATCH_SUPPORT_BOUNDARY.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        manifest_id: manifest.manifest_id.clone(),
        engine_family: fixture.engine_family.clone(),
        container: fixture.container.clone(),
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        redaction_status: HelperRedactionStatus::Redacted,
        capability: Xp3PatchCapability {
            patch_back_mode,
            crypto_profile: fixture.crypto_profile,
            surface: fixture.surface,
            coverage,
        },
        identity,
        patch,
        verification,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // the raw key material.
    let json = report
        .stable_json()
        .map_err(|error| Xp3PatchError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) {
        return Err(Xp3PatchError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Convenience wrapper: read the fixture JSON + manifest JSON and run the smoke.
pub fn run_xp3_patch_smoke_from_paths(
    fixture_path: &Path,
    manifest_path: &Path,
) -> Result<Xp3PatchReport, Xp3PatchError> {
    let fixture: Xp3CryptFixture =
        kaifuu_core::read_json(fixture_path).map_err(|error| Xp3PatchError::Internal {
            message: error.to_string(),
        })?;
    let manifest: Xp3PatchManifest =
        kaifuu_core::read_json(manifest_path).map_err(|error| Xp3PatchError::Internal {
            message: error.to_string(),
        })?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or_else(|| Xp3PatchError::Internal {
            message: "fixture path must have a parent directory".to_string(),
        })?;
    run_xp3_patch_smoke_from_fixture(&fixture, &manifest, fixture_dir)
}

fn find_member<'a>(
    members: &'a [(String, Vec<u8>)],
    member_id: &str,
) -> Result<&'a [u8], Xp3PatchError> {
    members
        .iter()
        .find(|(id, _)| id == member_id)
        .map(|(_, bytes)| bytes.as_slice())
        .ok_or_else(|| Xp3PatchError::UnknownMember {
            member_id: member_id.to_string(),
        })
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, Xp3PatchError> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(|message| Xp3PatchError::Internal { message })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xp3_crypt::{
        XP3_CRYPT_CONTAINER, XP3_CRYPT_ENGINE_FAMILY, XP3_CRYPT_REQUIREMENT_ID,
        XP3_CRYPT_SCHEMA_VERSION, XP3_CRYPT_VALID_SECRET_REF, build_synthetic_crypt_xp3,
    };
    use kaifuu_core::CodecTransform;

    fn synthetic_fixture() -> Xp3CryptFixture {
        Xp3CryptFixture {
            schema_version: XP3_CRYPT_SCHEMA_VERSION.to_string(),
            fixture_id: "kirikiri-xp3-patch-back-fixture".to_string(),
            source_node_id: "KAIFUU-101".to_string(),
            engine_family: XP3_CRYPT_ENGINE_FAMILY.to_string(),
            container: XP3_CRYPT_CONTAINER.to_string(),
            crypto_profile: Xp3CryptoProfile::XorSimpleCryptFixture,
            codec: CodecTransform::ShiftJisText,
            surface: KirikiriXp3Surface::ScenarioScript,
            secret_requirement_id: XP3_CRYPT_REQUIREMENT_ID.to_string(),
            secret_ref: SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap(),
            container_source: crate::xp3_crypt::Xp3CryptContainerSource::SyntheticStub,
            expected_member_ids: vec![
                "scenario/intro.ks".to_string(),
                "system/config.txt".to_string(),
            ],
        }
    }

    #[test]
    fn patch_back_round_trip_verifies_against_declared_profile() {
        let report = run_xp3_patch_smoke_from_fixture(
            &synthetic_fixture(),
            &Xp3PatchManifest::fixture_default(),
            Path::new("."),
        )
        .expect("patch-back smoke runs");

        assert!(report.is_ok());
        // Capability output records patch-back mode / crypto profile / coverage.
        assert_eq!(
            report.capability.patch_back_mode,
            PatchBackTransform::RepackArchive
        );
        assert_eq!(
            report.capability.crypto_profile,
            Xp3CryptoProfile::XorSimpleCryptFixture
        );
        assert_eq!(report.capability.coverage.total_members, 2);
        assert_eq!(report.capability.coverage.members_patched, 1);
        assert_eq!(report.capability.coverage.members_byte_preserved, 1);
        assert_eq!(report.capability.coverage.replacements_applied, 1);

        // Verified against the declared secret requirement id.
        assert_eq!(
            report.verification.secret_requirement_id,
            XP3_CRYPT_REQUIREMENT_ID
        );
        assert!(report.verification.secret_requirement_verified);
        assert!(report.verification.profile_matched);
    }

    #[test]
    fn identity_rebuild_is_byte_identical() {
        let report = run_xp3_patch_smoke_from_fixture(
            &synthetic_fixture(),
            &Xp3PatchManifest::fixture_default(),
            Path::new("."),
        )
        .expect("smoke runs");
        assert!(report.identity.byte_identical);
        assert_eq!(report.identity.source_bytes, report.identity.rebuilt_bytes);
        assert_eq!(
            report.identity.source_hash.as_str(),
            report.identity.rebuilt_hash.as_str()
        );
        // Independent check: the identity rebuild really equals the source.
        assert_eq!(
            report.identity.source_hash.as_str(),
            sha256_hash_bytes(&build_synthetic_crypt_xp3())
        );
    }

    #[test]
    fn trivial_change_applied_and_isolated() {
        let manifest = Xp3PatchManifest::fixture_default();
        let report =
            run_xp3_patch_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
                .expect("smoke runs");
        assert_eq!(report.patch.member_id, "scenario/intro.ks");
        assert!(report.patch.old_present_in_source);
        assert!(report.patch.new_present_in_rebuilt);
        assert!(report.patch.old_absent_in_rebuilt);
        assert!(report.patch.other_members_byte_identical);
        // Length-changing (proves the repack recomputed sizes/offsets).
        let expected_delta = manifest.replacements[0].replace.len() as i64
            - manifest.replacements[0].find.len() as i64;
        assert_eq!(report.patch.length_delta, expected_delta);
        assert_ne!(report.patch.length_delta, 0);
    }

    #[test]
    fn report_leaks_no_raw_key_or_plaintext() {
        let manifest = Xp3PatchManifest::fixture_default();
        let report =
            run_xp3_patch_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
                .expect("smoke runs");
        let json = report.stable_json().expect("stable json");
        // The old + new synthetic text never appears verbatim (hash-based).
        assert!(!json.contains(&manifest.replacements[0].find));
        assert!(!json.contains(&manifest.replacements[0].replace));
    }

    #[test]
    fn replacement_absent_find_is_typed_error() {
        let manifest = Xp3PatchManifest {
            schema_version: XP3_PATCH_SCHEMA_VERSION.to_string(),
            manifest_id: "bad".to_string(),
            source_node_id: "KAIFUU-101".to_string(),
            replacements: vec![Xp3TextReplacement {
                member_id: "scenario/intro.ks".to_string(),
                find: "this-text-does-not-exist".to_string(),
                replace: "x".to_string(),
            }],
        };
        let err = run_xp3_patch_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
            .expect_err("absent find must be a typed error");
        assert!(matches!(
            err,
            Xp3PatchError::ReplacementNotApplicable { occurrences: 0, .. }
        ));
        assert!(err.to_string().starts_with(XP3_PATCH_MARKER));
    }

    #[test]
    fn replacement_unknown_member_is_typed_error() {
        let manifest = Xp3PatchManifest {
            schema_version: XP3_PATCH_SCHEMA_VERSION.to_string(),
            manifest_id: "bad".to_string(),
            source_node_id: "KAIFUU-101".to_string(),
            replacements: vec![Xp3TextReplacement {
                member_id: "no/such/member.ks".to_string(),
                find: "x".to_string(),
                replace: "y".to_string(),
            }],
        };
        let err = run_xp3_patch_smoke_from_fixture(&synthetic_fixture(), &manifest, Path::new("."))
            .expect_err("unknown member must be a typed error");
        assert!(matches!(err, Xp3PatchError::UnknownMember { .. }));
    }
}
