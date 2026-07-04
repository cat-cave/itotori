//! KAIFUU-106 — Redacted compatibility REPRODUCTION BUNDLE schema + validator.
//!
//! A reproduction bundle is the shareable, PUBLIC artifact that lets a third
//! party re-derive kaifuu's compatibility results WITHOUT any private corpora.
//! It carries the KAIFUU-105 [`ClaimedSupportTuple`]s (exact shape — engine
//! family, variant, container, crypto, codec, surface, patch-back mode,
//! fixture/profile id, secret-requirement ids, diagnostics, claim + evidence
//! chain), plus a set of top-level **reproduction proofs** (fixture id +
//! [`ProofHash`]) that pin the expected public-fixture result for each claimed
//! tuple. Given the bundle, anyone can run the named public fixtures and check
//! their output against the proof hashes — no retail bytes, no raw keys, no
//! screenshots, no prompt logs, no story text, no private paths ever cross the
//! boundary.
//!
//! # The two mechanical guarantees
//!
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
//!
//! Secret material and proof hashes are carried through the STRONGLY-TYPED
//! [`SecretRef`] / [`ProofHash`] wrappers (which reject raw material at
//! deserialize time), so the private-asset scan only needs to police the plain
//! string fields where smuggling is otherwise possible.

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
pub const REPRO_BUNDLE_BOUNDARY: &str = "A reproduction bundle carries KAIFUU-105 claimed-support tuples (engine family, variant, container, crypto, codec, surface, patch-back mode, fixture/profile id, secret-requirement ids, diagnostics, claim + evidence chain) plus reproduction proofs (public fixture id + sha256 proof hash). It NEVER carries private assets: raw keys, private paths, retail bytes, screenshots, prompt logs, or story text are rejected with a bundle/tuple/field-named error. The proof hashes + fixture ids are sufficient to reproduce the public-fixture results with no private-corpus reference.";

// ---------------------------------------------------------------------------
// The six private-asset classes (reject-on-private)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Private-asset scanner
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "bmp", "gif", "webp", "tga", "rpgmvp"];
const RETAIL_BINARY_EXTENSIONS: &[&str] = &[
    "xp3", "pck", "rgssad", "rgss3a", "rgss2a", "dat", "bin", "exe", "rpgmvo", "arc", "wolf",
];

fn trim_token_edges(token: &str) -> &str {
    token.trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\'' | '`' | ',' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}' | '!' | '?'
        )
    })
}

fn token_has_extension(text: &str, extensions: &[&str]) -> bool {
    text.split_whitespace().map(trim_token_edges).any(|token| {
        token.rsplit_once('.').is_some_and(|(_, extension)| {
            extensions.contains(&extension.to_ascii_lowercase().as_str())
        })
    })
}

fn contains_private_path(text: &str) -> bool {
    text.split_whitespace()
        .map(trim_token_edges)
        .any(is_local_absolute_path)
}

fn contains_raw_key(text: &str) -> bool {
    if text.contains("-----BEGIN") {
        return true;
    }
    // Scan per TOKEN, never the whole string: raw key material is a single
    // contiguous token, whereas the whole-string base64url heuristic fires on
    // ordinary hyphenated prose (e.g. "patch-back is not yet proven"). `:` is
    // kept INSIDE tokens so `sha256:<hex>` proof hashes and `local-secret:<name>`
    // refs stay whole — `looks_like_raw_key_material` excludes both, avoiding a
    // false raw-key hit on their hex/base64 tail.
    text.split(|character: char| {
        !(character.is_ascii_alphanumeric()
            || matches!(character, '+' | '/' | '=' | '-' | '_' | ':'))
    })
    .any(looks_like_raw_key_material)
}

fn contains_screenshot(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("data:image/") {
        return true;
    }
    if lower.contains("screenshot") || lower.contains("rendered frame") {
        return true;
    }
    token_has_extension(text, IMAGE_EXTENSIONS)
}

fn contains_retail_bytes(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("data:application/")
        || lower.contains("data:audio/")
        || lower.contains("data:video/")
        || lower.contains("data:application/octet-stream")
    {
        return true;
    }
    if lower.contains("retail bytes")
        || lower.contains("game bytes")
        || lower.contains("copyrighted bytes")
    {
        return true;
    }
    token_has_extension(text, RETAIL_BINARY_EXTENSIONS)
}

fn contains_prompt_log(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("system prompt")
        || lower.contains("prompt log")
        || lower.contains("prompt transcript")
        || lower.contains("llm prompt")
        || lower.contains("\nassistant:")
        || lower.contains("\nuser:")
        || lower.starts_with("assistant:")
        || lower.starts_with("system:")
}

const STORY_TEXT_MARKERS: &[&str] = &[
    "decrypted script",
    "decrypted text",
    "decrypted plaintext",
    "translated line",
    "translated script",
    "story text",
    "narrative text",
    "spoiler",
];

fn contains_story_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if STORY_TEXT_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return true;
    }
    // A spoiler/route/ending filename — a private script the bundle must not name.
    text.split_whitespace().map(trim_token_edges).any(|token| {
        let lower = token.to_ascii_lowercase();
        let looks_like_file = lower
            .rsplit_once('.')
            .is_some_and(|(_, extension)| !extension.is_empty() && extension.len() <= 8);
        looks_like_file
            && ["route", "ending", "true-end", "spoiler", "private"]
                .iter()
                .any(|needle| lower.contains(needle))
    })
}

/// Scan one string for a private-asset class. Returns the first match in a
/// fixed priority order (path → key → screenshot → retail → prompt → story).
pub fn scan_private_asset(text: &str) -> Option<PrivateAssetClass> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if contains_private_path(text) {
        return Some(PrivateAssetClass::PrivatePath);
    }
    if contains_raw_key(text) {
        return Some(PrivateAssetClass::RawKey);
    }
    if contains_screenshot(text) {
        return Some(PrivateAssetClass::Screenshot);
    }
    if contains_retail_bytes(text) {
        return Some(PrivateAssetClass::RetailBytes);
    }
    if contains_prompt_log(text) {
        return Some(PrivateAssetClass::PromptLog);
    }
    if contains_story_text(text) {
        return Some(PrivateAssetClass::StoryText);
    }
    None
}

// ---------------------------------------------------------------------------
// Bundle schema
// ---------------------------------------------------------------------------

/// One reproduction proof: the public fixture whose result reproduces a claimed
/// tuple, pinned by a [`ProofHash`]. No bytes, no secrets, no private paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReproductionProof {
    /// The `profileOrFixtureId` of the embedded tuple this proof reproduces.
    pub tuple_id: String,
    /// The PUBLIC fixture id a reproducer runs (never a private path/corpus).
    pub fixture_id: String,
    /// The sha256 proof hash the public-fixture run must match.
    pub proof_hash: ProofHash,
}

impl ReproductionProof {
    pub fn new(
        tuple_id: impl Into<String>,
        fixture_id: impl Into<String>,
        proof_hash: ProofHash,
    ) -> Self {
        Self {
            tuple_id: tuple_id.into(),
            fixture_id: fixture_id.into(),
            proof_hash,
        }
    }
}

/// The versioned, redacted reproduction bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReproBundle {
    pub schema_version: String,
    pub bundle_id: String,
    /// The embedded KAIFUU-105 support tuples (exact shape). Each carries its
    /// fixture/profile id, secret-requirement ids, diagnostics, and evidence
    /// proof hashes.
    pub support_tuples: Vec<ClaimedSupportTuple>,
    /// Reproduction proofs pinning the expected public-fixture result per tuple.
    pub reproduction_proofs: Vec<ReproductionProof>,
    /// Optional bundle-level notes. Redaction-clean free text only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Validation findings
// ---------------------------------------------------------------------------

/// A rejected private-asset finding. Names the bundle id, the tuple id (when the
/// offending string lives inside an embedded tuple), and the field that failed —
/// and carries only a redacted message, never the offending value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateAssetViolation {
    pub bundle_id: String,
    /// `None` when the offending string is a bundle-level field (e.g. a note).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tuple_id: Option<String>,
    pub field: String,
    pub class: PrivateAssetClass,
    /// A redaction-safe message. NEVER carries the rejected value.
    pub message: String,
}

impl PrivateAssetViolation {
    fn new(
        bundle_id: &str,
        tuple_id: Option<&str>,
        field: impl Into<String>,
        class: PrivateAssetClass,
    ) -> Self {
        let field = field.into();
        let message = match tuple_id {
            Some(tuple) => format!(
                "bundle {bundle_id}, tuple {tuple}, field {field}: rejected {} ({})",
                class.as_str(),
                class.description()
            ),
            None => format!(
                "bundle {bundle_id}, field {field}: rejected {} ({})",
                class.as_str(),
                class.description()
            ),
        };
        Self {
            bundle_id: bundle_id.to_string(),
            tuple_id: tuple_id.map(str::to_string),
            field,
            class,
            message,
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            bundle_id: redact_for_log_or_report(&self.bundle_id),
            tuple_id: self.tuple_id.as_deref().map(redact_for_log_or_report),
            field: redact_for_log_or_report(&self.field),
            class: self.class,
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// Why a bundle is NOT self-sufficient for public reproduction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReproductionGapKind {
    /// A reproduction proof references a tuple id not present in the bundle.
    UnresolvedTupleReference,
    /// An embedded tuple has no reproduction proof — its public result can't be
    /// reproduced from this bundle alone.
    TupleWithoutReproductionProof,
}

impl ReproductionGapKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnresolvedTupleReference => "unresolved_tuple_reference",
            Self::TupleWithoutReproductionProof => "tuple_without_reproduction_proof",
        }
    }
}

/// A typed self-sufficiency gap, naming the tuple id + field it concerns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReproductionGap {
    pub bundle_id: String,
    pub tuple_id: String,
    pub field: String,
    pub kind: ReproductionGapKind,
    pub message: String,
}

impl ReproductionGap {
    fn new(bundle_id: &str, tuple_id: &str, field: &str, kind: ReproductionGapKind) -> Self {
        let message = format!(
            "bundle {bundle_id}, tuple {tuple_id}, field {field}: {}",
            kind.as_str()
        );
        Self {
            bundle_id: bundle_id.to_string(),
            tuple_id: tuple_id.to_string(),
            field: field.to_string(),
            kind,
            message,
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            bundle_id: redact_for_log_or_report(&self.bundle_id),
            tuple_id: redact_for_log_or_report(&self.tuple_id),
            field: redact_for_log_or_report(&self.field),
            kind: self.kind,
            message: redact_for_log_or_report(&self.message),
        }
    }
}

// ---------------------------------------------------------------------------
// Validation report
// ---------------------------------------------------------------------------

/// The aggregate reproduction-bundle validation report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReproBundleValidationReport {
    pub schema_version: String,
    pub boundary: String,
    pub bundle_id: String,
    pub status: OperationStatus,
    pub tuple_count: u64,
    pub proof_count: u64,
    /// True iff there are no private-asset violations and no reproduction gaps.
    pub self_sufficient: bool,
    pub violations: Vec<PrivateAssetViolation>,
    pub gaps: Vec<ReproductionGap>,
    /// The rolled-up KAIFUU-105 tuple validation (anti-overclaim etc.).
    pub tuple_report: ClaimedSupportValidationReport,
}

impl ReproBundleValidationReport {
    /// True iff the bundle validated: no private assets, self-sufficient, and
    /// every embedded tuple is honest.
    pub fn is_clean(&self) -> bool {
        self.status == OperationStatus::Passed
    }

    /// The violations that named `class`.
    pub fn violations_of(&self, class: PrivateAssetClass) -> Vec<&PrivateAssetViolation> {
        self.violations
            .iter()
            .filter(|v| v.class == class)
            .collect()
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            boundary: redact_for_log_or_report(&self.boundary),
            bundle_id: redact_for_log_or_report(&self.bundle_id),
            status: self.status.clone(),
            tuple_count: self.tuple_count,
            proof_count: self.proof_count,
            self_sufficient: self.self_sufficient,
            violations: self
                .violations
                .iter()
                .map(PrivateAssetViolation::redacted_for_report)
                .collect(),
            gaps: self
                .gaps
                .iter()
                .map(ReproductionGap::redacted_for_report)
                .collect(),
            tuple_report: self.tuple_report.redacted_for_report(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

fn scan_field(
    bundle_id: &str,
    tuple_id: Option<&str>,
    field: &str,
    value: &str,
    out: &mut Vec<PrivateAssetViolation>,
) {
    if let Some(class) = scan_private_asset(value) {
        out.push(PrivateAssetViolation::new(
            bundle_id, tuple_id, field, class,
        ));
    }
}

/// Collect every private-asset violation in the bundle. Walks the plain-string
/// fields only — [`SecretRef`] / [`ProofHash`] fields are structurally safe and
/// reject raw material at deserialize time.
fn collect_private_asset_violations(bundle: &ReproBundle) -> Vec<PrivateAssetViolation> {
    let mut violations = Vec::new();
    let bundle_id = bundle.bundle_id.as_str();

    // Bundle-level fields.
    scan_field(bundle_id, None, "bundleId", bundle_id, &mut violations);
    for (index, note) in bundle.notes.iter().enumerate() {
        scan_field(
            bundle_id,
            None,
            &format!("notes[{index}]"),
            note,
            &mut violations,
        );
    }

    // Reproduction proofs.
    for (index, proof) in bundle.reproduction_proofs.iter().enumerate() {
        scan_field(
            bundle_id,
            Some(proof.tuple_id.as_str()),
            &format!("reproductionProofs[{index}].tupleId"),
            &proof.tuple_id,
            &mut violations,
        );
        scan_field(
            bundle_id,
            Some(proof.tuple_id.as_str()),
            &format!("reproductionProofs[{index}].fixtureId"),
            &proof.fixture_id,
            &mut violations,
        );
    }

    // Embedded tuples.
    for tuple in &bundle.support_tuples {
        let tuple_id = tuple.profile_or_fixture_id.as_str();
        scan_field(
            bundle_id,
            Some(tuple_id),
            "profileOrFixtureId",
            &tuple.profile_or_fixture_id,
            &mut violations,
        );
        scan_field(
            bundle_id,
            Some(tuple_id),
            "engineVariant",
            &tuple.engine_variant,
            &mut violations,
        );
        for (index, requirement) in tuple.secret_requirement_ids.iter().enumerate() {
            scan_field(
                bundle_id,
                Some(tuple_id),
                &format!("secretRequirementIds[{index}].requirementId"),
                &requirement.requirement_id,
                &mut violations,
            );
        }
        for (index, diagnostic) in tuple.diagnostics.iter().enumerate() {
            if let Some(detail) = &diagnostic.detail {
                scan_field(
                    bundle_id,
                    Some(tuple_id),
                    &format!("diagnostics[{index}].detail"),
                    detail,
                    &mut violations,
                );
            }
        }
        for (leg, evidence) in [
            ("extraction", tuple.evidence.extraction.as_ref()),
            ("validation", tuple.evidence.validation.as_ref()),
            ("patchBack", tuple.evidence.patch_back.as_ref()),
            ("runtime", tuple.evidence.runtime.as_ref()),
        ] {
            if let Some(evidence) = evidence {
                scan_field(
                    bundle_id,
                    Some(tuple_id),
                    &format!("evidence.{leg}.evidenceId"),
                    &evidence.evidence_id,
                    &mut violations,
                );
            }
        }
    }

    violations
}

/// Collect the self-sufficiency gaps: every proof must resolve to an embedded
/// tuple, and every embedded tuple must have at least one reproduction proof.
fn collect_reproduction_gaps(bundle: &ReproBundle) -> Vec<ReproductionGap> {
    let mut gaps = Vec::new();
    let bundle_id = bundle.bundle_id.as_str();

    let tuple_ids: Vec<&str> = bundle
        .support_tuples
        .iter()
        .map(|tuple| tuple.profile_or_fixture_id.as_str())
        .collect();

    for (index, proof) in bundle.reproduction_proofs.iter().enumerate() {
        if !tuple_ids.contains(&proof.tuple_id.as_str()) {
            gaps.push(ReproductionGap::new(
                bundle_id,
                &proof.tuple_id,
                &format!("reproductionProofs[{index}].tupleId"),
                ReproductionGapKind::UnresolvedTupleReference,
            ));
        }
    }

    let proven_ids: Vec<&str> = bundle
        .reproduction_proofs
        .iter()
        .map(|proof| proof.tuple_id.as_str())
        .collect();
    for tuple in &bundle.support_tuples {
        let tuple_id = tuple.profile_or_fixture_id.as_str();
        if !proven_ids.contains(&tuple_id) {
            gaps.push(ReproductionGap::new(
                bundle_id,
                tuple_id,
                "profileOrFixtureId",
                ReproductionGapKind::TupleWithoutReproductionProof,
            ));
        }
    }

    gaps
}

/// Validate a redacted reproduction bundle. Never panics, never returns `Err`.
///
/// The bundle FAILS iff it carries any private asset, is not self-sufficient for
/// public reproduction, or embeds an overclaiming tuple (KAIFUU-105 gate).
pub fn validate_repro_bundle(bundle: &ReproBundle) -> ReproBundleValidationReport {
    let violations = collect_private_asset_violations(bundle);
    let gaps = collect_reproduction_gaps(bundle);
    let tuple_report = validate_claimed_support_profile(&bundle.support_tuples);

    let self_sufficient = violations.is_empty() && gaps.is_empty();
    let status = if self_sufficient && tuple_report.status == OperationStatus::Passed {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    ReproBundleValidationReport {
        schema_version: REPRO_BUNDLE_REPORT_SCHEMA_VERSION.to_string(),
        boundary: REPRO_BUNDLE_BOUNDARY.to_string(),
        bundle_id: bundle.bundle_id.clone(),
        status,
        tuple_count: bundle.support_tuples.len() as u64,
        proof_count: bundle.reproduction_proofs.len() as u64,
        self_sufficient,
        violations,
        gaps,
        tuple_report,
    }
}

// ---------------------------------------------------------------------------
// Fixtures — a clean redacted bundle + per-class dirty bundles (synthetic)
// ---------------------------------------------------------------------------

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
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn clean_bundle_validates_green() {
        let report = validate_repro_bundle(&clean_bundle());
        assert!(report.is_clean(), "{report:#?}");
        assert_eq!(report.status, OperationStatus::Passed);
        assert!(report.self_sufficient);
        assert!(report.violations.is_empty());
        assert!(report.gaps.is_empty());
        assert_eq!(report.tuple_report.status, OperationStatus::Passed);
        assert_eq!(report.tuple_count, 2);
        assert_eq!(report.proof_count, 2);
    }

    #[test]
    fn clean_bundle_round_trips_through_json() {
        let bundle = clean_bundle();
        let json = serde_json::to_string(&bundle).expect("serialize");
        let round: ReproBundle = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(round, bundle);
    }

    fn assert_rejects_class(bundle: &ReproBundle, class: PrivateAssetClass) {
        let report = validate_repro_bundle(bundle);
        assert_eq!(
            report.status,
            OperationStatus::Failed,
            "bundle carrying {} must fail: {report:#?}",
            class.as_str()
        );
        assert!(!report.self_sufficient);
        let hits = report.violations_of(class);
        assert!(
            !hits.is_empty(),
            "expected a {} violation, got {:#?}",
            class.as_str(),
            report.violations
        );
        // The error NAMES bundle id, tuple id (when applicable), and field.
        for hit in hits {
            assert_eq!(hit.bundle_id, bundle.bundle_id);
            assert!(!hit.field.is_empty());
            assert!(hit.message.contains(&bundle.bundle_id));
            assert!(hit.message.contains(&hit.field));
            if let Some(tuple_id) = &hit.tuple_id {
                assert!(hit.message.contains(tuple_id));
            }
            // The rejected value never leaks into the message.
            assert!(!hit.message.contains("deadbeef"));
            assert!(!hit.message.contains("/home/operator"));
        }
    }

    #[test]
    fn rejects_raw_key() {
        assert_rejects_class(&dirty_raw_key(), PrivateAssetClass::RawKey);
        // Named on the tuple + the diagnostic detail field.
        let report = validate_repro_bundle(&dirty_raw_key());
        let hit = report.violations_of(PrivateAssetClass::RawKey)[0];
        assert_eq!(hit.field, "diagnostics[0].detail");
        assert!(hit.tuple_id.is_some());
    }

    #[test]
    fn rejects_private_path() {
        assert_rejects_class(&dirty_private_path(), PrivateAssetClass::PrivatePath);
    }

    #[test]
    fn rejects_retail_bytes() {
        assert_rejects_class(&dirty_retail_bytes(), PrivateAssetClass::RetailBytes);
        let report = validate_repro_bundle(&dirty_retail_bytes());
        let hit = report.violations_of(PrivateAssetClass::RetailBytes)[0];
        assert_eq!(hit.field, "reproductionProofs[0].fixtureId");
    }

    #[test]
    fn rejects_screenshot() {
        assert_rejects_class(&dirty_screenshot(), PrivateAssetClass::Screenshot);
    }

    #[test]
    fn rejects_prompt_log() {
        assert_rejects_class(&dirty_prompt_log(), PrivateAssetClass::PromptLog);
    }

    #[test]
    fn rejects_story_text() {
        assert_rejects_class(&dirty_story_text(), PrivateAssetClass::StoryText);
    }

    #[test]
    fn every_private_asset_class_is_rejected() {
        // One dirty bundle per class — all six are policed.
        let cases: [(ReproBundle, PrivateAssetClass); 6] = [
            (dirty_raw_key(), PrivateAssetClass::RawKey),
            (dirty_private_path(), PrivateAssetClass::PrivatePath),
            (dirty_retail_bytes(), PrivateAssetClass::RetailBytes),
            (dirty_screenshot(), PrivateAssetClass::Screenshot),
            (dirty_prompt_log(), PrivateAssetClass::PromptLog),
            (dirty_story_text(), PrivateAssetClass::StoryText),
        ];
        for (bundle, class) in &cases {
            assert_rejects_class(bundle, *class);
        }
        // And all six classes are distinct strings.
        let mut names: Vec<&str> = PrivateAssetClass::all()
            .iter()
            .map(|c| c.as_str())
            .collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 6);
    }

    #[test]
    fn proof_hashes_and_fixture_ids_are_self_sufficient() {
        // A clean bundle needs no private corpus: every tuple has a public
        // reproduction proof (fixture id + proof hash) and every proof resolves.
        let report = validate_repro_bundle(&clean_bundle());
        assert!(report.self_sufficient);
        // The serialized report carries only proof-hash refs + local secret refs.
        let json = report.stable_json().expect("serialize");
        assert!(json.contains("sha256:"));
        assert!(json.contains("local-secret:"));
        assert!(!json.contains("BEGIN"));
    }

    #[test]
    fn unresolved_tuple_reference_breaks_self_sufficiency() {
        let report = validate_repro_bundle(&dirty_unresolved_reference());
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(!report.self_sufficient);
        assert!(report.violations.is_empty(), "no private asset here");
        assert!(
            report
                .gaps
                .iter()
                .any(|g| g.kind == ReproductionGapKind::UnresolvedTupleReference)
        );
        // And the original tuple is now unproven → a second gap.
        assert!(
            report
                .gaps
                .iter()
                .any(|g| g.kind == ReproductionGapKind::TupleWithoutReproductionProof)
        );
    }

    #[test]
    fn embedded_overclaim_tuple_fails_the_bundle() {
        // A bundle that embeds an overclaiming tuple (patch without evidence)
        // fails via the rolled-up KAIFUU-105 gate, even with no private asset.
        let mut bundle = clean_bundle();
        let overclaim = tuple_overclaim();
        bundle.reproduction_proofs.push(ReproductionProof::new(
            overclaim.profile_or_fixture_id.clone(),
            "public/siglus-overclaim",
            proof_for("overclaim"),
        ));
        bundle.support_tuples.push(overclaim);
        let report = validate_repro_bundle(&bundle);
        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(report.tuple_report.status, OperationStatus::Failed);
        assert!(report.violations.is_empty());
    }

    fn tuple_overclaim() -> crate::compat_profile::ClaimedSupportTuple {
        crate::compat_profile::fixtures::overclaim_patch_without_evidence()
    }

    fn proof_for(seed: &str) -> ProofHash {
        ProofHash::new(crate::sha256_hash_bytes(seed.as_bytes())).expect("valid proof")
    }

    #[test]
    fn scanner_classifies_each_class_directly() {
        assert_eq!(
            scan_private_asset("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
            Some(PrivateAssetClass::RawKey)
        );
        assert_eq!(
            scan_private_asset("/home/trevor/games/x.pck"),
            Some(PrivateAssetClass::PrivatePath)
        );
        assert_eq!(
            scan_private_asset("attached Scene.xp3 archive"),
            Some(PrivateAssetClass::RetailBytes)
        );
        assert_eq!(
            scan_private_asset("frame.png of the title screen"),
            Some(PrivateAssetClass::Screenshot)
        );
        assert_eq!(
            scan_private_asset("system prompt: translate this"),
            Some(PrivateAssetClass::PromptLog)
        );
        assert_eq!(
            scan_private_asset("decrypted script contents"),
            Some(PrivateAssetClass::StoryText)
        );
        // Clean strings the bundle legitimately carries are NOT flagged.
        assert_eq!(scan_private_asset("compat/siglus/known-key-extract"), None);
        assert_eq!(
            scan_private_asset(
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            ),
            None
        );
        assert_eq!(
            scan_private_asset("local-secret:siglus-scene-static-key"),
            None
        );
        assert_eq!(
            scan_private_asset("per-title key material must be resolved by an external helper"),
            None
        );
        assert_eq!(
            scan_private_asset("plaintext KAG only — encrypted commercial XP3 is NOT covered"),
            None
        );
    }
}
