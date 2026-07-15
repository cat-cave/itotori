//! Claimed-profile REGRESSION runner.
//! The regression runner is the drift gate for kaifuu's compatibility claims. It
//! takes the [`ClaimedSupportTuple`]s carried by a
//! [`ReproBundle`] and runs each claimed profile against:
//! 1. the PUBLIC-fixture catalogue ([`PublicFixtureCatalogue`]) — the
//!    set of public fixture/profile ids a third party can actually run; and
//! 2. the bundle's own reproduction proofs (`tupleId` → public `fixtureId` +
//!    [`ProofHash`]).
//!    For every tuple it produces a [`RegressionTupleResult`] that RECORDS all the
//!    tuple fields (engine family, variant, container, crypto, codec, surface,
//!    patch-back mode, secret-requirement ids, diagnostics) plus a pass/fail
//!    [`OperationStatus`]. The aggregate [`ClaimedProfileRegressionReport`] rolls
//!    the per-tuple results into one artifact.
//! # The three mechanical guarantees
//! 1. **Fail-on-missing-fixture-evidence.** A claim whose tuple has no
//!    reproduction proof, or whose proof names a fixture id absent from the
//!    catalogue, FAILS with a typed
//!    [`RegressionFindingKind::MissingFixtureEvidence`] — never a skip or a
//!    silent pass.
//! 2. **Fail-on-missing-secret-metadata.** A claim whose crypto layer requires a
//!    key ([`crypto_requires_secret`]) but declares no `secretRequirementIds`
//!    FAILS with [`RegressionFindingKind::MissingSecretRequirementMetadata`].
//! 3. **Diagnostic drift is a FINDING, not a silent fixture update.** Each
//!    tuple's merged (author + validator) diagnostics are fingerprinted and
//!    compared to the recorded [`RegressionBaseline`]. A changed — or never
//!    baselined — fingerprint is surfaced as a [`DriftFinding`] and FAILS the
//!    tuple. The baseline is an input the runner NEVER rewrites; re-baselining is
//!    always a deliberate act (`RegressionBaseline::from_bundle`).
//!    The result artifact is redaction-clean: it funnels every free-text field
//!    through [`redact_for_log_or_report`] and carries secrets/proofs only as the
//!    strongly-typed [`SecretRef`](crate::SecretRef) / [`ProofHash`] refs the
//!    embedded tuples already use. No raw keys, no private paths, no retail bytes.

use serde::{Deserialize, Serialize};

use crate::{
    CryptoTransform, KaifuuResult, OperationStatus, ProofHash, redact_for_log_or_report,
    sha256_hash_bytes, stable_json,
};

use crate::compat_profile::{
    ClaimedSupportEntryReport, ClaimedSupportTuple, CompatDiagnostic,
    validate_claimed_support_tuple,
};
use crate::repro_bundle::ReproBundle;

/// Schema version of the generated regression report.
pub const REGRESSION_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// Schema version of the recorded diagnostic baseline.
pub const REGRESSION_BASELINE_SCHEMA_VERSION: &str = "0.1.0";

/// The boundary surfaced in every regression report.
pub const REGRESSION_BOUNDARY: &str = "The claimed-profile regression runner re-runs the KAIFUU-105 support tuples carried by a KAIFUU-106 reproduction bundle against the KAIFUU-051 public-fixture catalogue and the bundle's reproduction proofs. A claim FAILS when its required public-fixture evidence is missing, when secret-requirement metadata a key-gated crypto layer needs is absent, or when its diagnostics DRIFT from the recorded baseline. Diagnostic drift is a finding, never a silent baseline update. The report carries no raw keys, private paths, or retail bytes.";

// public-fixture catalogue (the resolver input)

/// The set of PUBLIC fixture/profile ids a third party can actually run — the
/// catalogue the resolver checks a tuple's reproduction proof
/// against. A fixture id absent here is not reproducible evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicFixtureCatalogue {
    pub schema_version: String,
    /// The known public fixture ids (sorted, deduplicated on construction).
    pub fixture_ids: Vec<String>,
}

impl PublicFixtureCatalogue {
    /// Build a catalogue from an id list (sorted + deduplicated).
    pub fn new(fixture_ids: impl IntoIterator<Item = String>) -> Self {
        let mut fixture_ids: Vec<String> = fixture_ids.into_iter().collect();
        fixture_ids.sort_unstable();
        fixture_ids.dedup();
        Self {
            schema_version: REGRESSION_BASELINE_SCHEMA_VERSION.to_string(),
            fixture_ids,
        }
    }

    /// True iff `fixture_id` is a known public fixture.
    pub fn contains(&self, fixture_id: &str) -> bool {
        self.fixture_ids.iter().any(|id| id == fixture_id)
    }
}

// Recorded diagnostic baseline (drift detection input)

/// The typed identity of one diagnostic — layer/status/reason/severity, WITHOUT
/// the free-text detail. Drift is measured over these identities so a redaction
/// or prose tweak in `detail` never masquerades as a compatibility regression.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticIdentity {
    layer: crate::compat_profile::CompatLayer,
    status: crate::compat_profile::CompatDiagnosticStatus,
    reason_id: crate::SemanticErrorCode,
    severity: crate::PartialDiagnosticSeverity,
}

impl DiagnosticIdentity {
    fn of(diagnostic: &CompatDiagnostic) -> Self {
        Self {
            layer: diagnostic.layer,
            status: diagnostic.status,
            reason_id: diagnostic.reason_id,
            severity: diagnostic.severity,
        }
    }
}

/// Fingerprint a diagnostic vector by its typed identities (order-preserving).
/// The fingerprint is a `sha256:` [`ProofHash`] — no free text, no secrets.
pub fn diagnostics_fingerprint(diagnostics: &[CompatDiagnostic]) -> ProofHash {
    let identities: Vec<DiagnosticIdentity> =
        diagnostics.iter().map(DiagnosticIdentity::of).collect();
    let canonical = stable_json(&identities).unwrap_or_default();
    ProofHash::new(sha256_hash_bytes(canonical.as_bytes()))
        .expect("sha256_hash_bytes always yields a valid proof hash")
}

/// One recorded baseline row: a tuple id + the fingerprint of its LAST-KNOWN-GOOD
/// merged diagnostics. Comparing a fresh run against this row detects drift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegressionBaselineEntry {
    pub tuple_id: String,
    pub diagnostics_fingerprint: ProofHash,
}

/// The recorded, committed diagnostic baseline. The runner treats this as a
/// read-only input: a mismatch is a [`DriftFinding`], never a rewrite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegressionBaseline {
    pub schema_version: String,
    pub entries: Vec<RegressionBaselineEntry>,
}

impl RegressionBaseline {
    /// Record a fresh baseline from a bundle's tuples — the DELIBERATE
    /// re-baseline path. Fingerprints the validator-merged diagnostics so the
    /// baseline matches exactly what a clean run reproduces.
    pub fn from_bundle(bundle: &ReproBundle) -> Self {
        let entries = bundle
            .support_tuples
            .iter()
            .map(|tuple| {
                let entry = validate_claimed_support_tuple(tuple);
                RegressionBaselineEntry {
                    tuple_id: tuple.profile_or_fixture_id.clone(),
                    diagnostics_fingerprint: diagnostics_fingerprint(&entry.diagnostics),
                }
            })
            .collect();
        Self {
            schema_version: REGRESSION_BASELINE_SCHEMA_VERSION.to_string(),
            entries,
        }
    }

    fn fingerprint_of(&self, tuple_id: &str) -> Option<&ProofHash> {
        self.entries
            .iter()
            .find(|entry| entry.tuple_id == tuple_id)
            .map(|entry| &entry.diagnostics_fingerprint)
    }
}

// Secret-requirement metadata gate

/// True iff `crypto` needs a resolved key — and therefore a claim declaring it
/// MUST carry `secretRequirementIds`. Key-derived transforms (fixed key, key
/// profile, RPG Maker asset key, helper-gated) require metadata; the null/xor/
/// unknown transforms do not.
pub fn crypto_requires_secret(crypto: CryptoTransform) -> bool {
    matches!(
        crypto,
        CryptoTransform::FixedKey
            | CryptoTransform::KeyProfile
            | CryptoTransform::RpgMakerAssetKey
            | CryptoTransform::HelperGated
    )
}

/// Whether a tuple's secret-requirement metadata satisfies its crypto layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretMetadataStatus {
    /// The crypto layer needs no key.
    NotRequired,
    /// A key-gated crypto layer that declares its secret-requirement ids.
    Declared,
    /// A key-gated crypto layer with NO secret-requirement metadata — a fail.
    Missing,
}

// Fixture resolution (the resolver)

/// The outcome of resolving a tuple's fixture/profile id against the
/// reproduction proofs + the public-fixture catalogue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureResolutionStatus {
    /// A reproduction proof exists AND names a fixture id in the catalogue.
    Resolved,
    /// No reproduction proof in the bundle for this tuple.
    MissingReproductionProof,
    /// A reproduction proof exists but names a fixture id absent from the
    /// public-fixture catalogue.
    UnknownPublicFixture,
}

impl FixtureResolutionStatus {
    fn is_resolved(self) -> bool {
        self == Self::Resolved
    }
}

// Findings

/// Why a claimed profile failed its regression run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegressionFindingKind {
    /// No reproduction proof, or the proof names an unknown public fixture.
    MissingFixtureEvidence,
    /// A key-gated crypto layer declares no secret-requirement metadata.
    MissingSecretRequirementMetadata,
    /// The embedded tuple overclaims (rolled up from the gate).
    OverclaimTuple,
    /// The tuple's diagnostics drifted from the recorded baseline.
    DiagnosticDrift,
}

impl RegressionFindingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingFixtureEvidence => "missing_fixture_evidence",
            Self::MissingSecretRequirementMetadata => "missing_secret_requirement_metadata",
            Self::OverclaimTuple => "overclaim_tuple",
            Self::DiagnosticDrift => "diagnostic_drift",
        }
    }
}

/// A typed regression finding. Names the tuple id + carries a redaction-safe
/// message (never a secret, path, or byte).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegressionFinding {
    pub tuple_id: String,
    pub kind: RegressionFindingKind,
    pub message: String,
}

impl RegressionFinding {
    fn new(tuple_id: &str, kind: RegressionFindingKind, message: impl Into<String>) -> Self {
        Self {
            tuple_id: tuple_id.to_string(),
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            tuple_id: redact_for_log_or_report(&self.tuple_id),
            kind: self.kind,
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The dedicated diagnostic-drift record: the recorded vs current diagnostic
/// fingerprints for a tuple. Surfacing this — rather than rewriting the
/// baseline — is the whole point of the regression runner. `baselineFingerprint`
/// is `None` when the tuple was never baselined (also a drift).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriftFinding {
    pub tuple_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_fingerprint: Option<ProofHash>,
    pub current_fingerprint: ProofHash,
    pub message: String,
}

impl DriftFinding {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            tuple_id: redact_for_log_or_report(&self.tuple_id),
            baseline_fingerprint: self.baseline_fingerprint.clone(),
            current_fingerprint: self.current_fingerprint.clone(),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

// Result artifact

/// One tuple's regression result. Embeds the entry report (which
/// records engine family, variant, container, crypto, codec, surface,
/// patch-back mode, secret-requirement ids, and diagnostics), plus the
/// resolution / secret-metadata / drift verdicts and the rolled-up pass/fail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegressionTupleResult {
    pub tuple_id: String,
    /// The recorded tuple fields + author/validator diagnostics + overclaim gate.
    pub entry: ClaimedSupportEntryReport,
    pub fixture_resolution: FixtureResolutionStatus,
    /// The resolved public fixture id, when resolution succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_fixture_id: Option<String>,
    pub secret_metadata: SecretMetadataStatus,
    /// The current merged-diagnostic fingerprint (what a re-baseline would store).
    pub diagnostics_fingerprint: ProofHash,
    pub findings: Vec<RegressionFinding>,
    /// The drift record, when the diagnostics changed vs the baseline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drift: Option<DriftFinding>,
    pub status: OperationStatus,
}

impl RegressionTupleResult {
    /// True iff the tuple passed the regression run.
    pub fn is_passed(&self) -> bool {
        self.status == OperationStatus::Passed
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            tuple_id: redact_for_log_or_report(&self.tuple_id),
            entry: self.entry.redacted_for_report(),
            fixture_resolution: self.fixture_resolution,
            resolved_fixture_id: self
                .resolved_fixture_id
                .as_deref()
                .map(redact_for_log_or_report),
            secret_metadata: self.secret_metadata,
            diagnostics_fingerprint: self.diagnostics_fingerprint.clone(),
            findings: self
                .findings
                .iter()
                .map(RegressionFinding::redacted_for_report)
                .collect(),
            drift: self.drift.as_ref().map(DriftFinding::redacted_for_report),
            status: self.status.clone(),
        }
    }
}

/// The aggregate regression report — one result artifact per bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedProfileRegressionReport {
    pub schema_version: String,
    pub boundary: String,
    pub bundle_id: String,
    pub status: OperationStatus,
    pub tuple_count: u64,
    pub passed_count: u64,
    pub failed_count: u64,
    pub drift_count: u64,
    pub results: Vec<RegressionTupleResult>,
}

impl ClaimedProfileRegressionReport {
    /// True iff every claimed profile passed the regression run.
    pub fn is_clean(&self) -> bool {
        self.status == OperationStatus::Passed
    }

    /// The result for `tuple_id`, if present.
    pub fn result(&self, tuple_id: &str) -> Option<&RegressionTupleResult> {
        self.results.iter().find(|r| r.tuple_id == tuple_id)
    }

    /// Every finding of `kind` across all tuples.
    pub fn findings_of(&self, kind: RegressionFindingKind) -> Vec<&RegressionFinding> {
        self.results
            .iter()
            .flat_map(|r| r.findings.iter())
            .filter(|f| f.kind == kind)
            .collect()
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            boundary: redact_for_log_or_report(&self.boundary),
            bundle_id: redact_for_log_or_report(&self.bundle_id),
            status: self.status.clone(),
            tuple_count: self.tuple_count,
            passed_count: self.passed_count,
            failed_count: self.failed_count,
            drift_count: self.drift_count,
            results: self
                .results
                .iter()
                .map(RegressionTupleResult::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// The runner

/// Resolve a single tuple against the bundle's reproduction proofs + the
/// catalogue.
fn resolve_fixture(
    bundle: &ReproBundle,
    catalogue: &PublicFixtureCatalogue,
    tuple: &ClaimedSupportTuple,
) -> (FixtureResolutionStatus, Option<String>) {
    let tuple_id = tuple.profile_or_fixture_id.as_str();
    match bundle
        .reproduction_proofs
        .iter()
        .find(|proof| proof.tuple_id == tuple_id)
    {
        None => (FixtureResolutionStatus::MissingReproductionProof, None),
        Some(proof) if catalogue.contains(&proof.fixture_id) => (
            FixtureResolutionStatus::Resolved,
            Some(proof.fixture_id.clone()),
        ),
        Some(_) => (FixtureResolutionStatus::UnknownPublicFixture, None),
    }
}

/// Run one claimed profile against its fixture/proof + the recorded baseline.
fn run_one(
    bundle: &ReproBundle,
    catalogue: &PublicFixtureCatalogue,
    baseline: &RegressionBaseline,
    tuple: &ClaimedSupportTuple,
) -> RegressionTupleResult {
    let tuple_id = tuple.profile_or_fixture_id.clone();

    // 1. The anti-overclaim gate + recorded tuple fields.
    let entry = validate_claimed_support_tuple(tuple);
    let mut findings: Vec<RegressionFinding> = Vec::new();

    if entry.status == OperationStatus::Failed {
        findings.push(RegressionFinding::new(
            &tuple_id,
            RegressionFindingKind::OverclaimTuple,
            "the embedded support tuple overclaims (KAIFUU-105 anti-overclaim gate failed)",
        ));
    }

    // 2. Fixture-evidence resolution (fail on missing / unknown).
    let (fixture_resolution, resolved_fixture_id) = resolve_fixture(bundle, catalogue, tuple);
    if !fixture_resolution.is_resolved() {
        let reason = match fixture_resolution {
            FixtureResolutionStatus::MissingReproductionProof => {
                "no reproduction proof pins a public fixture for this claim"
            }
            FixtureResolutionStatus::UnknownPublicFixture => {
                "the reproduction proof names a fixture id absent from the KAIFUU-051 catalogue"
            }
            FixtureResolutionStatus::Resolved => unreachable!(),
        };
        findings.push(RegressionFinding::new(
            &tuple_id,
            RegressionFindingKind::MissingFixtureEvidence,
            reason,
        ));
    }

    // 3. Secret-requirement metadata gate (fail on missing).
    let secret_metadata = if crypto_requires_secret(tuple.crypto) {
        if tuple.secret_requirement_ids.is_empty() {
            findings.push(RegressionFinding::new(
                &tuple_id,
                RegressionFindingKind::MissingSecretRequirementMetadata,
                "a key-gated crypto layer declares no secretRequirementIds metadata",
            ));
            SecretMetadataStatus::Missing
        } else {
            SecretMetadataStatus::Declared
        }
    } else {
        SecretMetadataStatus::NotRequired
    };

    // 4. Diagnostic drift vs the recorded baseline (finding, never a rewrite).
    let current_fingerprint = diagnostics_fingerprint(&entry.diagnostics);
    let baseline_fingerprint = baseline.fingerprint_of(&tuple_id).cloned();
    let drift = match &baseline_fingerprint {
        Some(recorded) if *recorded == current_fingerprint => None,
        Some(_) => Some(DriftFinding {
            tuple_id: tuple_id.clone(),
            baseline_fingerprint: baseline_fingerprint.clone(),
            current_fingerprint: current_fingerprint.clone(),
            message: "diagnostics changed vs the recorded baseline (compatibility drift)"
                .to_string(),
        }),
        None => Some(DriftFinding {
            tuple_id: tuple_id.clone(),
            baseline_fingerprint: None,
            current_fingerprint: current_fingerprint.clone(),
            message: "no recorded baseline for this claim; a new tuple must be baselined \
                      deliberately, not silently passed"
                .to_string(),
        }),
    };
    if drift.is_some() {
        findings.push(RegressionFinding::new(
            &tuple_id,
            RegressionFindingKind::DiagnosticDrift,
            "diagnostics drifted from the recorded baseline",
        ));
    }

    let status = if findings.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    RegressionTupleResult {
        tuple_id,
        entry,
        fixture_resolution,
        resolved_fixture_id,
        secret_metadata,
        diagnostics_fingerprint: current_fingerprint,
        findings,
        drift,
        status,
    }
}

/// Run the claimed-profile regression: re-run every tuple in `bundle`
/// against the `catalogue`, the bundle's reproduction proofs, and the
/// recorded `baseline`. Never panics, never returns `Err`.
/// The report FAILS iff any claim is missing fixture evidence, is missing
/// required secret metadata, overclaims, or has drifted from the baseline.
pub fn run_claimed_profile_regression(
    bundle: &ReproBundle,
    catalogue: &PublicFixtureCatalogue,
    baseline: &RegressionBaseline,
) -> ClaimedProfileRegressionReport {
    let results: Vec<RegressionTupleResult> = bundle
        .support_tuples
        .iter()
        .map(|tuple| run_one(bundle, catalogue, baseline, tuple))
        .collect();

    let passed_count = results.iter().filter(|r| r.is_passed()).count() as u64;
    let failed_count = results.len() as u64 - passed_count;
    let drift_count = results.iter().filter(|r| r.drift.is_some()).count() as u64;
    let status = if failed_count == 0 {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    ClaimedProfileRegressionReport {
        schema_version: REGRESSION_REPORT_SCHEMA_VERSION.to_string(),
        boundary: REGRESSION_BOUNDARY.to_string(),
        bundle_id: bundle.bundle_id.clone(),
        status,
        tuple_count: results.len() as u64,
        passed_count,
        failed_count,
        drift_count,
        results,
    }
}

// Fixtures — the catalogue + recorded baseline for the clean bundle

/// Synthetic regression fixtures over the clean reproduction bundle
/// the matching public-fixture catalogue + a recorded baseline that
/// makes a fresh run validate green.
pub mod fixtures {
    use super::*;
    use crate::repro_bundle::fixtures as bundle_fixtures;

    /// The public fixture ids the clean bundle's reproduction proofs pin. A
    /// third party runs exactly these — nothing private.
    pub fn public_catalogue() -> PublicFixtureCatalogue {
        PublicFixtureCatalogue::new([
            "public/siglus-known-key-extract".to_string(),
            "public/kirikiri-kag-plaintext-patch".to_string(),
        ])
    }

    /// The recorded diagnostic baseline for the clean bundle — the last-known-good
    /// fingerprints a fresh clean run must reproduce.
    pub fn baseline() -> RegressionBaseline {
        RegressionBaseline::from_bundle(&bundle_fixtures::clean_bundle())
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use crate::repro_bundle::fixtures as bundle_fixtures;

    #[test]
    #[ignore = "developer helper: regenerates the committed regression fixtures"]
    fn emit_committed_fixtures() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/kaifuu/compat-regression");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("public-fixture-catalogue.json"),
            format!("{}\n", stable_json(&public_catalogue()).unwrap()),
        )
        .unwrap();
        std::fs::write(
            dir.join("baseline.json"),
            format!("{}\n", stable_json(&baseline()).unwrap()),
        )
        .unwrap();
    }

    #[test]
    fn clean_run_passes_and_records_every_tuple_field() {
        let bundle = bundle_fixtures::clean_bundle();
        let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline());

        assert!(report.is_clean(), "{report:#?}");
        assert_eq!(report.status, OperationStatus::Passed);
        assert_eq!(report.tuple_count, bundle.support_tuples.len() as u64);
        assert_eq!(report.passed_count, report.tuple_count);
        assert_eq!(report.failed_count, 0);
        assert_eq!(report.drift_count, 0);

        // Every recorded tuple field survives the round-trip through the result.
        for tuple in &bundle.support_tuples {
            let result = report
                .result(&tuple.profile_or_fixture_id)
                .expect("every tuple has a result");
            assert!(result.is_passed());
            assert_eq!(result.fixture_resolution, FixtureResolutionStatus::Resolved);
            assert!(result.resolved_fixture_id.is_some());
            assert!(result.findings.is_empty());
            assert!(result.drift.is_none());
            // The embedded entry records all ten identity/transform fields.
            assert_eq!(result.entry.engine_family, tuple.engine_family);
            assert_eq!(result.entry.engine_variant, tuple.engine_variant);
            assert_eq!(result.entry.container, tuple.container);
            assert_eq!(result.entry.crypto, tuple.crypto);
            assert_eq!(result.entry.codec, tuple.codec);
            assert_eq!(result.entry.surface, tuple.surface);
            assert_eq!(result.entry.patch_back_mode, tuple.patch_back_mode);
            assert_eq!(
                result.entry.secret_requirement_ids,
                tuple.secret_requirement_ids
            );
            assert!(!result.entry.diagnostics.is_empty());
        }
    }

    #[test]
    fn missing_reproduction_proof_fails_the_claim() {
        // Drop the reproduction proof for the first tuple → missing fixture
        // evidence. NOT a skip, NOT a silent pass.
        let mut bundle = bundle_fixtures::clean_bundle();
        let orphaned = bundle.support_tuples[0].profile_or_fixture_id.clone();
        bundle
            .reproduction_proofs
            .retain(|proof| proof.tuple_id != orphaned);

        let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline());
        assert_eq!(report.status, OperationStatus::Failed);
        let result = report.result(&orphaned).expect("result present");
        assert!(!result.is_passed());
        assert_eq!(
            result.fixture_resolution,
            FixtureResolutionStatus::MissingReproductionProof
        );
        assert!(
            !report
                .findings_of(RegressionFindingKind::MissingFixtureEvidence)
                .is_empty()
        );
    }

    #[test]
    fn unknown_public_fixture_fails_the_claim() {
        // The proof resolves to a tuple, but the fixture id is not in the
        // catalogue → not reproducible → fail.
        let bundle = bundle_fixtures::clean_bundle();
        let empty_catalogue = PublicFixtureCatalogue::new([]);
        let report = run_claimed_profile_regression(&bundle, &empty_catalogue, &baseline());
        assert_eq!(report.status, OperationStatus::Failed);
        for result in &report.results {
            assert_eq!(
                result.fixture_resolution,
                FixtureResolutionStatus::UnknownPublicFixture
            );
            assert!(!result.is_passed());
        }
        assert_eq!(
            report
                .findings_of(RegressionFindingKind::MissingFixtureEvidence)
                .len(),
            report.results.len()
        );
    }

    #[test]
    fn missing_secret_requirement_metadata_fails_the_claim() {
        // The siglus tuple's crypto is a fixed key → it MUST declare secret
        // requirement metadata. Strip it → fail (not a silent pass).
        let mut bundle = bundle_fixtures::clean_bundle();
        let siglus_id = {
            let siglus = bundle
                .support_tuples
                .iter_mut()
                .find(|t| crypto_requires_secret(t.crypto))
                .expect("clean bundle has a key-gated tuple");
            assert!(!siglus.secret_requirement_ids.is_empty());
            siglus.secret_requirement_ids.clear();
            siglus.profile_or_fixture_id.clone()
        };
        // Re-baseline so the drift gate does not also fire (isolate the cause):
        // clearing secret metadata does not change the typed diagnostics.
        let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline());
        let result = report.result(&siglus_id).expect("result present");
        assert_eq!(result.secret_metadata, SecretMetadataStatus::Missing);
        assert!(!result.is_passed());
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(
            !report
                .findings_of(RegressionFindingKind::MissingSecretRequirementMetadata)
                .is_empty()
        );
    }

    #[test]
    fn diagnostic_drift_is_surfaced_not_silently_updated() {
        // Baseline the clean bundle, then mutate a tuple's declared diagnostics.
        // The runner must SURFACE the change as drift — and must NOT rewrite the
        // recorded baseline.
        let recorded = baseline();
        let recorded_before = recorded.clone();

        let mut bundle = bundle_fixtures::clean_bundle();
        let drifted_id = {
            let tuple = &mut bundle.support_tuples[0];
            tuple.diagnostics.push(CompatDiagnostic::new(
                crate::compat_profile::CompatLayer::Runtime,
                crate::compat_profile::CompatDiagnosticStatus::NotImplemented,
                crate::SemanticErrorCode::UnsupportedLayeredTransform,
                crate::PartialDiagnosticSeverity::P3,
            ));
            tuple.profile_or_fixture_id.clone()
        };

        let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &recorded);
        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(report.drift_count, 1);

        let result = report.result(&drifted_id).expect("result present");
        assert!(!result.is_passed());
        let drift = result.drift.as_ref().expect("drift recorded");
        assert!(drift.baseline_fingerprint.is_some());
        assert_ne!(
            drift.baseline_fingerprint.as_ref().unwrap(),
            &drift.current_fingerprint
        );
        assert!(
            !report
                .findings_of(RegressionFindingKind::DiagnosticDrift)
                .is_empty()
        );
        // The recorded baseline was NOT silently updated by the run.
        assert_eq!(recorded, recorded_before);
    }

    #[test]
    fn unbaselined_tuple_is_drift_not_silent_pass() {
        // A tuple absent from the recorded baseline must not silently pass — it
        // drifts (with no baseline fingerprint) until deliberately baselined.
        let bundle = bundle_fixtures::clean_bundle();
        let empty_baseline = RegressionBaseline {
            schema_version: REGRESSION_BASELINE_SCHEMA_VERSION.to_string(),
            entries: vec![],
        };
        let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &empty_baseline);
        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(report.drift_count, report.tuple_count);
        for result in &report.results {
            let drift = result.drift.as_ref().expect("unbaselined → drift");
            assert!(drift.baseline_fingerprint.is_none());
        }
    }

    #[test]
    fn overclaim_tuple_fails_the_regression() {
        // A bundle embedding an overclaiming tuple fails via the rolled-up
        // gate — even with a resolvable fixture + baseline.
        let mut bundle = bundle_fixtures::clean_bundle();
        let overclaim = crate::compat_profile::fixtures::overclaim_patch_without_evidence();
        let overclaim_id = overclaim.profile_or_fixture_id.clone();
        bundle
            .reproduction_proofs
            .push(crate::repro_bundle::ReproductionProof::new(
                overclaim_id.clone(),
                "public/siglus-known-key-extract",
                ProofHash::new(sha256_hash_bytes(b"overclaim")).unwrap(),
            ));
        bundle.support_tuples.push(overclaim);
        let baseline = RegressionBaseline::from_bundle(&bundle);

        let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline);
        assert_eq!(report.status, OperationStatus::Failed);
        let result = report.result(&overclaim_id).expect("result present");
        assert!(!result.is_passed());
        assert!(
            !report
                .findings_of(RegressionFindingKind::OverclaimTuple)
                .is_empty()
        );
    }

    #[test]
    fn result_artifact_is_redacted_and_ref_only() {
        let bundle = bundle_fixtures::clean_bundle();
        let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline());
        let json = report.stable_json().expect("serialize");
        // Ref-only: proof-hash refs + local-secret refs, no raw material.
        assert!(json.contains("sha256:"));
        assert!(json.contains("local-secret:"));
        assert!(!json.contains("BEGIN"));
        assert!(!json.contains("/home/"));
        assert!(!json.contains("deadbeef"));
    }

    #[test]
    fn fingerprint_is_stable_and_detail_insensitive() {
        // The typed-identity fingerprint ignores free-text detail: a detail-only
        // change is NOT drift, a typed-field change IS.
        let base = bundle_fixtures::clean_bundle().support_tuples[0]
            .diagnostics
            .clone();
        let mut detail_only = base.clone();
        detail_only[0].detail = Some("a completely different, longer human note".to_string());
        assert_eq!(
            diagnostics_fingerprint(&base),
            diagnostics_fingerprint(&detail_only),
            "detail-only change must not register as drift"
        );

        let mut typed_change = base.clone();
        typed_change[0].severity = crate::PartialDiagnosticSeverity::P0;
        assert_ne!(
            diagnostics_fingerprint(&base),
            diagnostics_fingerprint(&typed_change),
            "a typed-field change must register as drift"
        );
    }
}
