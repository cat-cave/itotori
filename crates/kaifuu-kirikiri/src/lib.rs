//! Pure-Rust **KiriKiri KAG `.ks` plaintext scenario-script** text-extraction
//! and byte-preserving patch adapter — the KiriKiri **null-container special
//! case**.
//!
//! # Honest scope: plaintext KAG `.ks` ≠ commercial KiriKiri (encrypted XP3)
//!
//! KiriKiri ships its assets in `.xp3` archives. **Commercial** KiriKiri
//! titles almost always ship those archives *encrypted* (a per-title cipher /
//! `.tpm` filter), and the scenario scripts live *inside* the encrypted
//! archive. Reading them requires the XP3 container layer plus per-title key
//! material — that is a **separate** capability tracked by the KiriKiri/XP3
//! packed-engine readiness profile (`kaifuu_core::packed_engine_readiness`,
//! `kaifuu_core::xp3_capability_profile`) and is explicitly **out of scope**
//! here.
//!
//! This crate handles the opposite, **null-container** end of the spectrum:
//! a `.ks` file that is *already* plaintext on disk — either an unencrypted /
//! `plain` XP3 whose members were extracted, an author's development tree, or
//! a fan-distributed plaintext script. Supporting plaintext KAG **must not be
//! presented as commercial-KiriKiri coverage.** It is the floor case: no
//! container, no cipher, just the KAG scenario dialect. See
//! [`capability_note`] and `docs/kaifuu-adapters/kirikiri-kag.md`.
//!
//! # What it does
//!
//! - [`parse_ks`] parses the KAG line dialect (comments `;`, labels `*`,
//!   `@`-line-commands, `#name` speaker lines, and inline `[tag …]` tags
//!   interspersed with message text) into stable [`KsUnit`]s. Encoding-aware
//!   (UTF-8 + Shift-JIS) so a Shift-JIS trailing byte equal to an ASCII
//!   delimiter is never mistaken for a tag.
//! - Speaker extraction follows the KAG `#name` / `#voice/display` convention;
//!   each `dialogue` unit records the active speaker.
//! - [`apply_patch`] rewrites only the translatable spans, byte-preserving
//!   all structure; [`verify_byte_preserving`] proves a patch touched nothing
//!   but translatable text.
//!
//! # Determinism / no shell-outs
//!
//! Pure in-process parsing; all identifiers are SHA-256-derived
//! (`bridge_unit_id` uses the shared UUID7-shaped scheme). No `Command::new`,
//! no network, no helper process. No copyrighted bytes: the fixture corpus is
//! synthetic, authored, CC0.

mod ids;
mod parse;
mod patch;
pub mod xp3_crypt;
pub mod xp3_crypt_chain;
pub mod xp3_patch;
pub mod xp3_private_local_summary;
pub mod xp3_production;

pub use parse::{
    KsDocument, KsEncoding, KsFinding, KsFindingKind, KsUnit, TextRole, parse_ks,
    parse_ks_with_encoding, structural_bytes,
};
pub use patch::{
    PatchError, VerifyError, apply_patch, source_structural_bytes, verify_byte_preserving,
};
pub use xp3_crypt::{
    FixtureSecretResolver, KirikiriXp3Surface, Xp3CryptContainerSource, Xp3CryptError,
    Xp3CryptExtractedMember, Xp3CryptFixture, Xp3CryptManifest, Xp3CryptMemberDigest,
    Xp3CryptMissingKeyReport, Xp3CryptReport, Xp3CryptScheme, Xp3CryptWrongKeyReport,
    Xp3CryptoProfile, build_synthetic_crypt_xp3, run_xp3_crypt_smoke_from_fixture,
    run_xp3_crypt_smoke_from_path,
};
pub use xp3_crypt_chain::{
    Xp3ChainDeltaEvidence, Xp3ChainDeltaMember, Xp3ChainDeltaOperation, Xp3ChainDetectReport,
    Xp3ChainError, Xp3ChainProfileResolveReport, Xp3ChainStage, Xp3ChainStageOutcome,
    Xp3CryptChainReport, detect_xp3_container, run_xp3_crypt_chain_smoke_from_fixture,
    run_xp3_crypt_chain_smoke_from_paths,
};
pub use xp3_patch::{
    Xp3PatchCapability, Xp3PatchChangeReport, Xp3PatchCoverage, Xp3PatchError,
    Xp3PatchIdentityReport, Xp3PatchManifest, Xp3PatchReport, Xp3PatchVerification,
    Xp3TextReplacement, run_xp3_patch_smoke_from_fixture, run_xp3_patch_smoke_from_paths,
};
pub use xp3_private_local_summary::{
    Xp3HelperResultAggregate, Xp3HelperResultRow, Xp3PatchSummaryRow,
    Xp3PrivateLocalRedactionSummary, Xp3PrivateLocalSummary, Xp3PrivateLocalSummaryDiagnostic,
    Xp3PrivateLocalSummaryInput, Xp3SupportTupleRow, Xp3SupportTupleSummaryFixture,
    render_xp3_private_local_summary,
};
pub use xp3_production::{
    Xp3HelperWorkflow, Xp3ProductionError, Xp3ProductionMemberDelta, Xp3ProductionMemberOperation,
    Xp3ProductionNotClaimedReport, Xp3ProductionOutcome, Xp3ProductionRegistry,
    Xp3ProductionReport, Xp3ProductionStage, Xp3ProductionVariant, Xp3ProductionVariantReport,
    run_xp3_production,
};

/// One-line honest-scope statement, embedded so the boundary is queryable
/// from code, not only prose docs.
#[must_use]
pub fn capability_note() -> &'static str {
    "kaifuu-kirikiri handles plaintext KAG `.ks` scenario scripts (the KiriKiri \
     null-container special case). This is NOT commercial-KiriKiri coverage: \
     commercial titles ship encrypted XP3 archives whose per-title key material \
     and container layer are a separate capability (see \
     kaifuu_core::packed_engine_readiness / xp3_capability_profile)."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_note_states_the_boundary() {
        let note = capability_note();
        assert!(note.contains("plaintext"));
        assert!(note.contains("null-container"));
        assert!(note.contains("NOT commercial"));
        assert!(note.contains("encrypted XP3"));
    }
}
