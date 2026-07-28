//! Redacted compatibility REPRODUCTION BUNDLE schema + validator.
//! A reproduction bundle is the shareable, PUBLIC artifact that lets a third
//! party re-derive kaifuu's compatibility results WITHOUT any private corpora.
//! It carries the [`ClaimedSupportTuple`]s (exact shape — engine
//! family, variant, container, crypto, codec, surface, patch-back mode,
//! fixture/profile id, secret-requirement ids, diagnostics, claim + evidence
//! chain), plus a set of top-level **reproduction proofs** (fixture id +
//! [`ProofHash`]) that pin the expected public-fixture result for each claimed
//! tuple. Given the bundle, anyone can run the named public fixtures and check
//! their output against the proof hashes — no retail bytes, no raw keys, no
//! screenshots, no prompt logs, no story text, no private paths ever cross the
//! boundary.
//! # The two mechanical guarantees
//! 1. **Reject-on-private (acceptance 2).** [`validate_repro_bundle`] walks
//!    every free-text-bearing string field of the bundle and rejects the six
//!    private-asset classes — [`PrivateAssetClass::RawKey`],
//!    [`PrivateAssetClass::PrivatePath`], [`PrivateAssetClass::RetailBytes`],
//!    [`PrivateAssetClass::Screenshot`], [`PrivateAssetClass::PromptLog`],
//!    [`PrivateAssetClass::StoryText`]. Each rejection is a structured
//!    [`PrivateAssetViolation`] that NAMES the bundle id, the tuple id (when the
//!    offending string lives inside an embedded tuple), and the field that
//!    failed (acceptance 4). The violation carries only the class + a redacted
//!    message — never the offending value.
//! 2. **Self-sufficiency (acceptance 3).** The proof hashes + fixture ids must
//!    be enough to reproduce the public-fixture results with no private-corpus
//!    reference: every reproduction proof must resolve to an embedded tuple, and
//!    every embedded tuple must be backed by at least one reproduction proof.
//!    Anything less is a typed [`ReproductionGap`] and the bundle is not
//!    self-sufficient.
//!    Secret material and proof hashes are carried through the STRONGLY-TYPED
//!    [`SecretRef`] / [`ProofHash`] wrappers (which reject raw material at
//!    deserialize time), so the private-asset scan only needs to police the plain
//!    string fields where smuggling is otherwise possible.

use serde::{Deserialize, Serialize};

use crate::{
    KaifuuResult, OperationStatus, ProofHash, is_local_absolute_path, looks_like_raw_key_material,
    redact_for_log_or_report, stable_json,
};

use crate::compat_profile::{
    ClaimedSupportTuple, ClaimedSupportValidationReport, validate_claimed_support_profile,
};

/// Schema version of the reproduction bundle (lockstep with the JSON Schema
/// fixture).
pub const REPRO_BUNDLE_SCHEMA_VERSION: &str = "0.1.0";

/// Schema version of the generated validation report.
pub const REPRO_BUNDLE_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The boundary surfaced in every report.
pub const REPRO_BUNDLE_BOUNDARY: &str = "A reproduction bundle carries  claimed-support tuples (engine family, variant, container, crypto, codec, surface, patch-back mode, fixture/profile id, secret-requirement ids, diagnostics, claim + evidence chain) plus reproduction proofs (public fixture id + sha256 proof hash). It NEVER carries private assets: raw keys, private paths, retail bytes, screenshots, prompt logs, or story text are rejected with a bundle/tuple/field-named error. The proof hashes + fixture ids are sufficient to reproduce the public-fixture results with no private-corpus reference.";

// The six private-asset classes (reject-on-private)

/// The six private-asset classes a reproduction bundle must never carry. A
/// scanned string resolves to at most one class (the scanner returns the first
/// match in a fixed priority order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivateAssetClass {
    /// Raw cryptographic key material (PEM block or a high-entropy hex/base64
    /// token) — must be a [`SecretRef`], never inline.
    RawKey,
    /// A local absolute filesystem path (unix `/…`, windows `C:\…`, `~/…`,
    /// `$HOME/…`) — leaks the operator's install layout.
    PrivatePath,
    /// Inline retail game bytes (a non-image `data:` URI, a retail
    /// container/asset filename, or an explicit "retail/game bytes" marker).
    RetailBytes,
    /// An inline rendered frame (an `data:image/…` URI, an image filename, or a
    /// "screenshot"/"rendered frame" marker).
    Screenshot,
    /// An LLM prompt/response transcript ("system prompt", "prompt log", role
    /// labels, …).
    PromptLog,
    /// Decrypted or translated narrative prose, or a spoiler/route/ending
    /// filename.
    StoryText,
}

impl PrivateAssetClass {
    /// All six classes in scanner priority order.
    pub fn all() -> [Self; 6] {
        [
            Self::RawKey,
            Self::PrivatePath,
            Self::RetailBytes,
            Self::Screenshot,
            Self::PromptLog,
            Self::StoryText,
        ]
    }

    /// Stable canonical string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RawKey => "raw_key",
            Self::PrivatePath => "private_path",
            Self::RetailBytes => "retail_bytes",
            Self::Screenshot => "screenshot",
            Self::PromptLog => "prompt_log",
            Self::StoryText => "story_text",
        }
    }

    /// A redaction-safe human description (carries no offending value).
    pub fn description(self) -> &'static str {
        match self {
            Self::RawKey => "raw cryptographic key material (must be a secretRef)",
            Self::PrivatePath => "a local absolute filesystem path",
            Self::RetailBytes => "inline retail game bytes",
            Self::Screenshot => "an inline rendered frame / screenshot",
            Self::PromptLog => "an LLM prompt/response transcript",
            Self::StoryText => "decrypted or translated story text",
        }
    }
}

// Private-asset scanner

mod scanner;
pub use scanner::*;

mod model;
pub use model::*;

// Fixtures — a clean redacted bundle + per-class dirty bundles (synthetic)

/// Synthetic, redacted, ref-only reproduction-bundle fixtures. The clean bundle
/// validates green; the `inject_*` helpers produce a copy carrying exactly ONE
/// private-asset class (synthetic markers — no real private assets).
pub mod fixtures {
    use super::*;
    use crate::ProofHash;
    use crate::compat_profile::fixtures as tuple_fixtures;
    use crate::sha256_hash_bytes;

    fn proof(seed: &str) -> ProofHash {
        ProofHash::new(sha256_hash_bytes(seed.as_bytes())).expect("synthetic proof hash is valid")
    }

    /// A clean redacted bundle: two honest embedded tuples, each backed by a
    /// public reproduction proof. No private assets, fully self-sufficient.
    pub fn clean_bundle() -> ReproBundle {
        let siglus = tuple_fixtures::level_extract_siglus();
        let kag = tuple_fixtures::level_patch_kirikiri_kag_plaintext();
        ReproBundle {
            schema_version: REPRO_BUNDLE_SCHEMA_VERSION.to_string(),
            bundle_id: "repro/kaifuu/siglus-and-kag".to_string(),
            reproduction_proofs: vec![
                ReproductionProof::new(
                    siglus.profile_or_fixture_id.clone(),
                    "public/siglus-known-key-extract",
                    proof("repro:siglus-extract"),
                ),
                ReproductionProof::new(
                    kag.profile_or_fixture_id.clone(),
                    "public/kirikiri-kag-plaintext-patch",
                    proof("repro:kag-patch"),
                ),
            ],
            support_tuples: vec![siglus, kag],
            notes: vec![
                "reproduce by running the named public fixtures and matching the proof hashes"
                    .to_string(),
            ],
        }
    }

    /// The clean bundle with a synthetic RAW KEY injected into a tuple diagnostic
    /// detail (64 hex chars — trips the raw-key entropy detector).
    pub fn dirty_raw_key() -> ReproBundle {
        let mut bundle = clean_bundle();
        set_first_diagnostic_detail(
            &mut bundle,
            "leaked static key deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        );
        bundle
    }

    /// The clean bundle with a synthetic PRIVATE PATH injected into a note.
    pub fn dirty_private_path() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle
            .notes
            .push("/home/operator/games/retail/Scene.pck".to_string());
        bundle
    }

    /// The clean bundle with an inline RETAIL BYTES payload injected into a
    /// reproduction-proof fixture id.
    pub fn dirty_retail_bytes() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle.reproduction_proofs[0].fixture_id =
            "data:application/octet-stream;base64,AAECAwQFBgc=".to_string();
        bundle
    }

    /// The clean bundle with an inline SCREENSHOT injected into a note.
    pub fn dirty_screenshot() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle
            .notes
            .push("data:image/png;base64,iVBORw0KGgoAAAANS".to_string());
        bundle
    }

    /// The clean bundle with a PROMPT LOG injected into a note.
    pub fn dirty_prompt_log() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle
            .notes
            .push("system prompt: you are a translator\nassistant: translated line".to_string());
        bundle
    }

    /// The clean bundle with STORY TEXT injected into a tuple diagnostic detail.
    pub fn dirty_story_text() -> ReproBundle {
        let mut bundle = clean_bundle();
        set_first_diagnostic_detail(
            &mut bundle,
            "decrypted script: the heroine confesses her feelings",
        );
        bundle
    }

    /// A bundle whose reproduction proof references a tuple NOT in the bundle —
    /// breaks self-sufficiency without any private asset.
    pub fn dirty_unresolved_reference() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle.reproduction_proofs[0].tuple_id = "compat/does-not-exist".to_string();
        bundle
    }

    fn set_first_diagnostic_detail(bundle: &mut ReproBundle, detail: &str) {
        let tuple = bundle
            .support_tuples
            .first_mut()
            .expect("clean bundle has tuples");
        let diagnostic = tuple
            .diagnostics
            .first_mut()
            .expect("clean bundle tuple has a diagnostic");
        diagnostic.detail = Some(detail.to_string());
    }
}

#[cfg(test)]
#[path = "repro_bundle_tests.rs"]
mod tests;
