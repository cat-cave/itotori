//! the profiled XP3 **crypt-chain** smoke command.
//! # What this is (and is not)
//! This module runs the **full Kaifuu chain** end-to-end on an encrypted
//! KiriKiri XP3 archive through a **keyRef-bound crypt profile**, on the same
//! **synthetic, fixture-safe** archive the [`crate::xp3_crypt`]
//! decrypt smoke and the [`crate::xp3_patch`] patch-back smoke own.
//! It composes the two proven capabilities plus the two bookends the chain node
//! adds — a magic-byte **detect** stage and a redacted **delta** package — into
//! **one** command with a single ordered stage ledger:
//! 1. **detect** — the engine/container is identified by **magic-byte
//!    signature** ([`kaifuu_core::XP3_PLAIN_MAGIC`]), never by filename. The
//!    crypt *variant* is a **declared profile** ([`Xp3CryptoProfile`]): the
//!    synthetic container's XP3 index is plaintext and only member **file data**
//!    is enciphered (honest scope), so the cipher is bound by the
//!    profile/keyRef **data**, not sniffed from the container. That binding is
//!    what makes this path **engine-general and game-agnostic** — the profile +
//!    keyRef are config, not a per-game code branch.
//! 2. **profile/key resolve** — the decrypt key is resolved through the
//!    fixture's declared **secret ref** (a requirement id + a
//!    [`kaifuu_core::SecretRef`] resolved to fixture-safe key material at
//!    runtime), **never** a raw key value baked into the report.
//! 3. **extract** — every member is decrypted and integrity-verified against the
//!    XP3 `adlr` adler-32 (KiriKiri's own integrity oracle) and reduced to a
//!    hash-based manifest (member ids, byte lengths, sha-256 commitments).
//! 4. **patch** — one trivial, length-changing text replacement is applied to a
//!    single member.
//! 5. **rebuild** — every member is re-enciphered with the same resolved key and
//!    the archive is repacked through the shared deterministic encoder.
//! 6. **verify** — the rebuilt container is re-opened and re-decrypted through
//!    the **declared** secret ref, every member passes its recomputed `adlr`
//!    integrity check, the patched member carries the new text and not the old,
//!    and every other member is byte-identical. The identity rebuild (no change)
//!    is byte-identical to the source.
//! 7. **delta** — a **redacted** delta package / evidence is emitted: public
//!    fixture id + one-way sha-256 proof hashes (source/rebuilt container, per
//!    member source/target plaintext commitments) + secret **refs** only. Never
//!    a raw key, never decrypted plaintext, never a private path or retail byte.
//! ## Honest scope
//! Everything the crypt boundary says still holds: the container is a
//! genuine plain-XP3 archive, only member **file data** is enciphered, the
//! integrity oracle is KiriKiri's real `adlr` adler-32, and the crypt filter is
//! a declared **fixture** XOR analogue — NOT a real per-title CxDec/TVP filter.
//! No retail bytes and no raw key material leave the module: the members are
//! clearly-synthetic authored text and the key is a fixture constant that never
//! leaves [`crate::xp3_crypt`].

use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::{
    HelperRedactionStatus, KaifuuResult, KeyMaterialKind, KeyValidationMethod, KeyValidationProof,
    OperationStatus, ProofHash, SecretRef, XP3_PLAIN_MAGIC, deterministic_id,
    redact_for_log_or_report, sha256_hash_bytes, stable_json,
};
use std::path::Path;

use crate::xp3_crypt::{
    FixtureSecretResolver, XP3_CRYPT_CONTAINER, XP3_CRYPT_ENGINE_FAMILY, Xp3CryptError,
    Xp3CryptFixture, Xp3CryptKeyExt, Xp3CryptMemberDigest, Xp3CryptoProfile, decrypt_and_extract,
    decrypt_members, encode_encrypted_xp3, resolve_container_bytes,
};
use crate::xp3_patch::{
    Xp3PatchError, Xp3PatchManifest, Xp3PatchReport, apply_replacements,
    run_xp3_patch_smoke_from_fixture,
};

/// Every typed error's `Display` starts here so an audit can pin the module.
pub const XP3_CHAIN_MARKER: &str = "kaifuu.kirikiri.xp3_crypt_chain";

/// Schema version of the chain report + delta evidence.
pub const XP3_CHAIN_SCHEMA_VERSION: &str = "0.1.0";

/// Canonical capability id surfaced in the report.
pub const XP3_CHAIN_CAPABILITY_ID: &str = "kaifuu-kirikiri-xp3-crypt-chain-smoke";

/// Stable format tag for the emitted delta evidence.
pub const XP3_CHAIN_DELTA_FORMAT: &str = "kaifuu-xp3-crypt-delta-evidence";

/// How the container was recognized: always a magic-byte signature, never a
/// filename or file-tree heuristic.
pub const XP3_CHAIN_DETECTED_BY: &str = "magic-byte-signature";

/// Where the crypt variant is bound from. The synthetic container's XP3 index is
/// plaintext (only member file data is enciphered), so the cipher is bound by
/// the declared profile + keyRef **data**, engine-general, not sniffed.
pub const XP3_CHAIN_CRYPT_VARIANT_SOURCE: &str =
    "declared-profile (keyRef-bound; file-data cipher, XP3 index plaintext)";

/// The blunt support boundary carried in every report.
pub const XP3_CHAIN_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3 crypt-chain smoke runs the full chain on a SYNTHETIC encrypted XP3 through a keyRef-bound crypt profile: detect the XP3 container by magic-byte signature (never filename), resolve the decrypt key through the declared secret ref (never a raw key), decrypt+integrity-verify+extract every member, apply one trivial text replacement, re-encipher+repack, re-decrypt+verify against the declared secret requirement id and fixture profile, and emit a REDACTED delta package (public fixture id + one-way sha-256 hashes + secret refs only). The crypt profile + keyRef are DATA (engine-general, game-agnostic), not a per-game code path. This is NOT commercial encrypted-XP3 coverage and the fixture crypt filter is NOT a real per-title CxDec/TVP filter; member integrity is KiriKiri's real adlr adler-32. No retail bytes and no raw key material leave the module.";

/// The ordered stages the chain command runs, in execution order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum Xp3ChainStage {
    /// Identify the engine/container by magic-byte signature.
    Detect,
    /// Resolve the crypt profile + decrypt key through the keyRef.
    ProfileResolve,
    /// Decrypt + integrity-verify + extract every member.
    Extract,
    /// Apply the trivial text replacement.
    Patch,
    /// Re-encipher + repack the archive.
    Rebuild,
    /// Re-decrypt + verify against the declared profile + secret requirement id.
    Verify,
    /// Emit the redacted delta package / evidence.
    Delta,
}

impl Xp3ChainStage {
    /// Stable label for reports.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Detect => "detect",
            Self::ProfileResolve => "profile-resolve",
            Self::Extract => "extract",
            Self::Patch => "patch",
            Self::Rebuild => "rebuild",
            Self::Verify => "verify",
            Self::Delta => "delta",
        }
    }

    /// The full ordered chain, used to prove no stage was skipped.
    #[must_use]
    pub fn ordered() -> [Xp3ChainStage; 7] {
        [
            Self::Detect,
            Self::ProfileResolve,
            Self::Extract,
            Self::Patch,
            Self::Rebuild,
            Self::Verify,
            Self::Delta,
        ]
    }
}

/// One stage's outcome in the ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ChainStageOutcome {
    /// The stage this outcome is for.
    pub stage: Xp3ChainStage,
    /// The stage status (a chain that returns Ok has every stage `Passed`).
    pub status: OperationStatus,
    /// A short, redactable diagnostic detail.
    pub detail: String,
}

/// Fatal errors raised by the XP3 crypt-chain path. Every variant's `Display`
/// begins with [`XP3_CHAIN_MARKER`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Xp3ChainError {
    /// The container did not carry the XP3 magic-byte signature, so the engine/
    /// container could not be detected. Refused rather than guessing from a
    /// filename.
    #[error(
        "{XP3_CHAIN_MARKER}.container_not_detected: bytes do not carry the XP3 magic-byte signature"
    )]
    ContainerNotDetected,
    /// The underlying crypt/decrypt path failed (missing/wrong key, container
    /// read, integrity). Carried through so failure modes stay typed.
    #[error("{XP3_CHAIN_MARKER}.crypt: {0}")]
    Crypt(#[from] Xp3CryptError),
    /// The underlying patch-back path failed. Carried through typed.
    #[error("{XP3_CHAIN_MARKER}.patch: {0}")]
    Patch(#[from] Xp3PatchError),
    /// An internal proof/serialization failure (redacted).
    #[error("{XP3_CHAIN_MARKER}.internal: {message}")]
    Internal {
        /// Redacted internal detail.
        message: String,
    },
}

/// The magic-byte detect result: the container was recognized by signature
/// (never by filename), and the crypt variant is a declared, keyRef-bound
/// profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ChainDetectReport {
    /// Engine family (`kirikiri`).
    pub engine_family: String,
    /// Container (`xp3`).
    pub container: String,
    /// How the container was recognized (always a magic-byte signature).
    pub detected_by: String,
    /// The magic-byte signature matched.
    pub magic_matched: bool,
    /// One-way sha-256 commitment to the public container magic prefix (public
    /// bytes only; never key material).
    pub container_magic_hash: ProofHash,
    /// The declared crypt filter / cipher, bound by the profile + keyRef.
    pub crypto_profile: Xp3CryptoProfile,
    /// Where the crypt variant is bound from (declared, keyRef-bound data).
    pub crypt_variant_source: String,
}

/// Detect the XP3 container by **magic-byte signature** (never by filename), and
/// record the declared, keyRef-bound crypt variant. Refuses with a typed error
/// when the bytes do not carry the XP3 signature.
pub fn detect_xp3_container(
    container: &[u8],
    crypto_profile: Xp3CryptoProfile,
) -> Result<Xp3ChainDetectReport, Xp3ChainError> {
    if !container.starts_with(XP3_PLAIN_MAGIC) {
        return Err(Xp3ChainError::ContainerNotDetected);
    }
    // Hash only the public magic prefix — declared container bytes, not secret.
    let magic_len = XP3_PLAIN_MAGIC.len().min(container.len());
    let container_magic_hash = proof_hash(&container[..magic_len])?;
    Ok(Xp3ChainDetectReport {
        engine_family: XP3_CRYPT_ENGINE_FAMILY.to_string(),
        container: XP3_CRYPT_CONTAINER.to_string(),
        detected_by: XP3_CHAIN_DETECTED_BY.to_string(),
        magic_matched: true,
        container_magic_hash,
        crypto_profile,
        crypt_variant_source: XP3_CHAIN_CRYPT_VARIANT_SOURCE.to_string(),
    })
}

/// The profile/key resolve result: the decrypt key was resolved through the
/// keyRef. Discloses the requirement id + secret ref + one-way key commitment —
/// never the raw key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ChainProfileResolveReport {
    /// The secret **requirement id** (never raw key material).
    pub secret_requirement_id: String,
    /// The structured secret ref the decrypt key was resolved through.
    pub secret_ref: SecretRef,
    /// The declared crypt filter / cipher bound to the keyRef.
    pub crypto_profile: Xp3CryptoProfile,
    /// One-way sha-256 commitment to the resolved key bytes (never the bytes).
    pub key_material_hash: ProofHash,
    /// Resolved key byte length (disclosed; the bytes are not).
    pub key_bytes: u32,
    /// Key material kind.
    pub key_material_kind: KeyMaterialKind,
    /// The keyRef resolved to material.
    pub resolved: bool,
}

/// The operation a delta member entry records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Xp3ChainDeltaOperation {
    /// The member's plaintext changed across the rebuild.
    Replace,
    /// The member's plaintext was byte-identical across the rebuild.
    Unchanged,
}

/// One member's delta entry (hash-based; no raw plaintext).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ChainDeltaMember {
    /// The in-archive member id.
    pub member_id: String,
    /// Whether this member changed.
    pub operation: Xp3ChainDeltaOperation,
    /// sha-256 commitment to the source (pre-patch) plaintext.
    pub source_plaintext_hash: ProofHash,
    /// Source plaintext byte length.
    pub source_byte_len: u64,
    /// sha-256 commitment to the target (post-patch) plaintext.
    pub target_plaintext_hash: ProofHash,
    /// Target plaintext byte length.
    pub target_byte_len: u64,
    /// Byte-length delta of the member's plaintext (target - source).
    pub length_delta: i64,
}

impl Xp3ChainDeltaMember {
    fn redacted_for_report(&self) -> Self {
        Self {
            member_id: redact_for_log_or_report(&self.member_id),
            operation: self.operation,
            source_plaintext_hash: self.source_plaintext_hash.clone(),
            source_byte_len: self.source_byte_len,
            target_plaintext_hash: self.target_plaintext_hash.clone(),
            target_byte_len: self.target_byte_len,
            length_delta: self.length_delta,
        }
    }
}

/// The redacted delta package / evidence: which encrypted container went in,
/// which came out, and the per-member plaintext deltas — all as one-way hashes,
/// counts, and secret **refs** only. Never a raw key, plaintext, or path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ChainDeltaEvidence {
    /// Delta schema version.
    pub schema_version: String,
    /// Deterministic delta package id.
    pub delta_package_id: String,
    /// Stable format tag.
    pub format: String,
    /// The secret requirement id the rebuild was keyed through (never the key).
    pub secret_requirement_id: String,
    /// The structured secret ref (safe to disclose).
    pub secret_ref: SecretRef,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// sha-256 of the source encrypted container.
    pub source_container_hash: ProofHash,
    /// Source encrypted container byte length.
    pub source_container_bytes: u64,
    /// sha-256 of the rebuilt (patched) encrypted container.
    pub rebuilt_container_hash: ProofHash,
    /// Rebuilt encrypted container byte length.
    pub rebuilt_container_bytes: u64,
    /// Per-member delta entries (hash-based).
    pub members: Vec<Xp3ChainDeltaMember>,
    /// How many members changed.
    pub members_changed: u32,
    /// How many members stayed byte-identical.
    pub members_unchanged: u32,
    /// A hash over the member entries (proves this exact delta set).
    pub delta_proof: KeyValidationProof,
}

impl Xp3ChainDeltaEvidence {
    fn redacted_for_report(&self) -> Self {
        // Public constants / disclosed ids + refs (schema, package id, format
        // tag, requirement id, secret ref) stay verbatim: the delta package must
        // stay identifiable. The genuine secrets — the raw key (guarded at
        // runtime + only a one-way commitment is stored), decrypted plaintext
        // (only hashed), and local paths (never stored) — cannot reach here. Only
        // per-member ids (arbitrary archive paths in a real run) are run through
        // the defensive redactor.
        Self {
            schema_version: self.schema_version.clone(),
            delta_package_id: self.delta_package_id.clone(),
            format: self.format.clone(),
            secret_requirement_id: self.secret_requirement_id.clone(),
            secret_ref: self.secret_ref.clone(),
            redaction_status: self.redaction_status,
            source_container_hash: self.source_container_hash.clone(),
            source_container_bytes: self.source_container_bytes,
            rebuilt_container_hash: self.rebuilt_container_hash.clone(),
            rebuilt_container_bytes: self.rebuilt_container_bytes,
            members: self
                .members
                .iter()
                .map(Xp3ChainDeltaMember::redacted_for_report)
                .collect(),
            members_changed: self.members_changed,
            members_unchanged: self.members_unchanged,
            delta_proof: self.delta_proof.clone(),
        }
    }
}

/// The full XP3 crypt-chain smoke report. Redact before serialization via
/// [`Xp3CryptChainReport::stable_json`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptChainReport {
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
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// The ordered stage ledger (proves the whole chain ran, in order).
    pub stages: Vec<Xp3ChainStageOutcome>,
    /// The detect stage output.
    pub detect: Xp3ChainDetectReport,
    /// The profile/key resolve stage output.
    pub profile_resolve: Xp3ChainProfileResolveReport,
    /// The extract stage manifest (hash-based; no raw plaintext).
    pub extract_manifest: Vec<Xp3CryptMemberDigest>,
    /// The patch/rebuild/verify stage output (the proven report).
    pub patch_back: Xp3PatchReport,
    /// The redacted delta evidence.
    pub delta: Xp3ChainDeltaEvidence,
    /// Overall status.
    pub status: OperationStatus,
}

impl Xp3CryptChainReport {
    fn redacted_for_report(&self) -> Self {
        // Public constants + disclosed ids/refs stay verbatim so the report stays
        // identifiable; the real secrets (raw key, plaintext, local paths) never
        // reach this struct (key is guarded + hashed, plaintext is only hashed,
        // paths are never stored). Only genuinely dynamic per-run strings —
        // fixture/manifest ids and free-text stage detail — go through the
        // defensive redactor.
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: self.capability_id.clone(),
            source_node_id: self.source_node_id.clone(),
            support_boundary: self.support_boundary.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            manifest_id: redact_for_log_or_report(&self.manifest_id),
            engine_family: self.engine_family.clone(),
            container: self.container.clone(),
            redaction_status: self.redaction_status,
            stages: self
                .stages
                .iter()
                .map(|outcome| Xp3ChainStageOutcome {
                    stage: outcome.stage,
                    status: outcome.status.clone(),
                    // Detail is code-generated from public constants + counts +
                    // booleans — never user or secret data — so it stays verbatim
                    // (the runtime raw-key no-leak guard still covers it).
                    detail: outcome.detail.clone(),
                })
                .collect(),
            detect: Xp3ChainDetectReport {
                engine_family: self.detect.engine_family.clone(),
                container: self.detect.container.clone(),
                detected_by: self.detect.detected_by.clone(),
                magic_matched: self.detect.magic_matched,
                container_magic_hash: self.detect.container_magic_hash.clone(),
                crypto_profile: self.detect.crypto_profile,
                crypt_variant_source: self.detect.crypt_variant_source.clone(),
            },
            profile_resolve: Xp3ChainProfileResolveReport {
                secret_requirement_id: self.profile_resolve.secret_requirement_id.clone(),
                secret_ref: self.profile_resolve.secret_ref.clone(),
                crypto_profile: self.profile_resolve.crypto_profile,
                key_material_hash: self.profile_resolve.key_material_hash.clone(),
                key_bytes: self.profile_resolve.key_bytes,
                key_material_kind: self.profile_resolve.key_material_kind,
                resolved: self.profile_resolve.resolved,
            },
            extract_manifest: self
                .extract_manifest
                .iter()
                .map(Xp3CryptMemberDigest::redacted_for_report)
                .collect(),
            patch_back: self.patch_back.redacted_for_report(),
            delta: self.delta.redacted_for_report(),
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no plaintext).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    /// True when the whole chain passed.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }
}

/// Run the full XP3 crypt-chain smoke: detect the container by magic-byte
/// signature, resolve the crypt profile + key through the keyRef, extract +
/// integrity-verify every member, apply the trivial replacement manifest,
/// rebuild + verify against the declared profile + secret requirement id, and
/// emit a redacted delta package. Returns a redactable report whose stage ledger
/// proves every stage ran, in order.
pub fn run_xp3_crypt_chain_smoke_from_fixture(
    fixture: &Xp3CryptFixture,
    manifest: &Xp3PatchManifest,
    fixture_dir: &Path,
) -> Result<Xp3CryptChainReport, Xp3ChainError> {
    // (0) Resolve the source encrypted container bytes in-process (no shell-out).
    let container = resolve_container_bytes(&fixture.container_source, fixture_dir)?;

    // (1) DETECT the engine/container by magic-byte signature.
    let detect = detect_xp3_container(&container, fixture.crypto_profile)?;

    // The crypt scheme is DATA: the declared profile selects the byte transform.
    let scheme = fixture.crypto_profile.scheme();

    // (2) PROFILE/KEY RESOLVE through the keyRef-bound crypt profile.
    let resolver = FixtureSecretResolver::fixture_default();
    let key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;
    let profile_resolve = Xp3ChainProfileResolveReport {
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        crypto_profile: fixture.crypto_profile,
        key_material_hash: key.material_hash()?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        key_material_kind: KeyMaterialKind::FixedBytes,
        resolved: true,
    };

    // (3) EXTRACT: decrypt + integrity-verify every member (hash-based manifest).
    let extract = decrypt_and_extract(&container, key, scheme)?;
    let extract_manifest: Vec<Xp3CryptMemberDigest> = extract
        .members
        .iter()
        .map(|member| Xp3CryptMemberDigest {
            member_id: member.member_id.clone(),
            plaintext_byte_len: member.plaintext_byte_len,
            plaintext_hash: member.plaintext_hash.clone(),
            adler32: member.adler32.clone(),
        })
        .collect();

    // (4-6) PATCH -> REBUILD -> VERIFY via the proven patch-back path
    // (extract through the declared secret ref, apply the trivial change,
    // repack, re-decrypt + verify against the declared profile + secret
    // requirement id, and prove the identity rebuild is byte-identical).
    let patch_back = run_xp3_patch_smoke_from_fixture(fixture, manifest, fixture_dir)?;

    // (7) DELTA: recompute the source + patched plaintexts and the rebuilt
    // container through the SAME deterministic primitives, then emit a
    // redacted, hash-based delta package (secret refs only).
    let source_pairs: Vec<(String, Vec<u8>)> = decrypt_members(&container, key, scheme)?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();
    let (patched_pairs, _changed_ids) = apply_replacements(&source_pairs, manifest)?;
    let rebuilt = encode_encrypted_xp3(&patched_pairs, key, scheme);
    let delta = build_delta_evidence(&container, &rebuilt, &source_pairs, &patched_pairs, fixture)?;

    // The stage ledger: every stage ran, in order.
    let stages = build_stage_ledger(&detect, &extract_manifest, &patch_back, &delta);

    let report = Xp3CryptChainReport {
        schema_version: XP3_CHAIN_SCHEMA_VERSION.to_string(),
        capability_id: XP3_CHAIN_CAPABILITY_ID.to_string(),
        source_node_id: "KAIFUU-072".to_string(),
        support_boundary: XP3_CHAIN_SUPPORT_BOUNDARY.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        manifest_id: manifest.manifest_id.clone(),
        engine_family: fixture.engine_family.clone(),
        container: fixture.container.clone(),
        redaction_status: HelperRedactionStatus::Redacted,
        stages,
        detect,
        profile_resolve,
        extract_manifest,
        patch_back,
        delta,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // the raw key material, whether verbatim or hex/base64-encoded. Hard
    // refusal, not just a test-time check.
    let json = report
        .stable_json()
        .map_err(|error| Xp3ChainError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) {
        return Err(Xp3ChainError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Convenience wrapper: read the fixture JSON + trivial replacement manifest
/// JSON and run the chain smoke against the fixture's directory.
pub fn run_xp3_crypt_chain_smoke_from_paths(
    fixture_path: &Path,
    manifest_path: &Path,
) -> Result<Xp3CryptChainReport, Xp3ChainError> {
    let fixture: Xp3CryptFixture =
        kaifuu_core::read_json(fixture_path).map_err(|error| Xp3ChainError::Internal {
            message: error.to_string(),
        })?;
    let manifest: Xp3PatchManifest =
        kaifuu_core::read_json(manifest_path).map_err(|error| Xp3ChainError::Internal {
            message: error.to_string(),
        })?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or_else(|| Xp3ChainError::Internal {
            message: "fixture path must have a parent directory".to_string(),
        })?;
    run_xp3_crypt_chain_smoke_from_fixture(&fixture, &manifest, fixture_dir)
}

/// Build the per-member delta entries + package from the source and patched
/// plaintexts and the source / rebuilt encrypted containers.
fn build_delta_evidence(
    source_container: &[u8],
    rebuilt_container: &[u8],
    source_pairs: &[(String, Vec<u8>)],
    patched_pairs: &[(String, Vec<u8>)],
    fixture: &Xp3CryptFixture,
) -> Result<Xp3ChainDeltaEvidence, Xp3ChainError> {
    let mut members = Vec::with_capacity(source_pairs.len());
    let mut members_changed = 0u32;
    let mut members_unchanged = 0u32;
    let mut proof_material = Vec::new();

    for (member_id, source_plain) in source_pairs {
        let target_plain = patched_pairs
            .iter()
            .find(|(id, _)| id == member_id)
            .map(|(_, plain)| plain)
            .ok_or_else(|| Xp3ChainError::Internal {
                message: "patched member set dropped a source member".to_string(),
            })?;
        let source_plaintext_hash = proof_hash(source_plain)?;
        let target_plaintext_hash = proof_hash(target_plain)?;
        let operation = if source_plaintext_hash.as_str() == target_plaintext_hash.as_str() {
            members_unchanged += 1;
            Xp3ChainDeltaOperation::Unchanged
        } else {
            members_changed += 1;
            Xp3ChainDeltaOperation::Replace
        };
        proof_material.extend_from_slice(member_id.as_bytes());
        proof_material.extend_from_slice(source_plaintext_hash.as_str().as_bytes());
        proof_material.extend_from_slice(target_plaintext_hash.as_str().as_bytes());
        members.push(Xp3ChainDeltaMember {
            member_id: member_id.clone(),
            operation,
            source_plaintext_hash,
            source_byte_len: source_plain.len() as u64,
            target_plaintext_hash,
            target_byte_len: target_plain.len() as u64,
            length_delta: target_plain.len() as i64 - source_plain.len() as i64,
        });
    }

    let delta_proof = KeyValidationProof {
        method: KeyValidationMethod::FixtureRoundTripProof,
        proof_hash: proof_hash(&proof_material)?,
    };

    Ok(Xp3ChainDeltaEvidence {
        schema_version: XP3_CHAIN_SCHEMA_VERSION.to_string(),
        delta_package_id: deterministic_id("kaifuu-xp3-crypt-delta", 1),
        format: XP3_CHAIN_DELTA_FORMAT.to_string(),
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        redaction_status: HelperRedactionStatus::Redacted,
        source_container_hash: proof_hash(source_container)?,
        source_container_bytes: source_container.len() as u64,
        rebuilt_container_hash: proof_hash(rebuilt_container)?,
        rebuilt_container_bytes: rebuilt_container.len() as u64,
        members,
        members_changed,
        members_unchanged,
        delta_proof,
    })
}

/// Build the ordered stage ledger with a short (redactable) detail per stage.
fn build_stage_ledger(
    detect: &Xp3ChainDetectReport,
    extract_manifest: &[Xp3CryptMemberDigest],
    patch_back: &Xp3PatchReport,
    delta: &Xp3ChainDeltaEvidence,
) -> Vec<Xp3ChainStageOutcome> {
    let passed = |stage: Xp3ChainStage, detail: String| Xp3ChainStageOutcome {
        stage,
        status: OperationStatus::Passed,
        detail,
    };
    vec![
        passed(
            Xp3ChainStage::Detect,
            format!(
                "{} container detected by {}",
                detect.container, detect.detected_by
            ),
        ),
        passed(
            Xp3ChainStage::ProfileResolve,
            format!("crypt profile {} key resolved via keyRef", {
                detect.crypto_profile.as_str()
            }),
        ),
        passed(
            Xp3ChainStage::Extract,
            format!("{} members decrypted + integrity-verified", {
                extract_manifest.len()
            }),
        ),
        passed(
            Xp3ChainStage::Patch,
            format!(
                "{} replacement(s) applied",
                patch_back.capability.coverage.replacements_applied
            ),
        ),
        passed(
            Xp3ChainStage::Rebuild,
            format!(
                "repacked (patch-back mode {:?})",
                patch_back.capability.patch_back_mode
            ),
        ),
        passed(
            Xp3ChainStage::Verify,
            format!(
                "re-decrypt verified against declared secret requirement id (byte-identical identity={})",
                patch_back.identity.byte_identical
            ),
        ),
        passed(
            Xp3ChainStage::Delta,
            format!(
                "delta package: {} changed, {} unchanged",
                delta.members_changed, delta.members_unchanged
            ),
        ),
    ]
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, Xp3ChainError> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(|message| Xp3ChainError::Internal { message })
}

#[cfg(test)]
#[path = "xp3_crypt_chain_tests.rs"]
mod tests;
