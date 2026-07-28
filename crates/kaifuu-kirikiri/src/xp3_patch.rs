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
pub const XP3_PATCH_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3 patch-back smoke extends the  profiled decrypt fixture: it decrypts a SYNTHETIC encrypted XP3 through the declared fixture secret ref, applies one trivial text replacement to a single member, re-enciphers with the same fixture key, recomputes each member adlr adler-32, and repacks the whole archive (patch-back mode repack_archive). The patched output is re-decrypted through the DECLARED secret requirement id and verified against the declared fixture profile: the patched member carries the new text and every other member is byte-identical. The identity rebuild (no change) is byte-identical to the source. This is NOT commercial encrypted-XP3 coverage and the fixture crypt filter is NOT a real per-title CxDec/TVP filter. No retail bytes and no raw key material leave the module.";

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
            source_node_id: "synthetic-fixture".to_string(),
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

mod run;
pub(crate) use run::apply_replacements;
pub use run::{run_xp3_patch_smoke_from_fixture, run_xp3_patch_smoke_from_paths};

#[cfg(test)]
#[path = "xp3_patch_tests.rs"]
mod tests;
