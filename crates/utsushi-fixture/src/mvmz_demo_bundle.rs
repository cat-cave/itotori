//! The MV/MZ **embedded playback demo bundle**.
//!
//! This node does NOT prove anything new. It PACKAGES the already-merged MV/MZ
//! patched-output proof surfaces into ONE self-contained, verifiable demo
//! descriptor a public playback surface can render without a live game or any
//! copyrighted bytes. Every field it emits is lifted from a committed artifact
//! by id / hash / verdict — it never re-derives the E1 proof.
//!
//! ## What it packages
//!
//! ```text
//! patched runtime proof proof.golden.json -> proofLinks.patchedRuntimeProof
//! alpha proof alpha-proof.json -> proofLinks.alphaProof
//! Kaifuu PatchResult (119) patch-result.json -> proofLinks.patchResult
//! patched runtime trace patched-runtime-trace.json -> observationEnvelope (text/choices)
//! review-package manifest manifest.golden.json -> reviewManifest
//! screenshot evidence evidence.golden.json -> captureRefs (validated)
//! ```
//!
//! ## The crux
//!
//! The bundle opens a public **patched MV/MZ fixture playback surface** and
//! links the observed text / choices to bridge unit refs (via the observation
//! envelope), while its capture references are **validated** — each screenshot
//! artifactRef resolves to a managed runtime URI, a deterministic content-
//! addressed ref hash, a bridge unit ref, and the trace event it evidences. The
//! bundle's own validation re-checks that the packaged proof verdicts are proven
//! E1, that the packaged 065 captures agree with the 010 review manifest's
//! screenshot refs, and that the observation covers the units the 119 proof
//! proved reachable. It is a coherent index over the existing artifacts, not a
//! re-derivation of them.

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use utsushi_core::UtsushiResult;

use crate::mv_mz_review_package::REVIEW_PACKAGE_MANIFEST_KIND;
use crate::mv_mz_screenshot_evidence::deterministic_uuid7;
use crate::mvmz_patched_runtime_proof::PATCHED_RUNTIME_PROOF_KIND;
use crate::mvmz_runtime_proof::RUNTIME_OBSERVATION_PROOF_KIND;

/// Schema version of the demo-bundle manifest wire shape.
pub const DEMO_BUNDLE_SCHEMA_VERSION: &str = "0.1.0";

/// Kind discriminant stamped on every demo-bundle manifest.
pub const DEMO_BUNDLE_KIND: &str = "utsushi.mvmz.embedded_playback_demo_bundle";

/// Namespace the bundle mints its deterministic id under.
const DEMO_BUNDLE_UUID_NAMESPACE: &str = "utsushi-u134:mvmz-demo-bundle";

/// The prefix every managed runtime artifact URI must carry. Kept in sync with
/// the runtime-web-review `isManagedRuntimeUri` guard.
const MANAGED_ARTIFACT_URI_ROOT: &str = "artifacts/utsushi/runtime/";

/// The evidence tier the packaged patched observation proves.
const EVIDENCE_TIER_E1: &str = "E1";

// --- Bundle-validation check identifiers (stable, machine-readable) --------

/// The packaged patched proof is proven at E1.
pub const CHECK_PATCHED_PROOF_PROVEN_E1: &str = "patched_proof_proven_e1";
/// The packaged alpha proof is proven at E1.
pub const CHECK_ALPHA_PROOF_PROVEN_E1: &str = "alpha_proof_proven_e1";
/// The PatchResult status is passed and its outputHash matches the patched
/// proof's attestation — the packaged patch links are internally consistent.
pub const CHECK_PATCH_RESULT_CONSISTENT: &str = "patch_result_consistent";
/// Every observation-envelope event links to a bridge unit ref (id + key).
pub const CHECK_OBSERVATION_EVENTS_BRIDGE_LINKED: &str = "observation_events_bridge_linked";
/// The observation envelope covers every bridge unit the 119 proof proved.
pub const CHECK_OBSERVATION_COVERS_PROVEN_UNITS: &str = "observation_covers_proven_units";
/// Every packaged screenshot capture reference validated (managed URI + fields).
pub const CHECK_CAPTURE_REFS_VALIDATED: &str = "capture_refs_validated";
/// Every packaged 065 capture is also named by the 010 review manifest's
/// screenshot artifact refs — the two evidence surfaces agree.
pub const CHECK_CAPTURES_AGREE_WITH_REVIEW_MANIFEST: &str = "captures_agree_with_review_manifest";
/// The packaged review manifest carries the manifest kind.
pub const CHECK_REVIEW_MANIFEST_KIND: &str = "review_manifest_kind";

/// The committed artifacts a demo bundle packages.
pub struct DemoBundleInputs<'a> {
    /// patched-runtime-observation proof (`proof.golden.json`).
    pub patched_runtime_proof: &'a Value,
    /// alpha runtime-observation proof (`alpha-proof.json`).
    pub alpha_proof: &'a Value,
    /// The Kaifuu `PatchResult` whose `outputHash` attests the patched output.
    pub patch_result: &'a Value,
    /// patched runtime trace — the observed text / choices source.
    pub patched_runtime_trace: &'a Value,
    /// review-package manifest (`manifest.golden.json`).
    pub review_manifest: &'a Value,
    /// screenshot capture evidence (`evidence.golden.json`).
    pub screenshot_evidence: &'a Value,
}

/// One bundle-validation check result.
mod observation;
use observation::*;
/// Build the MV/MZ embedded playback demo bundle manifest by PACKAGING the
/// committed artifacts. The verdict is `bundleValid: true` iff every packaging-
/// coherence check passes.
pub fn build_mvmz_demo_bundle(inputs: &DemoBundleInputs) -> UtsushiResult<Value> {
    let mut checks: Vec<Check> = Vec::new();

    // --- Observation envelope (the playback text / choices) ----------------
    let observation_envelope = build_observation_envelope(inputs.patched_runtime_trace);
    let envelope_events = observation_envelope
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // --- Capture references (validated) ------------------------------------
    let empty = Vec::new();
    let raw_captures = inputs
        .screenshot_evidence
        .get("captures")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut packaged_captures: Vec<Value> = Vec::new();
    let mut all_captures_validated = !raw_captures.is_empty();
    for capture in raw_captures {
        let (packaged, validated) = validate_capture(capture);
        all_captures_validated = all_captures_validated && validated;
        packaged_captures.push(packaged);
    }

    // --- Proof links (packaged, not re-derived) ----------------------------
    let patched_proven = inputs
        .patched_runtime_proof
        .get("patchedRuntimeObservationProven")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let patched_tier = inputs
        .patched_runtime_proof
        .get("provenEvidenceTier")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let patched_kind = inputs
        .patched_runtime_proof
        .get("proofKind")
        .and_then(Value::as_str)
        .unwrap_or("");
    let patched_proof_output_hash = inputs
        .patched_runtime_proof
        .get("patchAttestation")
        .and_then(|a| a.get("patchResultOutputHash"))
        .and_then(Value::as_str)
        .unwrap_or("");
    checks.push(Check {
        id: CHECK_PATCHED_PROOF_PROVEN_E1,
        passed: patched_proven
            && patched_tier == EVIDENCE_TIER_E1
            && patched_kind == PATCHED_RUNTIME_PROOF_KIND,
        detail: format!(
            "packaged patched runtime proof proofKind={patched_kind} \
             patchedRuntimeObservationProven={patched_proven} provenEvidenceTier={patched_tier}; \
             expected the patched proof proven at E1"
        ),
    });

    let alpha_proven = inputs
        .alpha_proof
        .get("runtimeObservationProven")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let alpha_tier = inputs
        .alpha_proof
        .get("provenEvidenceTier")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let alpha_kind = inputs
        .alpha_proof
        .get("proofKind")
        .and_then(Value::as_str)
        .unwrap_or("");
    checks.push(Check {
        id: CHECK_ALPHA_PROOF_PROVEN_E1,
        passed: alpha_proven
            && alpha_tier == EVIDENCE_TIER_E1
            && alpha_kind == RUNTIME_OBSERVATION_PROOF_KIND,
        detail: format!(
            "packaged runtime-observation proof proofKind={alpha_kind} \
             runtimeObservationProven={alpha_proven} provenEvidenceTier={alpha_tier}; expected the \
             alpha proof proven at E1"
        ),
    });

    let patch_status = inputs
        .patch_result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("<absent>");
    let patch_output_hash = inputs
        .patch_result
        .get("outputHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    let patch_consistent = patch_status.eq_ignore_ascii_case("passed")
        && !patch_output_hash.is_empty()
        && patch_output_hash == patched_proof_output_hash;
    checks.push(Check {
        id: CHECK_PATCH_RESULT_CONSISTENT,
        passed: patch_consistent,
        detail: format!(
            "PatchResult status={patch_status} outputHash={patch_output_hash}; patched-proof \
             attestation outputHash={patched_proof_output_hash}; expected status=passed and the \
             two hashes to agree"
        ),
    });

    // --- Observation coherence ---------------------------------------------
    let unlinked = envelope_events
        .iter()
        .filter(|event| {
            let bridge = event.get("bridgeUnitRef");
            let has_id = bridge
                .and_then(|b| b.get("bridgeUnitId"))
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty());
            let has_key = bridge
                .and_then(|b| b.get("sourceUnitKey"))
                .and_then(Value::as_str)
                .is_some_and(|k| !k.is_empty());
            !(has_id && has_key)
        })
        .count();
    checks.push(Check {
        id: CHECK_OBSERVATION_EVENTS_BRIDGE_LINKED,
        passed: !envelope_events.is_empty() && unlinked == 0,
        detail: format!(
            "{} observation event(s), {unlinked} missing a bridge unit ref; every observed \
             text/choice must link to a bridge unit ref",
            envelope_events.len()
        ),
    });

    let proven_units: Vec<String> = inputs
        .patched_runtime_proof
        .get("baseRuntimeObservationProof")
        .and_then(|b| b.get("observation"))
        .and_then(|o| o.get("observedBridgeUnitIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let envelope_units = envelope_bridge_unit_ids(&observation_envelope);
    let covers_proven = !proven_units.is_empty()
        && proven_units
            .iter()
            .all(|unit| envelope_units.contains(unit));
    checks.push(Check {
        id: CHECK_OBSERVATION_COVERS_PROVEN_UNITS,
        passed: covers_proven,
        detail: format!(
            "patched proof proved bridge units {proven_units:?}; observation envelope covers \
             {envelope_units:?}; every proven unit must appear in the playback envelope"
        ),
    });

    // --- Capture validation + review-manifest agreement --------------------
    checks.push(Check {
        id: CHECK_CAPTURE_REFS_VALIDATED,
        passed: all_captures_validated,
        detail: format!(
            "{} packaged screenshot capture reference(s); every one must resolve to a managed \
             runtime URI, a screenshot artifact kind + media type + byte size, a bridge unit ref, \
             and the trace event it evidences",
            packaged_captures.len()
        ),
    });

    let review_ids = review_manifest_screenshot_ids(inputs.review_manifest);
    let capture_ids: Vec<String> = packaged_captures
        .iter()
        .filter_map(|c| {
            c.get("artifactRef")
                .and_then(|a| a.get("artifactId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let captures_agree =
        !capture_ids.is_empty() && capture_ids.iter().all(|id| review_ids.contains(id));
    checks.push(Check {
        id: CHECK_CAPTURES_AGREE_WITH_REVIEW_MANIFEST,
        passed: captures_agree,
        detail: format!(
            "{} packaged 065 capture(s); the 010 review manifest names screenshot artifact ids \
             {review_ids:?}; every packaged capture must also be named by the review manifest",
            capture_ids.len()
        ),
    });

    let review_kind = inputs
        .review_manifest
        .get("manifestKind")
        .and_then(Value::as_str)
        .unwrap_or("");
    checks.push(Check {
        id: CHECK_REVIEW_MANIFEST_KIND,
        passed: review_kind == REVIEW_PACKAGE_MANIFEST_KIND,
        detail: format!(
            "review manifest manifestKind={review_kind}; expected {REVIEW_PACKAGE_MANIFEST_KIND}"
        ),
    });

    let bundle_valid = checks.iter().all(|check| check.passed);

    let patched_proof_id = inputs
        .patched_runtime_proof
        .get("proofId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let review_package_id = inputs
        .review_manifest
        .get("reviewPackageId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let bundle_id = deterministic_uuid7(
        DEMO_BUNDLE_UUID_NAMESPACE,
        &format!("bundle-{patched_proof_id}-{review_package_id}"),
    );

    let source_locale = inputs
        .patched_runtime_trace
        .get("sourceLocale")
        .cloned()
        .unwrap_or_else(|| json!("ja-JP"));
    let target_locale = inputs
        .review_manifest
        .get("targetLocale")
        .cloned()
        .unwrap_or_else(|| json!("en-US"));

    let limitations = vec![
        "Embedded playback demo bundle PACKAGES the committed proof, capture, and review artifacts by \
         id / hash / verdict; it re-derives none of the proofs it links."
            .to_string(),
        "Public synthetic MV/MZ fixture only. The playback surface opens the patched fixture's \
         observed text / choices + screenshot artifact references — never a live game and never \
         copyrighted bytes or pixels."
            .to_string(),
        "Screenshot captures are surfaced as managed runtime artifact URIs + content-addressed ref \
         hashes; the bundle embeds no pixels."
            .to_string(),
    ];

    Ok(json!({
        "schemaVersion": DEMO_BUNDLE_SCHEMA_VERSION,
        "bundleKind": DEMO_BUNDLE_KIND,
        "bundleId": bundle_id,
        "engine": "rpg_maker_mv_mz",
        "createdAt": inputs
            .review_manifest
            .get("createdAt")
            .cloned()
            .unwrap_or_else(|| json!("2026-06-17T00:00:00.000Z")),
        "bundleValid": bundle_valid,
        "provenEvidenceTier": if bundle_valid { EVIDENCE_TIER_E1 } else { "none" },
        "sourceLocale": source_locale,
        "targetLocale": target_locale,
        "playbackSurface": {
            "surfaceKind": "patched_mvmz_fixture",
            "runtimeTargetId": observation_envelope.get("runtimeTargetId").cloned().unwrap_or(Value::Null),
            "sourceRevision": inputs
                .patched_runtime_trace
                .get("observationHookEvents")
                .and_then(Value::as_array)
                .and_then(|events| events.first())
                .and_then(|e| e.get("sourceRevision"))
                .cloned()
                .unwrap_or(Value::Null),
            // The bundle is DATA: a public playback surface renders it with no
            // live game process. This flag makes that explicit for the renderer.
            "live": false,
            "public": true,
        },
        "observationEnvelope": observation_envelope,
        "captureRefs": {
            "availability": if packaged_captures.is_empty() { "unavailable" } else { "available" },
            "refs": packaged_captures,
        },
        "reviewManifest": {
            "reviewPackageId": inputs.review_manifest.get("reviewPackageId").cloned().unwrap_or(Value::Null),
            "manifestKind": inputs.review_manifest.get("manifestKind").cloned().unwrap_or(Value::Null),
            "screenshotArtifactCount": review_ids.len(),
            "source": "synthetic-fixture",
        },
        "proofLinks": {
            "patchedRuntimeProof": {
                "source": "synthetic-fixture",
                "proofKind": inputs.patched_runtime_proof.get("proofKind").cloned().unwrap_or(Value::Null),
                "proofId": inputs.patched_runtime_proof.get("proofId").cloned().unwrap_or(Value::Null),
                "patchedRuntimeObservationProven": patched_proven,
                "provenEvidenceTier": inputs.patched_runtime_proof.get("provenEvidenceTier").cloned().unwrap_or(Value::Null),
                "patchResultOutputHash": patched_proof_output_hash,
            },
            "alphaProof": {
                "source": "synthetic-fixture",
                "proofKind": inputs.alpha_proof.get("proofKind").cloned().unwrap_or(Value::Null),
                "proofId": inputs.alpha_proof.get("proofId").cloned().unwrap_or(Value::Null),
                "runtimeObservationProven": alpha_proven,
                "provenEvidenceTier": inputs.alpha_proof.get("provenEvidenceTier").cloned().unwrap_or(Value::Null),
            },
            "patchResult": {
                "patchResultId": inputs.patch_result.get("patchResultId").cloned().unwrap_or(Value::Null),
                "patchExportId": inputs.patch_result.get("patchExportId").cloned().unwrap_or(Value::Null),
                "status": inputs.patch_result.get("status").cloned().unwrap_or(Value::Null),
                "outputHash": inputs.patch_result.get("outputHash").cloned().unwrap_or(Value::Null),
            },
            "screenshotEvidence": {
                "source": "synthetic-fixture",
                "runtimeReportId": inputs.screenshot_evidence.get("runtimeReportId").cloned().unwrap_or(Value::Null),
                "evidenceTier": inputs.screenshot_evidence.get("evidenceTier").cloned().unwrap_or(Value::Null),
                "captureCount": packaged_captures.len(),
            },
        },
        "validation": {
            "bundleValid": bundle_valid,
            "checks": checks.iter().map(Check::to_json).collect::<Vec<_>>(),
        },
        "limitations": limitations,
    }))
}

/// The IO shell: read every committed artifact by path and delegate to
/// [`build_mvmz_demo_bundle`].
// reason: this is the byte-level IO shell that reads the six independent
// committed proof/capture/trace/manifest artifacts by their own on-disk paths;
// each path is a distinct filesystem input, so grouping them into a struct
// would just relocate the same arity onto the caller with no clarity gain.
#[allow(clippy::too_many_arguments)]
pub fn mvmz_demo_bundle_from_paths(
    patched_runtime_proof_path: &Path,
    alpha_proof_path: &Path,
    patch_result_path: &Path,
    patched_runtime_trace_path: &Path,
    review_manifest_path: &Path,
    screenshot_evidence_path: &Path,
) -> UtsushiResult<Value> {
    let read = |path: &Path| -> UtsushiResult<Value> {
        Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
    };
    let patched_runtime_proof = read(patched_runtime_proof_path)?;
    let alpha_proof = read(alpha_proof_path)?;
    let patch_result = read(patch_result_path)?;
    let patched_runtime_trace = read(patched_runtime_trace_path)?;
    let review_manifest = read(review_manifest_path)?;
    let screenshot_evidence = read(screenshot_evidence_path)?;

    build_mvmz_demo_bundle(&DemoBundleInputs {
        patched_runtime_proof: &patched_runtime_proof,
        alpha_proof: &alpha_proof,
        patch_result: &patch_result,
        patched_runtime_trace: &patched_runtime_trace,
        review_manifest: &review_manifest,
        screenshot_evidence: &screenshot_evidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_managed(uri: &str) -> bool {
        is_managed_artifact_uri(uri)
    }

    #[test]
    fn managed_uri_guard_matches_the_ts_renderer_rules() {
        assert!(is_managed(
            "artifacts/utsushi/runtime/58a98a57/screenshots/abc.png"
        ));
        assert!(!is_managed("/abs/artifacts/utsushi/runtime/x.png"));
        assert!(!is_managed("file://artifacts/utsushi/runtime/x.png"));
        assert!(!is_managed(
            "artifacts/utsushi/runtime/../../etc/passwd.png"
        ));
        assert!(!is_managed("data:image/png;base64,AAAA"));
        assert!(!is_managed("http://evil/artifacts/utsushi/runtime/x.png"));
        assert!(!is_managed("artifacts\\utsushi\\runtime\\x.png"));
        assert!(!is_managed("other/prefix/x.png"));
    }
}
