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

#[path = "xp3_production/report.rs"]
mod report;
pub use report::{
    Xp3ProductionMemberDelta, Xp3ProductionMemberOperation, Xp3ProductionNotClaimedReport,
    Xp3ProductionOutcome, Xp3ProductionReport, Xp3ProductionVariantReport,
};

#[path = "xp3_production/runner.rs"]
mod runner;
pub use runner::run_xp3_production;

fn private_fixture_secret_holder(secret_ref: &SecretRef, bytes: Vec<u8>) -> ZeroizingSecretBytes {
    SecretRefSecretResolver::from_entries(vec![(secret_ref.as_str().to_string(), bytes)])
        .into_resolved(secret_ref)
        .expect("newly inserted production fixture key must resolve by its SecretRef")
}

/// Deterministic synthetic builders. No corpus bytes, no retail names, no real
/// keys — only clearly-synthetic authored surfaces + obviously-fake fixture
/// keys, and public secret **refs**.
#[path = "xp3_production/synthetic.rs"]
pub mod synthetic;

#[cfg(test)]
#[path = "xp3_production/tests.rs"]
mod tests;
