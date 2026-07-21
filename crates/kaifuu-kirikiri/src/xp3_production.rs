//! **production encrypted XP3 extract + patch** for PROFILED crypt
//! schemes and helper workflows.
//! # What this is (and is not)
//! This module composes the proven XP3 crypt substrate
//! ([`crate::xp3_crypt`], [`crate::xp3_patch`]) into a **production, data-driven
//! profiled-variant** extract + patch path. A *profiled variant* is DATA: a
//! declared crypt-scheme profile ([`Xp3CryptoProfile`], whose byte transform is
//! itself a pure function of public scheme data) plus the **required key/helper
//! evidence** the variant needs to be usable — a secret **ref** (never a raw
//! key), for helper-gated variants, a
//! [`HelperResult`](kaifuu_core::HelperResult) supplying that key.
//! Given a profiled variant WITH its required key/helper evidence, the driver:
//! 1. builds the synthetic encrypted archive (real plain-XP3 container whose
//!    member file data is enciphered with the variant's declared crypt scheme +
//!    the fixture archive key — honest scope)
//! 2. checks the variant's **required key/helper evidence** is actually present
//!    and adequate (a resolved key ref; a satisfied helper result when the
//!    workflow requires one);
//! 3. resolves the decrypt key through the secret **ref** and decrypts +
//!    integrity-verifies every member against the XP3 `adlr` (the
//!    path);
//! 4. proves the **identity** rebuild is byte-identical, applies the variant's
//!    trivial text replacement(s), re-enciphers + repacks, and re-decrypts the
//!    rebuilt container through the SAME declared ref to verify the patched text
//!    is present, the old text is gone, and every other member is byte-identical
//!    (the patch-back proof).
//! # Claimed-variant failure is a BUG, not a silent skip
//! Every variant declares whether the profile **claims** to support it. A
//! claimed variant MUST extract + patch. If a claimed variant's required
//! key/helper evidence is missing/inadequate, or its declared crypt scheme does
//! not actually decrypt the archive (integrity failure), or the patch-back
//! round-trip does not verify, the driver returns a typed
//! [`Xp3ProductionError::ClaimedVariantFailed`] — a **loud** failure that aborts
//! the run. It never silently skips a claimed variant. A variant the profile
//! does **not** claim (retail beyond the bounded/profiled evidence) is recorded
//! as an explicit [`Xp3ProductionOutcome::NotClaimed`] out-of-scope row — also
//! not a silent skip, and never advanced to a claim.
//! # Secret discipline
//! The crypt scheme is DATA (engine-general; the same code path drives every
//! profiled variant with no per-game branch). Raw key material only ever lives
//! inside the module-private, zeroize-on-drop, `Debug`-redacting
//! [`Xp3CryptKey`]; the report carries only secret **requirement** ids + secret
//! **refs** + one-way sha-256 commitments + counts. The serialized report is
//! deep no-leak-guarded before it is returned. No retail bytes, no raw keys: the
//! member surfaces are clearly-synthetic authored text and the keys are fixture
//! constants that never leave this crate.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::{
    HelperCapabilityLevel, HelperDiagnosticCode, HelperRedactionStatus, HelperResult, KaifuuResult,
    KeyMaterialKind, KeyValidationMethod, KeyValidationProof, OperationStatus, ProofHash,
    SecretRef, deterministic_id, redact_for_log_or_report,
    secret_holder::{SecretRefSecretResolver, ZeroizingSecretBytes},
    sha256_hash_bytes, stable_json,
};

use crate::xp3_crypt::{
    FixtureSecretResolver, KirikiriXp3Surface, Xp3CryptKey, Xp3CryptKeyExt, Xp3CryptoProfile,
    decrypt_members, encode_encrypted_xp3,
};
use crate::xp3_patch::{Xp3TextReplacement, apply_replacements};

/// Every typed error's `Display` starts here so an audit can pin the module.
pub const XP3_PRODUCTION_MARKER: &str = "kaifuu.kirikiri.xp3_production";

/// Schema version of the production registry + report.
pub const XP3_PRODUCTION_SCHEMA_VERSION: &str = "0.1.0";

/// Canonical capability id surfaced in the report.
pub const XP3_PRODUCTION_CAPABILITY_ID: &str = "kaifuu-kirikiri-xp3-production-extract-patch";

/// The engine family this driver is for.
pub const XP3_PRODUCTION_ENGINE_FAMILY: &str = "kirikiri";

/// The container this driver is for.
pub const XP3_PRODUCTION_CONTAINER: &str = "xp3";

/// The blunt support boundary carried in every report.
pub const XP3_PRODUCTION_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3 production extract+patch drives PROFILED crypt-scheme + helper-workflow variants on SYNTHETIC encrypted XP3 fixtures. A variant is DATA: a declared crypt-scheme profile (byte transform is a pure function of public scheme data) plus the required key/helper evidence (a secret REF, never a raw key, and a helper result for helper-gated variants). A profiled variant WITH its required evidence extracts its text surfaces and patches them back through the declared crypt + container (identity rebuild byte-identical; patched member carries the new text, every other member byte-identical). A CLAIMED variant that cannot extract+patch fails LOUD (typed ClaimedVariantFailed), never a silent skip; an unclaimed variant is an explicit out-of-scope row. The crypt scheme is DATA (engine-general, no per-game branch). Keys stay ref-only + zeroized; the report carries only requirement ids, refs, one-way hashes, and counts, and is deep no-leak-guarded before return. This is NOT commercial encrypted-XP3 coverage and the fixture crypt schemes are NOT real per-title CxDec/TVP filters.";

/// The key/helper workflow a profiled variant's key evidence must come through.
/// This is the *required evidence class* the variant declares — DATA, not a code
/// branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum Xp3HelperWorkflow {
    /// No helper: the key is resolved directly from a configured secret ref
    /// (e.g. a catalogued static key already available to the operator).
    None,
    /// The key must be supplied by a manual-entry helper: the operator entered
    /// the archive password locally. Requires a satisfied [`HelperResult`].
    ManualKeyEntry,
    /// The key must be imported from a known-key database helper. Requires a
    /// satisfied [`HelperResult`].
    KnownKeyImport,
}

impl Xp3HelperWorkflow {
    /// Stable label for reports.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ManualKeyEntry => "manual-key-entry",
            Self::KnownKeyImport => "known-key-import",
        }
    }

    /// Whether this workflow requires a corroborating helper result.
    #[must_use]
    pub fn requires_helper(self) -> bool {
        !matches!(self, Self::None)
    }
}

/// The stage at which a claimed variant failed (so the loud bug points at the
/// exact seam).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Xp3ProductionStage {
    /// Checking the variant's required key/helper evidence is present + adequate.
    EvidenceCheck,
    /// Resolving the decrypt key through the secret ref.
    KeyResolve,
    /// Decrypting + integrity-verifying the source members.
    Extract,
    /// The identity (no-change) rebuild byte-identical proof.
    Identity,
    /// Applying the trivial replacement(s).
    Patch,
    /// Re-decrypting + verifying the patched output.
    Verify,
}

impl Xp3ProductionStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::EvidenceCheck => "evidence-check",
            Self::KeyResolve => "key-resolve",
            Self::Extract => "extract",
            Self::Identity => "identity",
            Self::Patch => "patch",
            Self::Verify => "verify",
        }
    }
}

/// Fatal errors raised by the production extract+patch driver. Every variant's
/// `Display` begins with [`XP3_PRODUCTION_MARKER`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Xp3ProductionError {
    /// A variant the profile CLAIMS to support failed to extract + patch. This
    /// is a BUG, surfaced loudly — never a silent skip.
    #[error(
        "{XP3_PRODUCTION_MARKER}.claimed_variant_failed: claimed variant {variant_id} failed at \
         stage {stage} — {cause}"
    )]
    ClaimedVariantFailed {
        /// The claimed variant that failed.
        variant_id: String,
        /// The stage the failure occurred at.
        stage: &'static str,
        /// The (redacted) typed cause.
        cause: String,
    },
    /// An internal proof/serialization failure (redacted).
    #[error("{XP3_PRODUCTION_MARKER}.internal: {message}")]
    Internal {
        /// Redacted internal detail.
        message: String,
    },
}

impl Xp3ProductionError {
    fn claimed(variant_id: &str, stage: Xp3ProductionStage, cause: impl std::fmt::Display) -> Self {
        Self::ClaimedVariantFailed {
            variant_id: variant_id.to_string(),
            stage: stage.as_str(),
            cause: redact_for_log_or_report(&cause.to_string()),
        }
    }
}

/// One profiled XP3 crypt-scheme + helper-workflow variant. Everything here is
/// DATA: the driver runs the same code path for every variant.
/// The archive-key / resolved-key-evidence split models a real run: the
/// synthetic encrypted archive was enciphered with the fixture archive key
/// (ground truth), while the resolved key evidence is what the operator's
/// key/helper workflow actually produced. When they match and the helper
/// evidence is satisfied, the variant extracts + patches; when the operator's
/// evidence is missing/wrong, a CLAIMED variant fails loud.
/// # Secret discipline
/// The raw key material NEVER lives in a `pub`, `Debug`-deriving field. Both the
/// ground-truth archive key and the operator's resolved key evidence are held
/// ONLY inside the module-private, zeroize-on-drop, `Debug`-redacting
/// [`ZeroizingSecretBytes`] holder (required by [`Xp3ProductionVariant::new`]);
/// the fields are private and the manual [`std::fmt::Debug`] impl redacts them. The
/// non-secret fields (ids, crypt profile, surface, refs, helper workflow,
/// member surfaces, replacements, claim) stay public.
pub struct Xp3ProductionVariant {
    /// Stable variant id.
    pub variant_id: String,
    /// The declared crypt-scheme profile (selects the data-driven byte
    /// transform).
    pub crypto_profile: Xp3CryptoProfile,
    /// The extracted-content surface.
    pub surface: KirikiriXp3Surface,
    /// The secret **requirement** id (never a raw key).
    pub secret_requirement_id: String,
    /// The structured secret ref the decrypt key is published under.
    pub secret_ref: SecretRef,
    /// The required key/helper workflow.
    pub helper_workflow: Xp3HelperWorkflow,
    /// The corroborating helper result (required iff `helper_workflow`
    /// requires a helper).
    pub helper_evidence: Option<HelperResult>,
    /// Synthetic member surfaces `(archive path, authored plaintext)` the
    /// archive carries. Clearly-synthetic, never retail text.
    pub members: Vec<(String, String)>,
    /// The trivial replacement(s) the patch-back applies.
    pub replacements: Vec<Xp3TextReplacement>,
    /// Whether the profile CLAIMS to support this variant. A claimed variant
    /// MUST extract + patch (else a loud bug); an unclaimed variant is an
    /// explicit out-of-scope row.
    pub claimed: bool,
    /// The fixture archive key the synthetic container is enciphered with
    /// (ground truth). PRIVATE + confined to the zeroize-on-drop, `Debug`-
    /// redacting holder — never serialized, never `Debug`-loggable, never
    /// leaves [`Xp3CryptKey`].
    archive_key: Xp3CryptKey,
    /// The key material the operator's key/helper workflow actually resolved.
    /// `None` models "the required key evidence is absent"; a holder whose bytes
    /// differ from `archive_key` models a wrong resolved key. PRIVATE + confined
    /// to the zeroize-on-drop, `Debug`-redacting holder.
    resolved_key_evidence: Option<Xp3CryptKey>,
}

impl Xp3ProductionVariant {
    /// Construct a variant from already-confined secret holders.
    /// The XP3 production surface deliberately has no public raw-key
    /// constructor: callers must pass zeroize-on-drop [`ZeroizingSecretBytes`]
    /// holders that were minted by a secret-ref resolver. This keeps raw bytes
    /// out of the public variant API and forces the same holder discipline the
    /// decrypt path uses.
    #[expect(clippy::too_many_arguments)]
    #[must_use]
    pub fn new(
        variant_id: String,
        crypto_profile: Xp3CryptoProfile,
        surface: KirikiriXp3Surface,
        secret_requirement_id: String,
        secret_ref: SecretRef,
        helper_workflow: Xp3HelperWorkflow,
        helper_evidence: Option<HelperResult>,
        members: Vec<(String, String)>,
        replacements: Vec<Xp3TextReplacement>,
        claimed: bool,
        archive_key: ZeroizingSecretBytes,
        resolved_key_evidence: Option<ZeroizingSecretBytes>,
    ) -> Self {
        Self {
            variant_id,
            crypto_profile,
            surface,
            secret_requirement_id,
            secret_ref,
            helper_workflow,
            helper_evidence,
            members,
            replacements,
            claimed,
            archive_key,
            resolved_key_evidence,
        }
    }

    /// Replace (or clear) the operator's resolved key evidence. Any supplied
    /// key must already be confined to the zeroize-on-drop holder. Models a run
    /// where the resolved key is absent, wrong, or supplied.
    pub fn set_resolved_key_evidence(&mut self, key: Option<ZeroizingSecretBytes>) {
        self.resolved_key_evidence = key;
    }

    /// The declared expected member ids (in archive order).
    fn expected_member_ids(&self) -> Vec<String> {
        self.members.iter().map(|(id, _)| id.clone()).collect()
    }

    /// Does any registry-held key holder on this variant — the ground-truth
    /// `archive_key` OR the operator's `resolved_key_evidence` — appear as a
    /// contiguous window in `haystack`? Used by the production no-leak guard so
    /// registry-held bytes (claimed AND unclaimed variants) are covered, not
    /// just the resolver-held copies. Returns only a boolean; the raw bytes
    /// never leave the [`Xp3CryptKey`] holders.
    fn any_key_appears_in(&self, haystack: &[u8]) -> bool {
        self.archive_key.appears_in(haystack)
            || self
                .resolved_key_evidence
                .as_ref()
                .is_some_and(|key| key.appears_in(haystack))
    }
}

impl std::fmt::Debug for Xp3ProductionVariant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Manual redacting Debug: the archive key + resolved key evidence holders
        // already redact, but we never even reach into them here. No raw key
        // material can be formatted through this impl.
        formatter
            .debug_struct("Xp3ProductionVariant")
            .field("variant_id", &self.variant_id)
            .field("crypto_profile", &self.crypto_profile)
            .field("surface", &self.surface)
            .field("secret_requirement_id", &self.secret_requirement_id)
            .field("secret_ref", &self.secret_ref)
            .field("helper_workflow", &self.helper_workflow)
            .field("helper_evidence_present", &self.helper_evidence.is_some())
            .field("members", &self.members)
            .field("replacements", &self.replacements)
            .field("claimed", &self.claimed)
            .field("archive_key", &self.archive_key)
            .field(
                "resolved_key_evidence",
                &self
                    .resolved_key_evidence
                    .as_ref()
                    .map(|_| "[REDACTED:kaifuu.secret_redacted]"),
            )
            .finish()
    }
}

/// A registry of profiled variants the production driver runs.
/// Not `Clone`: a variant confines its key material to a non-`Clone`
/// zeroize-on-drop holder, so the registry (and its keys) is never duplicated.
#[derive(Debug)]
pub struct Xp3ProductionRegistry {
    /// Stable registry id.
    pub registry_id: String,
    /// The profiled variants.
    pub variants: Vec<Xp3ProductionVariant>,
}

/// The operation a member's delta records across the patch-back rebuild.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Xp3ProductionMemberOperation {
    /// The member's plaintext changed across the rebuild.
    Replace,
    /// The member's plaintext was byte-identical across the rebuild.
    Unchanged,
}

/// One member's hash-based delta (no raw plaintext).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProductionMemberDelta {
    /// The in-archive member id.
    pub member_id: String,
    /// Whether the member changed.
    pub operation: Xp3ProductionMemberOperation,
    /// sha-256 commitment to the source (pre-patch) plaintext.
    pub source_plaintext_hash: ProofHash,
    /// sha-256 commitment to the target (post-patch) plaintext.
    pub target_plaintext_hash: ProofHash,
    /// Byte-length delta (target - source).
    pub length_delta: i64,
}

impl Xp3ProductionMemberDelta {
    fn redacted_for_report(&self) -> Self {
        Self {
            member_id: redact_for_log_or_report(&self.member_id),
            operation: self.operation,
            source_plaintext_hash: self.source_plaintext_hash.clone(),
            target_plaintext_hash: self.target_plaintext_hash.clone(),
            length_delta: self.length_delta,
        }
    }
}

/// A claimed variant that extracted + patched successfully.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProductionVariantReport {
    /// The variant id.
    pub variant_id: String,
    /// The declared crypt-scheme profile.
    pub crypto_profile: Xp3CryptoProfile,
    /// The extracted-content surface.
    pub surface: KirikiriXp3Surface,
    /// The secret **requirement** id (never a raw key).
    pub secret_requirement_id: String,
    /// The structured secret ref the key was resolved through.
    pub secret_ref: SecretRef,
    /// The required key/helper workflow.
    pub helper_workflow: Xp3HelperWorkflow,
    /// Whether a corroborating helper result was consumed.
    pub helper_evidence_present: bool,
    /// Key material kind.
    pub key_material_kind: KeyMaterialKind,
    /// One-way sha-256 commitment to the resolved key (never the key).
    pub key_material_hash: ProofHash,
    /// Resolved key byte length (disclosed; the bytes are not).
    pub key_bytes: u32,
    /// sha-256 of the source encrypted container.
    pub source_container_hash: ProofHash,
    /// sha-256 of the rebuilt (patched) encrypted container.
    pub rebuilt_container_hash: ProofHash,
    /// The identity (no-change) rebuild was byte-identical to the source.
    pub identity_byte_identical: bool,
    /// Members in the archive.
    pub members_total: u32,
    /// Members the patch changed.
    pub members_patched: u32,
    /// Members that stayed byte-identical (plaintext) across the rebuild.
    pub members_byte_preserved: u32,
    /// Per-member hash-based deltas.
    pub members: Vec<Xp3ProductionMemberDelta>,
    /// A hash over the member deltas (proves this exact round-trip).
    pub round_trip_proof: KeyValidationProof,
    /// Always `Passed` on a returned report (a claimed failure aborts the run).
    pub status: OperationStatus,
}

impl Xp3ProductionVariantReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            variant_id: redact_for_log_or_report(&self.variant_id),
            crypto_profile: self.crypto_profile,
            surface: self.surface,
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            helper_workflow: self.helper_workflow,
            helper_evidence_present: self.helper_evidence_present,
            key_material_kind: self.key_material_kind,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            source_container_hash: self.source_container_hash.clone(),
            rebuilt_container_hash: self.rebuilt_container_hash.clone(),
            identity_byte_identical: self.identity_byte_identical,
            members_total: self.members_total,
            members_patched: self.members_patched,
            members_byte_preserved: self.members_byte_preserved,
            members: self
                .members
                .iter()
                .map(Xp3ProductionMemberDelta::redacted_for_report)
                .collect(),
            round_trip_proof: self.round_trip_proof.clone(),
            status: self.status.clone(),
        }
    }
}

/// An explicit out-of-scope row: a variant the profile does NOT claim. Recorded
/// (never silently dropped), never advanced to a claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProductionNotClaimedReport {
    /// The variant id.
    pub variant_id: String,
    /// The declared crypt-scheme profile.
    pub crypto_profile: Xp3CryptoProfile,
    /// The required key/helper workflow.
    pub helper_workflow: Xp3HelperWorkflow,
    /// A short, honest reason the variant is out of scope.
    pub reason: String,
}

impl Xp3ProductionNotClaimedReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            variant_id: redact_for_log_or_report(&self.variant_id),
            crypto_profile: self.crypto_profile,
            helper_workflow: self.helper_workflow,
            reason: redact_for_log_or_report(&self.reason),
        }
    }
}

/// One variant's outcome: either a claimed extract+patch report or an explicit
/// out-of-scope not-claimed row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Xp3ProductionOutcome {
    /// A claimed variant that extracted + patched.
    Claimed(Xp3ProductionVariantReport),
    /// An explicit out-of-scope variant.
    NotClaimed(Xp3ProductionNotClaimedReport),
}

impl Xp3ProductionOutcome {
    fn redacted_for_report(&self) -> Self {
        match self {
            Self::Claimed(report) => Self::Claimed(report.redacted_for_report()),
            Self::NotClaimed(report) => Self::NotClaimed(report.redacted_for_report()),
        }
    }
}

/// The full production extract+patch report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProductionReport {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// Registry id.
    pub registry_id: String,
    /// Engine family (`kirikiri`).
    pub engine_family: String,
    /// Container (`xp3`).
    pub container: String,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// Distinct crypt-scheme profiles claimed + round-tripped (proves the path
    /// is engine-general across ≥2 schemes from data alone).
    pub claimed_profiles: Vec<Xp3CryptoProfile>,
    /// How many variants were claimed + round-tripped.
    pub claimed_count: u32,
    /// How many variants were explicit out-of-scope rows.
    pub not_claimed_count: u32,
    /// Per-variant outcomes, in registry order.
    pub outcomes: Vec<Xp3ProductionOutcome>,
    /// Overall status.
    pub status: OperationStatus,
}

impl Xp3ProductionReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: self.capability_id.clone(),
            source_node_id: self.source_node_id.clone(),
            support_boundary: self.support_boundary.clone(),
            registry_id: redact_for_log_or_report(&self.registry_id),
            engine_family: self.engine_family.clone(),
            container: self.container.clone(),
            redaction_status: self.redaction_status,
            claimed_profiles: self.claimed_profiles.clone(),
            claimed_count: self.claimed_count,
            not_claimed_count: self.not_claimed_count,
            outcomes: self
                .outcomes
                .iter()
                .map(Xp3ProductionOutcome::redacted_for_report)
                .collect(),
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no plaintext).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    /// True when every claimed variant round-tripped.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }
}

/// Run the production extract+patch over a profiled-variant registry.
/// Each claimed variant is extracted + patched through its declared crypt scheme
/// and required key/helper evidence; a claimed variant that cannot do so aborts
/// the run with a loud [`Xp3ProductionError::ClaimedVariantFailed`]. Unclaimed
/// variants are recorded as explicit out-of-scope rows. The serialized report is
/// deep no-leak-guarded before it is returned.
pub fn run_xp3_production(
    registry: &Xp3ProductionRegistry,
    source_node_id: &str,
) -> Result<Xp3ProductionReport, Xp3ProductionError> {
    let mut outcomes = Vec::with_capacity(registry.variants.len());
    let mut claimed_profiles: Vec<Xp3CryptoProfile> = Vec::new();
    let mut claimed_count = 0u32;
    let mut not_claimed_count = 0u32;
    // The per-variant resolvers (each owning its resolved-key holder) are held
    // only long enough to run the no-leak guard, then dropped (each holder
    // zeroizes on drop).
    let mut resolvers: Vec<FixtureSecretResolver> = Vec::new();

    for variant in &registry.variants {
        if !variant.claimed {
            not_claimed_count += 1;
            outcomes.push(Xp3ProductionOutcome::NotClaimed(
                Xp3ProductionNotClaimedReport {
                    variant_id: variant.variant_id.clone(),
                    crypto_profile: variant.crypto_profile,
                    helper_workflow: variant.helper_workflow,
                    reason:
                        "variant is not claimed by the profile (out of scope; retail beyond the \
                             bounded profiled evidence)"
                            .to_string(),
                },
            ));
            continue;
        }

        let (report, resolver) = run_claimed_variant(variant)?;
        if !claimed_profiles.contains(&variant.crypto_profile) {
            claimed_profiles.push(variant.crypto_profile);
        }
        claimed_count += 1;
        resolvers.push(resolver);
        outcomes.push(Xp3ProductionOutcome::Claimed(report));
    }

    let report = Xp3ProductionReport {
        schema_version: XP3_PRODUCTION_SCHEMA_VERSION.to_string(),
        capability_id: XP3_PRODUCTION_CAPABILITY_ID.to_string(),
        source_node_id: source_node_id.to_string(),
        support_boundary: XP3_PRODUCTION_SUPPORT_BOUNDARY.to_string(),
        registry_id: registry.registry_id.clone(),
        engine_family: XP3_PRODUCTION_ENGINE_FAMILY.to_string(),
        container: XP3_PRODUCTION_CONTAINER.to_string(),
        redaction_status: HelperRedactionStatus::Redacted,
        claimed_profiles,
        claimed_count,
        not_claimed_count,
        outcomes,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // any raw key material. The guard scans EVERY key-holding source — confined
    // to the zeroize-on-drop holders — against the serialized report, not just
    // the report's own fields. A hard refusal, not just a test-time check.
    // It covers (a) the resolver-held resolved-key copies for each claimed
    // variant, AND (b) every registry-held holder on EVERY variant in the
    // registry — each variant's ground-truth `archive_key` and its
    // `resolved_key_evidence`, for CLAIMED and UNCLAIMED variants alike. An
    // unclaimed variant never enters a resolver, so without (b) its registry-
    // held archive key could reach the report unguarded.
    let json = report
        .stable_json()
        .map_err(|error| Xp3ProductionError::Internal {
            message: error.to_string(),
        })?;
    let bytes = json.as_bytes();
    let resolver_leak = resolvers
        .iter()
        .any(|resolver| resolver.any_key_appears_in(bytes));
    let registry_leak = registry
        .variants
        .iter()
        .any(|variant| variant.any_key_appears_in(bytes));
    if resolver_leak || registry_leak {
        return Err(Xp3ProductionError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Run one claimed variant's extract → patch round-trip. Returns the per-variant
/// report and the resolver holding the resolved-key holder (so the caller can
/// run the no-leak guard against the serialized report before the holder
/// drops/zeroizes).
fn run_claimed_variant(
    variant: &Xp3ProductionVariant,
) -> Result<(Xp3ProductionVariantReport, FixtureSecretResolver), Xp3ProductionError> {
    let id = variant.variant_id.as_str();
    let scheme = variant.crypto_profile.scheme();

    // (0) Build the synthetic encrypted archive from the fixture ARCHIVE key
    // (ground truth: the bytes that actually enciphered the archive).
    let members: Vec<(String, Vec<u8>)> = variant
        .members
        .iter()
        .map(|(path, text)| (path.clone(), text.as_bytes().to_vec()))
        .collect();
    if members.is_empty() {
        return Err(Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::EvidenceCheck,
            "variant declares no member surfaces to extract",
        ));
    }
    // The ground-truth archive key is already confined to the variant's holder.
    let source_container = encode_encrypted_xp3(&members, &variant.archive_key, scheme);

    // (1) EVIDENCE CHECK: the required key/helper evidence must be present +
    // adequate. A missing/inadequate leg for a CLAIMED variant is a loud bug.
    let resolved_key = variant.resolved_key_evidence.as_ref().ok_or_else(|| {
        Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::EvidenceCheck,
            "required key evidence is absent (no resolved key for the declared secret ref)",
        )
    })?;
    check_helper_evidence(variant).map_err(|cause| {
        Xp3ProductionError::claimed(id, Xp3ProductionStage::EvidenceCheck, cause)
    })?;

    // (2) KEY RESOLVE: bind the declared secret ref to the resolved key evidence
    // HOLDER and resolve through the ref (proves the ref path; the material
    // never leaves an [`Xp3CryptKey`]). The archive key never enters the
    // resolver. The resolver owns the resolved-key holder and is returned so
    // the caller can run the no-leak guard before it drops/zeroizes.
    let resolver = FixtureSecretResolver::from_key_refs(vec![(
        variant.secret_ref.as_str().to_string(),
        resolved_key,
    )]);
    let key = resolver
        .resolve(&variant.secret_requirement_id, &variant.secret_ref)
        .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::KeyResolve, error))?;

    // (3) EXTRACT: decrypt + integrity-verify every member. A wrong resolved key
    // trips the adlr integrity check → a loud claimed failure.
    let source_members: Vec<(String, Vec<u8>)> = decrypt_members(&source_container, key, scheme)
        .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::Extract, error))?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();

    let extracted_ids: Vec<String> = source_members.iter().map(|(id, _)| id.clone()).collect();
    if extracted_ids != variant.expected_member_ids() {
        return Err(Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::Extract,
            "extracted member set did not match the declared surfaces",
        ));
    }

    // (4) IDENTITY: rebuild(extract(x)) with no change must be byte-identical.
    let identity_rebuilt = encode_encrypted_xp3(&source_members, key, scheme);
    let identity_byte_identical = identity_rebuilt == source_container;
    if !identity_byte_identical {
        return Err(Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::Identity,
            "identity rebuild diverged from the source (encode not byte-preserving)",
        ));
    }

    // (5) PATCH: apply the variant's trivial replacement(s) + repack.
    let (patched_members, changed_ids) =
        apply_replacements(&source_members, &patch_manifest(variant))
            .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::Patch, error))?;
    if changed_ids.is_empty() {
        return Err(Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::Patch,
            "variant declared no applicable replacement",
        ));
    }
    let rebuilt_container = encode_encrypted_xp3(&patched_members, key, scheme);

    // (6) VERIFY: re-decrypt the rebuilt container through the SAME ref and prove
    // the patched text is present, the old text gone, and every other member
    // byte-identical.
    let rebuilt_members: Vec<(String, Vec<u8>)> = decrypt_members(&rebuilt_container, key, scheme)
        .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::Verify, error))?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();

    verify_patch_isolation(variant, &source_members, &rebuilt_members)
        .map_err(|cause| Xp3ProductionError::claimed(id, Xp3ProductionStage::Verify, cause))?;

    // (7) Assemble the hash-based per-member deltas + report.
    let mut member_deltas = Vec::with_capacity(source_members.len());
    let mut proof_material = Vec::new();
    let mut members_patched = 0u32;
    for (member_id, source_plain) in &source_members {
        let target_plain = rebuilt_members
            .iter()
            .find(|(id, _)| id == member_id)
            .map(|(_, plain)| plain)
            .ok_or_else(|| Xp3ProductionError::Internal {
                message: "rebuilt member set dropped a source member".to_string(),
            })?;
        let source_hash = proof_hash(source_plain)?;
        let target_hash = proof_hash(target_plain)?;
        let operation = if source_hash.as_str() == target_hash.as_str() {
            Xp3ProductionMemberOperation::Unchanged
        } else {
            members_patched += 1;
            Xp3ProductionMemberOperation::Replace
        };
        proof_material.extend_from_slice(member_id.as_bytes());
        proof_material.extend_from_slice(source_hash.as_str().as_bytes());
        proof_material.extend_from_slice(target_hash.as_str().as_bytes());
        member_deltas.push(Xp3ProductionMemberDelta {
            member_id: member_id.clone(),
            operation,
            source_plaintext_hash: source_hash,
            target_plaintext_hash: target_hash,
            length_delta: target_plain.len() as i64 - source_plain.len() as i64,
        });
    }

    let members_total = u32::try_from(source_members.len()).unwrap_or(u32::MAX);
    let report = Xp3ProductionVariantReport {
        variant_id: variant.variant_id.clone(),
        crypto_profile: variant.crypto_profile,
        surface: variant.surface,
        secret_requirement_id: variant.secret_requirement_id.clone(),
        secret_ref: variant.secret_ref.clone(),
        helper_workflow: variant.helper_workflow,
        helper_evidence_present: variant.helper_evidence.is_some(),
        key_material_kind: KeyMaterialKind::FixedBytes,
        key_material_hash: key
            .material_hash()
            .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::Verify, error))?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        source_container_hash: proof_hash(&source_container)?,
        rebuilt_container_hash: proof_hash(&rebuilt_container)?,
        identity_byte_identical,
        members_total,
        members_patched,
        members_byte_preserved: members_total.saturating_sub(members_patched),
        members: member_deltas,
        round_trip_proof: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: proof_hash(&proof_material)?,
        },
        status: OperationStatus::Passed,
    };

    Ok((report, resolver))
}

/// Check the variant's required helper evidence is present and adequate. Only
/// helper-gated workflows require a helper result; when one is required it must
/// reference the EXACT `variant.secret_ref` (bound to the variant's requirement
/// id), carry a non-blocking diagnostic (a resolved key, not
/// `missing_key`/`helper_required`/etc.), pass validation, and meet
/// the workflow's minimum capability level. A helper result for the right
/// requirement id but a DIFFERENT secret ref does NOT satisfy the gate.
fn check_helper_evidence(variant: &Xp3ProductionVariant) -> Result<(), String> {
    if !variant.helper_workflow.requires_helper() {
        return Ok(());
    }
    let helper = variant.helper_evidence.as_ref().ok_or_else(|| {
        format!(
            "helper workflow {} requires a helper result but none was supplied",
            variant.helper_workflow.as_str()
        )
    })?;

    let validation = helper.validate();
    if validation.status == OperationStatus::Failed {
        return Err(format!(
            "helper result failed validation ({} failure(s))",
            validation.failures.len()
        ));
    }

    if helper.diagnostic.code != HelperDiagnosticCode::Success {
        return Err(format!(
            "helper result diagnostic is {:?}, not a resolved key (required evidence not satisfied)",
            helper.diagnostic.code
        ));
    }

    // Bind the helper evidence to the EXACT secret ref the variant will resolve
    // its key through — not merely to the requirement id. A helper result for the
    // right requirement id but a WRONG ref must NOT satisfy the helper-gated path
    // (the key bytes are resolved independently through `variant.secret_ref`, so
    // a mismatched helper ref is evidence for the wrong secret).
    let binds_secret_ref = helper.secret_refs.iter().any(|secret| {
        secret.requirement_id == variant.secret_requirement_id
            && secret.secret_ref == variant.secret_ref
    });
    if !binds_secret_ref {
        return Err(format!(
            "helper result carries no secretRef bound to the variant's requirement id + secret ref \
             {} (a helper result for a different ref does not satisfy the gate)",
            variant.secret_ref.as_str()
        ));
    }

    let minimum = minimum_capability(variant.helper_workflow);
    if helper.capability_level < minimum {
        return Err(format!(
            "helper capability level {:?} is below the {:?} required by workflow {}",
            helper.capability_level,
            minimum,
            variant.helper_workflow.as_str()
        ));
    }
    Ok(())
}

fn minimum_capability(workflow: Xp3HelperWorkflow) -> HelperCapabilityLevel {
    match workflow {
        Xp3HelperWorkflow::None | Xp3HelperWorkflow::KnownKeyImport => {
            HelperCapabilityLevel::LocalKeyImport
        }
        Xp3HelperWorkflow::ManualKeyEntry => HelperCapabilityLevel::ManualEntry,
    }
}

/// Build the trivial-replacement patch manifest for a variant (its declared
/// replacements) so it can reuse the proven [`apply_replacements`] path.
fn patch_manifest(variant: &Xp3ProductionVariant) -> crate::xp3_patch::Xp3PatchManifest {
    crate::xp3_patch::Xp3PatchManifest {
        schema_version: crate::xp3_patch::XP3_PATCH_SCHEMA_VERSION.to_string(),
        manifest_id: format!("{}-production-patch", variant.variant_id),
        source_node_id: "xp3-production".to_string(),
        replacements: variant.replacements.clone(),
    }
}

/// Prove the patch was applied and isolated: each replacement's new text is
/// present + old text absent in the rebuilt member, and every member the
/// manifest did not touch is byte-identical across the rebuild.
fn verify_patch_isolation(
    variant: &Xp3ProductionVariant,
    source_members: &[(String, Vec<u8>)],
    rebuilt_members: &[(String, Vec<u8>)],
) -> Result<(), String> {
    let patched_ids: Vec<&str> = variant
        .replacements
        .iter()
        .map(|replacement| replacement.member_id.as_str())
        .collect();

    for replacement in &variant.replacements {
        let rebuilt = find_member(rebuilt_members, &replacement.member_id).ok_or_else(|| {
            format!(
                "patched member {} missing from rebuild",
                replacement.member_id
            )
        })?;
        let rebuilt_text = String::from_utf8_lossy(rebuilt);
        if !rebuilt_text.contains(&replacement.replace) {
            return Err(format!(
                "patched member {} does not carry the new text",
                replacement.member_id
            ));
        }
        if rebuilt_text.contains(&replacement.find) {
            return Err(format!(
                "patched member {} still carries the old text",
                replacement.member_id
            ));
        }
    }

    for (member_id, source_plain) in source_members {
        if patched_ids.contains(&member_id.as_str()) {
            continue;
        }
        let rebuilt = find_member(rebuilt_members, member_id)
            .ok_or_else(|| format!("member {member_id} missing from rebuild"))?;
        if rebuilt != source_plain.as_slice() {
            return Err(format!(
                "unpatched member {member_id} was not byte-identical across the rebuild"
            ));
        }
    }
    Ok(())
}

fn find_member<'a>(members: &'a [(String, Vec<u8>)], member_id: &str) -> Option<&'a [u8]> {
    members
        .iter()
        .find(|(id, _)| id == member_id)
        .map(|(_, bytes)| bytes.as_slice())
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, Xp3ProductionError> {
    ProofHash::new(sha256_hash_bytes(bytes))
        .map_err(|message| Xp3ProductionError::Internal { message })
}

fn private_fixture_secret_holder(secret_ref: &SecretRef, bytes: Vec<u8>) -> ZeroizingSecretBytes {
    SecretRefSecretResolver::from_entries(vec![(secret_ref.as_str().to_string(), bytes)])
        .into_resolved(secret_ref)
        .expect("newly inserted production fixture key must resolve by its SecretRef")
}

/// Deterministic synthetic builders. No corpus bytes, no retail names, no real
/// keys — only clearly-synthetic authored surfaces + obviously-fake fixture
/// keys, and public secret **refs**.
pub mod synthetic {
    use super::{
        Xp3HelperWorkflow, Xp3ProductionRegistry, Xp3ProductionVariant, deterministic_id,
        private_fixture_secret_holder,
    };
    use crate::xp3_crypt::{KirikiriXp3Surface, Xp3CryptoProfile};
    use crate::xp3_patch::Xp3TextReplacement;
    use kaifuu_core::{
        HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic,
        HelperDiagnosticCode, HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind,
        HelperProvenance, HelperRedaction, HelperRedactionStatus, HelperResult,
        HelperResultExecutionMode, HelperResultSecretRef, KeyMaterialKind, KeyValidationMethod,
        KeyValidationProof, ProofHash, SecretRef,
    };

    fn proof_hash(byte: u8) -> ProofHash {
        ProofHash::new(format!("sha256:{}", format!("{byte:02x}").repeat(32)))
            .expect("synthetic proof hash is valid")
    }

    /// A satisfied manual-key-entry helper result referencing `requirement_id`.
    #[must_use]
    pub fn satisfied_manual_entry_helper(
        requirement_id: &str,
        secret_ref: &SecretRef,
    ) -> HelperResult {
        HelperResult {
            schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
            fixture_id: "kaifuu-k057-xp3-manual-entry-helper".to_string(),
            helper_result_id: "helper-result/kaifuu/k057/xp3/manual-entry".to_string(),
            profile_id: "019ed057-0000-7000-8000-0000000a5701".to_string(),
            helper: HelperProvenance {
                helper_id: "kaifuu.fixture.manual-entry".to_string(),
                helper_version: "0.1.0".to_string(),
                helper_kind: HelperKind::ManualKeyEntry,
            },
            capability_level: HelperCapabilityLevel::ManualEntry,
            execution: HelperExecutionSummary {
                // ManualKeyEntry is a not-executed (operator-supplied) path.
                mode: HelperResultExecutionMode::NotExecuted,
                platform: "fixture-local".to_string(),
                bounded: true,
                timeout_ms: 1000,
                duration_ms: Some(0),
                network_access: false,
                filesystem_access: HelperExecutionFilesystemAccess::None,
            },
            diagnostic: HelperDiagnostic {
                code: HelperDiagnosticCode::Success,
                message: "synthetic manual key entry resolved the archive password".to_string(),
            },
            redaction: HelperRedaction {
                status: HelperRedactionStatus::Redacted,
                redacted_log_hash: proof_hash(0x57),
            },
            secret_refs: vec![HelperResultSecretRef {
                requirement_id: requirement_id.to_string(),
                secret_ref: secret_ref.clone(),
                material_kind: KeyMaterialKind::ArchivePassword,
                bytes: None,
                validation: None,
            }],
            // A Success diagnostic must carry at least one validation proof.
            proof_hashes: vec![KeyValidationProof {
                method: KeyValidationMethod::ArchiveIndexProof,
                proof_hash: proof_hash(0x58),
            }],
        }
    }

    /// The canonical synthetic production registry: two claimed variants across
    /// two distinct crypt schemes (one direct-key, one manual-entry-helper-gated)
    /// plus one explicit out-of-scope not-claimed variant.
    #[must_use]
    pub fn production_registry() -> Xp3ProductionRegistry {
        // Variant A: XorSimpleCryptFixture, direct key (no helper).
        let a_requirement = "kaifuu-k057-xp3-simple-key".to_string();
        let a_ref = SecretRef::new("local-secret:kaifuu/k057/xp3-simple-crypt-key")
            .expect("synthetic secret ref is valid");
        let a_archive_key = private_fixture_secret_holder(&a_ref, b"K057-XP3-SIMPLEKEY01".to_vec());
        let a_resolved_key =
            private_fixture_secret_holder(&a_ref, b"K057-XP3-SIMPLEKEY01".to_vec());
        let variant_a = Xp3ProductionVariant::new(
            "kaifuu-k057-xp3-simple-crypt".to_string(),
            Xp3CryptoProfile::XorSimpleCryptFixture,
            KirikiriXp3Surface::ScenarioScript,
            a_requirement.clone(),
            a_ref.clone(),
            Xp3HelperWorkflow::None,
            None,
            vec![
                (
                    "scenario/opening.ks".to_string(),
                    "*start\n#Narrator\n[synthetic-k057-simple-line-0]\n@wait time=200\n"
                        .to_string(),
                ),
                (
                    "system/config.txt".to_string(),
                    "[synthetic-k057-simple-config]\nwindow=default\n".to_string(),
                ),
            ],
            vec![Xp3TextReplacement {
                member_id: "scenario/opening.ks".to_string(),
                find: "[synthetic-k057-simple-line-0]".to_string(),
                replace: "[localized-k057-simple-line-0-JA-longer]".to_string(),
            }],
            true,
            a_archive_key,
            Some(a_resolved_key),
        );

        // Variant B: XorPositionCryptFixture, manual-entry-helper-gated key.
        let b_requirement = "kaifuu-k057-xp3-position-key".to_string();
        let b_ref = SecretRef::new("prompt:kaifuu/k057/xp3-position-archive-password")
            .expect("synthetic secret ref is valid");
        let b_archive_key =
            private_fixture_secret_holder(&b_ref, b"K057-XP3-POSITIONKEY02".to_vec());
        let b_resolved_key =
            private_fixture_secret_holder(&b_ref, b"K057-XP3-POSITIONKEY02".to_vec());
        let variant_b = Xp3ProductionVariant::new(
            "kaifuu-k057-xp3-position-crypt".to_string(),
            Xp3CryptoProfile::XorPositionCryptFixture,
            KirikiriXp3Surface::ScenarioScript,
            b_requirement.clone(),
            b_ref.clone(),
            Xp3HelperWorkflow::ManualKeyEntry,
            Some(satisfied_manual_entry_helper(&b_requirement, &b_ref)),
            vec![
                (
                    "scenario/route_a.ks".to_string(),
                    "*route_a\n#Heroine\n[synthetic-k057-position-line-0]\n@wait time=120\n"
                        .to_string(),
                ),
                (
                    "scenario/route_b.ks".to_string(),
                    "*route_b\n#Heroine\n[synthetic-k057-position-line-1]\n".to_string(),
                ),
                (
                    "system/scn.txt".to_string(),
                    "[synthetic-k057-position-scn]\nmode=adv\n".to_string(),
                ),
            ],
            vec![Xp3TextReplacement {
                member_id: "scenario/route_a.ks".to_string(),
                find: "[synthetic-k057-position-line-0]".to_string(),
                replace: "[localized-k057-position-line-0-JA]".to_string(),
            }],
            true,
            b_archive_key,
            Some(b_resolved_key),
        );

        // Variant C: explicitly NOT claimed — a research-tier scheme the profile
        // does not advance to a claim (out of scope).
        let c_ref = SecretRef::new("local-secret:kaifuu/k057/xp3-research-only")
            .expect("synthetic secret ref is valid");
        let c_archive_key =
            private_fixture_secret_holder(&c_ref, b"K057-XP3-RESEARCHKEY0".to_vec());
        let variant_c = Xp3ProductionVariant::new(
            "kaifuu-k057-xp3-research-only".to_string(),
            Xp3CryptoProfile::XorSimpleCryptFixture,
            KirikiriXp3Surface::ScenarioScript,
            "kaifuu-k057-xp3-research-key".to_string(),
            c_ref,
            Xp3HelperWorkflow::KnownKeyImport,
            None,
            vec![(
                "scenario/unknown.ks".to_string(),
                "[synthetic-k057-research-line]\n".to_string(),
            )],
            vec![],
            false,
            c_archive_key,
            None,
        );

        Xp3ProductionRegistry {
            registry_id: deterministic_id("kaifuu-k057-xp3-production-registry", 1),
            variants: vec![variant_a, variant_b, variant_c],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Xp3ProductionRegistry {
        synthetic::production_registry()
    }

    #[test]
    fn profiled_variants_extract_and_patch_round_trip() {
        let report =
            run_xp3_production(&registry(), "xp3-production").expect("production run passes");
        assert!(report.is_ok());
        assert_eq!(report.claimed_count, 2);
        assert_eq!(report.not_claimed_count, 1);

        // Engine-general: ≥2 DISTINCT crypt schemes were claimed + round-tripped
        // purely from data, no per-game branch.
        assert!(
            report
                .claimed_profiles
                .contains(&Xp3CryptoProfile::XorSimpleCryptFixture)
        );
        assert!(
            report
                .claimed_profiles
                .contains(&Xp3CryptoProfile::XorPositionCryptFixture)
        );

        // Every claimed outcome proved identity byte-identical + a real patch.
        let claimed: Vec<&Xp3ProductionVariantReport> = report
            .outcomes
            .iter()
            .filter_map(|outcome| match outcome {
                Xp3ProductionOutcome::Claimed(report) => Some(report),
                Xp3ProductionOutcome::NotClaimed(_) => None,
            })
            .collect();
        assert_eq!(claimed.len(), 2);
        for variant in &claimed {
            assert_eq!(variant.status, OperationStatus::Passed);
            assert!(variant.identity_byte_identical);
            assert_eq!(variant.members_patched, 1);
            assert_ne!(
                variant.source_container_hash.as_str(),
                variant.rebuilt_container_hash.as_str()
            );
            // The changed member records a non-zero length delta.
            let changed = variant
                .members
                .iter()
                .find(|m| m.operation == Xp3ProductionMemberOperation::Replace)
                .expect("one member changed");
            assert_ne!(changed.length_delta, 0);
        }

        // The manual-entry variant consumed helper evidence.
        let position = claimed
            .iter()
            .find(|v| v.crypto_profile == Xp3CryptoProfile::XorPositionCryptFixture)
            .expect("position variant present");
        assert_eq!(position.helper_workflow, Xp3HelperWorkflow::ManualKeyEntry);
        assert!(position.helper_evidence_present);
    }

    #[test]
    fn unclaimed_variant_is_explicit_out_of_scope_not_a_silent_skip() {
        let report =
            run_xp3_production(&registry(), "xp3-production").expect("production run passes");
        let not_claimed: Vec<&Xp3ProductionNotClaimedReport> = report
            .outcomes
            .iter()
            .filter_map(|outcome| match outcome {
                Xp3ProductionOutcome::NotClaimed(report) => Some(report),
                Xp3ProductionOutcome::Claimed(_) => None,
            })
            .collect();
        assert_eq!(not_claimed.len(), 1);
        assert_eq!(not_claimed[0].variant_id, "kaifuu-k057-xp3-research-only");
        assert!(not_claimed[0].reason.contains("not claimed"));
    }

    #[test]
    fn claimed_variant_missing_key_evidence_fails_loud() {
        // A claimed variant whose required key evidence is absent must be a BUG,
        // not a silent skip.
        let mut registry = registry();
        registry.variants[0].set_resolved_key_evidence(None);
        let err = run_xp3_production(&registry, "xp3-production")
            .expect_err("missing key evidence is a bug");
        match err {
            Xp3ProductionError::ClaimedVariantFailed {
                variant_id, stage, ..
            } => {
                assert_eq!(variant_id, "kaifuu-k057-xp3-simple-crypt");
                assert_eq!(stage, "evidence-check");
            }
            other @ Xp3ProductionError::Internal { .. } => {
                panic!("expected ClaimedVariantFailed, got {other}")
            }
        }
    }

    #[test]
    fn claimed_variant_missing_helper_evidence_fails_loud() {
        // A helper-gated claimed variant whose helper result is absent is a bug.
        let mut registry = registry();
        registry.variants[1].helper_evidence = None;
        let err = run_xp3_production(&registry, "xp3-production")
            .expect_err("missing helper evidence is a bug");
        match err {
            Xp3ProductionError::ClaimedVariantFailed {
                variant_id, stage, ..
            } => {
                assert_eq!(variant_id, "kaifuu-k057-xp3-position-crypt");
                assert_eq!(stage, "evidence-check");
            }
            other @ Xp3ProductionError::Internal { .. } => {
                panic!("expected ClaimedVariantFailed, got {other}")
            }
        }
    }

    #[test]
    fn claimed_variant_wrong_key_evidence_fails_loud_on_integrity() {
        // A claimed variant whose resolved key does not match the archive key
        // trips the adlr integrity check — a loud bug at the extract stage, never
        // a silent pass.
        let mut registry = registry();
        let secret_ref = registry.variants[0].secret_ref.clone();
        registry.variants[0].set_resolved_key_evidence(Some(private_fixture_secret_holder(
            &secret_ref,
            b"K057-XP3-WRONGKEY0000".to_vec(),
        )));
        let err = run_xp3_production(&registry, "xp3-production")
            .expect_err("wrong key evidence is a bug");
        match err {
            Xp3ProductionError::ClaimedVariantFailed {
                variant_id, stage, ..
            } => {
                assert_eq!(variant_id, "kaifuu-k057-xp3-simple-crypt");
                assert_eq!(stage, "extract");
            }
            other @ Xp3ProductionError::Internal { .. } => {
                panic!("expected ClaimedVariantFailed, got {other}")
            }
        }
    }

    #[test]
    fn claimed_variant_unsatisfied_helper_fails_loud() {
        // A helper result that reports missing_key (not a resolved key) does NOT
        // satisfy the required evidence → loud bug.
        let mut registry = registry();
        if let Some(helper) = registry.variants[1].helper_evidence.as_mut() {
            helper.diagnostic.code = HelperDiagnosticCode::MissingKey;
        }
        let err = run_xp3_production(&registry, "xp3-production")
            .expect_err("unsatisfied helper evidence is a bug");
        assert!(matches!(
            err,
            Xp3ProductionError::ClaimedVariantFailed { stage, .. } if stage == "evidence-check"
        ));
    }

    #[test]
    fn report_carries_no_raw_key_and_no_plaintext() {
        let report =
            run_xp3_production(&registry(), "xp3-production").expect("production run passes");
        let json = report.stable_json().expect("stable json");

        // No resolved/archive raw key material appears (any variant).
        for key in [
            "K057-XP3-SIMPLEKEY01",
            "K057-XP3-POSITIONKEY02",
            "K057-XP3-RESEARCHKEY0",
        ] {
            assert!(!json.contains(key), "raw key {key} leaked into the report");
        }
        // No member plaintext (old or new synthetic text) appears verbatim.
        for needle in [
            "[synthetic-k057-simple-line-0]",
            "[localized-k057-simple-line-0-JA-longer]",
            "[synthetic-k057-position-line-0]",
            "[localized-k057-position-line-0-JA]",
        ] {
            assert!(
                !json.contains(needle),
                "plaintext {needle} leaked into the report"
            );
        }
        // The secret REFS (safe) are disclosed.
        assert!(json.contains("local-secret:kaifuu/k057/xp3-simple-crypt-key"));
        assert!(json.contains("prompt:kaifuu/k057/xp3-position-archive-password"));
    }

    #[test]
    fn run_is_reproducible() {
        let a = run_xp3_production(&registry(), "xp3-production")
            .unwrap()
            .stable_json()
            .unwrap();
        let b = run_xp3_production(&registry(), "xp3-production")
            .unwrap()
            .stable_json()
            .unwrap();
        assert_eq!(a, b, "production report is deterministic");
    }

    /// The raw fixture key bytes carried by the synthetic registry. Used to prove
    /// none of them can ever be formatted through `Debug`, and that they are
    /// confined to the zeroize-on-drop holders (never a `pub`/`Debug` field).
    const RAW_KEYS: [&str; 3] = [
        "K057-XP3-SIMPLEKEY01",
        "K057-XP3-POSITIONKEY02",
        "K057-XP3-RESEARCHKEY0",
    ];

    #[test]
    fn variant_debug_never_emits_raw_key_bytes() {
        // P1(a): the variant holds the archive key + resolved key evidence ONLY
        // inside the module-private, Debug-redacting Xp3CryptKey holder. Its
        // manual Debug must never render any raw key material — not even for a
        // variant whose resolved evidence is present. `{:#?}` (pretty) too.
        let registry = registry();
        for variant in &registry.variants {
            for rendered in [format!("{variant:?}"), format!("{variant:#?}")] {
                for key in RAW_KEYS {
                    assert!(
                        !rendered.contains(key),
                        "variant Debug leaked raw key {key}"
                    );
                }
                assert!(
                    rendered.contains("REDACTED"),
                    "variant Debug should mark redaction"
                );
                // The non-secret ids ARE shown (proves Debug is still useful).
                assert!(rendered.contains("variant_id"));
            }
        }
    }

    #[test]
    fn registry_debug_never_emits_raw_key_bytes() {
        // The whole registry (which owns every variant's key holders) must not
        // emit any raw key material through Debug either.
        let registry = registry();
        for rendered in [format!("{registry:?}"), format!("{registry:#?}")] {
            for key in RAW_KEYS {
                assert!(
                    !rendered.contains(key),
                    "registry Debug leaked raw key {key}"
                );
            }
        }
    }

    #[test]
    fn resolver_debug_never_emits_raw_key_bytes() {
        // P1(b): the FixtureSecretResolver stores each key in the zeroize-on-drop
        // Xp3CryptKey holder and has a manual redacting Debug. Building a resolver
        // over the synthetic keys and formatting it must never emit key bytes,
        let a_ref = SecretRef::new("local-secret:kaifuu/k057/xp3-simple-crypt-key").unwrap();
        let b_ref = SecretRef::new("prompt:kaifuu/k057/xp3-position-archive-password").unwrap();
        let a_key = private_fixture_secret_holder(&a_ref, b"K057-XP3-SIMPLEKEY01".to_vec());
        let b_key = private_fixture_secret_holder(&b_ref, b"K057-XP3-POSITIONKEY02".to_vec());
        let resolver = FixtureSecretResolver::from_key_refs(vec![
            (a_ref.as_str().to_string(), &a_key),
            (b_ref.as_str().to_string(), &b_key),
        ]);
        for rendered in [format!("{resolver:?}"), format!("{resolver:#?}")] {
            for key in ["K057-XP3-SIMPLEKEY01", "K057-XP3-POSITIONKEY02"] {
                assert!(
                    !rendered.contains(key),
                    "resolver Debug leaked raw key {key}"
                );
            }
            assert!(
                rendered.contains("REDACTED"),
                "resolver Debug should mark redaction"
            );
            // The reportable secret refs are safe to show.
            assert!(rendered.contains("local-secret:kaifuu/k057/xp3-simple-crypt-key"));
        }
    }

    #[test]
    fn registry_held_key_bytes_are_confined_to_the_zeroizing_holder() {
        // The registry/holder-held raw bytes must never appear in the serialized
        // report, and the runtime no-leak guard scans the resolver-held holders
        // (not just the report). A passing run means the guard saw the resolved
        // key material and confirmed it is absent from the JSON.
        let report =
            run_xp3_production(&registry(), "xp3-production").expect("production run passes");
        let json = report.stable_json().expect("stable json");
        for key in RAW_KEYS {
            assert!(
                !json.contains(key),
                "registry-held raw key {key} reached the serialized report"
            );
        }
    }

    /// Rebuild `synthetic::production_registry` but plant, on the UNCLAIMED
    /// variant, an `archive_key` whose raw bytes are exactly the (non-secret-
    /// shaped) `variant_id`. An unclaimed variant's `variant_id` is emitted
    /// verbatim in its NotClaimed report row, and the archive key of an
    /// unclaimed variant NEVER enters a resolver — so this forces a registry-
    /// held raw key byte into the serialized report that the resolver-held scan
    /// alone cannot see. Only a guard that also scans EVERY registry-held holder
    /// (claimed + unclaimed) can catch it.
    fn registry_with_unclaimed_archive_key_planted_in_report(
        planted_id: &str,
    ) -> Xp3ProductionRegistry {
        let mut registry = registry();
        let unclaimed = registry
            .variants
            .iter()
            .position(|variant| !variant.claimed)
            .expect("the synthetic registry has an unclaimed variant");
        let original = &registry.variants[unclaimed];
        // The planted id must pass the report redaction (else it is scrubbed and
        // never reaches the JSON, defeating the probe). Hyphenated lowercase ids
        // in the style of the existing variant ids are emitted verbatim.
        assert_eq!(
            redact_for_log_or_report(planted_id),
            planted_id,
            "planted id must survive report redaction verbatim to exercise the guard"
        );
        let planted = Xp3ProductionVariant::new(
            planted_id.to_string(),
            original.crypto_profile,
            original.surface,
            original.secret_requirement_id.clone(),
            original.secret_ref.clone(),
            original.helper_workflow,
            None,
            original.members.clone(),
            original.replacements.clone(),
            false,
            // archive_key bytes == the (verbatim-emitted) variant_id → a
            // registry-held raw key that lands in the report, unseen by any
            // resolver (this variant is unclaimed, so it is never resolved).
            private_fixture_secret_holder(&original.secret_ref, planted_id.as_bytes().to_vec()),
            None,
        );
        registry.variants[unclaimed] = planted;
        registry
    }

    #[test]
    fn runtime_guard_scans_unclaimed_registry_held_archive_key() {
        // PROVES the runtime no-leak guard covers registry-held key holders,
        // including an UNCLAIMED variant's archive key — not merely the resolver-
        // held copies. If the guard is narrowed back to resolver-only, the
        // planted registry-held key byte reaches the report unguarded and this
        // test fails (the run would succeed instead of refusing).
        let planted_id = "kaifuu.k057.unclaimed.leak.probe";
        let registry = registry_with_unclaimed_archive_key_planted_in_report(planted_id);

        // Sanity: the per-variant registry scan primitive sees the planted key.
        let unclaimed = registry
            .variants
            .iter()
            .find(|variant| !variant.claimed)
            .expect("unclaimed variant present");
        assert!(
            unclaimed.any_key_appears_in(planted_id.as_bytes()),
            "the variant registry-held scan must see its own archive key bytes"
        );

        // And the resolver-held scan alone CANNOT see it (no resolver ever holds
        // an unclaimed variant's archive key), so only the registry scan catches
        // the leak below.
        let resolver = FixtureSecretResolver::from_key_refs(vec![]);
        assert!(
            !resolver.any_key_appears_in(planted_id.as_bytes()),
            "a resolver-only scan must NOT see the unclaimed registry-held key"
        );

        // The runtime guard must refuse loud because the registry-held key byte
        // now appears in the serialized report.
        let err = run_xp3_production(&registry, "xp3-production")
            .expect_err("the guard must refuse a report that carries a registry-held key byte");
        match err {
            Xp3ProductionError::Internal { message } => {
                assert!(
                    message.contains("leaks raw key material"),
                    "expected the no-leak refusal, got: {message}"
                );
            }
            other @ Xp3ProductionError::ClaimedVariantFailed { .. } => {
                panic!("expected the Internal no-leak refusal, got {other}")
            }
        }

        // Corroborate the premise: the planted registry-held key byte really is
        // in the report the guard scanned (proving the guard, not redaction,
        // is what stopped it).
        let leaky_report = {
            let mut registry = registry_with_unclaimed_archive_key_planted_in_report(planted_id);
            // Drop ALL variants except the planted unclaimed one, then assemble
            // the same redacted report the guard sees and confirm the byte lands.
            registry
                .variants
                .retain(|variant| variant.variant_id == planted_id);
            let outcomes = vec![Xp3ProductionOutcome::NotClaimed(
                Xp3ProductionNotClaimedReport {
                    variant_id: planted_id.to_string(),
                    crypto_profile: registry.variants[0].crypto_profile,
                    helper_workflow: registry.variants[0].helper_workflow,
                    reason: "out of scope".to_string(),
                },
            )];
            Xp3ProductionReport {
                schema_version: XP3_PRODUCTION_SCHEMA_VERSION.to_string(),
                capability_id: XP3_PRODUCTION_CAPABILITY_ID.to_string(),
                source_node_id: "xp3-production".to_string(),
                support_boundary: XP3_PRODUCTION_SUPPORT_BOUNDARY.to_string(),
                registry_id: registry.registry_id.clone(),
                engine_family: XP3_PRODUCTION_ENGINE_FAMILY.to_string(),
                container: XP3_PRODUCTION_CONTAINER.to_string(),
                redaction_status: HelperRedactionStatus::Redacted,
                claimed_profiles: vec![],
                claimed_count: 0,
                not_claimed_count: 1,
                outcomes,
                status: OperationStatus::Passed,
            }
        };
        let json = leaky_report.stable_json().expect("stable json");
        assert!(
            json.contains(planted_id),
            "the planted registry-held key byte must actually reach the report JSON"
        );
    }

    #[test]
    fn helper_evidence_bound_to_wrong_secret_ref_is_rejected() {
        // P2: a helper result for the RIGHT requirement id but a DIFFERENT secret
        // ref must NOT satisfy the helper-gated path. The variant's key is
        // resolved independently through variant.secret_ref, so a helper result
        // that vouches for a different ref is evidence for the wrong secret.
        let mut registry = registry();
        let variant = &mut registry.variants[1];
        assert_eq!(variant.helper_workflow, Xp3HelperWorkflow::ManualKeyEntry);

        // A well-formed, satisfied helper — but for a DIFFERENT (valid) ref than
        // the variant's declared secret_ref, under the same requirement id.
        let wrong_ref = SecretRef::new("prompt:kaifuu/k057/xp3-position-other-password")
            .expect("synthetic secret ref is valid");
        assert_ne!(wrong_ref, variant.secret_ref);
        variant.helper_evidence = Some(synthetic::satisfied_manual_entry_helper(
            &variant.secret_requirement_id,
            &wrong_ref,
        ));

        let err = run_xp3_production(&registry, "xp3-production")
            .expect_err("a helper result bound to the wrong secret ref must be rejected");
        match err {
            Xp3ProductionError::ClaimedVariantFailed {
                variant_id, stage, ..
            } => {
                assert_eq!(variant_id, "kaifuu-k057-xp3-position-crypt");
                assert_eq!(stage, "evidence-check");
            }
            other @ Xp3ProductionError::Internal { .. } => {
                panic!("expected ClaimedVariantFailed, got {other}")
            }
        }
    }

    #[test]
    fn helper_evidence_bound_to_the_exact_secret_ref_is_accepted() {
        // The positive control for P2: the default registry's helper result IS
        // bound to the variant's exact secret ref, so the helper-gated variant
        // passes. (Guards against the wrong-ref test passing for the wrong
        // reason, e.g. helper evidence being ignored entirely.)
        let report =
            run_xp3_production(&registry(), "xp3-production").expect("production run passes");
        let position = report
            .outcomes
            .iter()
            .find_map(|outcome| match outcome {
                Xp3ProductionOutcome::Claimed(report)
                    if report.crypto_profile == Xp3CryptoProfile::XorPositionCryptFixture =>
                {
                    Some(report)
                }
                _ => None,
            })
            .expect("helper-gated position variant round-tripped");
        assert!(position.helper_evidence_present);
    }
}
