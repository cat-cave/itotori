//! Reproduction-bundle schema and validation.

use super::*;

// Bundle schema

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
    /// The embedded support tuples (exact shape). Each carries its
    /// fixture/profile id, secret-requirement ids, diagnostics, and evidence
    /// proof hashes.
    pub support_tuples: Vec<ClaimedSupportTuple>,
    /// Reproduction proofs pinning the expected public-fixture result per tuple.
    pub reproduction_proofs: Vec<ReproductionProof>,
    /// Optional bundle-level notes. Redaction-clean free text only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

// Validation findings

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

// Validation report

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
    /// The rolled-up tuple validation (anti-overclaim etc.).
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

// Validator

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
/// The bundle FAILS iff it carries any private asset, is not self-sufficient for
/// public reproduction, or embeds an overclaiming tuple (gate).
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
