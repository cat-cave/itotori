//! UTSUSHI-119: the CAPSTONE MV/MZ **patched-output** runtime-observation proof.
//!
//! UTSUSHI-102 proved that a real launched Chromium observes the *fixture*
//! runtime output at evidence tier E1. This node extends that proof to the
//! **PATCHED** output: the fixture AFTER a Kaifuu patch-back swapped the
//! localized (translated) text in. It answers the load-bearing question — does
//! Utsushi observe the TRANSLATION a real launched render produced, provably the
//! post-patch content the Kaifuu `PatchResult` attests to, and not the pre-patch
//! original?
//!
//! ## What it consumes
//!
//! ```text
//! patched runtime trace   UTSUSHI-006 browser trace probe over the PATCHED   -> observation
//!                         fixture (real Chromium --dump-dom)
//! Kaifuu PatchResult      the patch-back result envelope; its outputHash      -> patch attestation
//!                         attests the patched (translated) output by HASH
//! alpha proof manifest    the UTSUSHI-102 runtime-observation proof — the     -> baseline continuity
//!                         just-merged alpha capstone this node builds on
//! ```
//!
//! ## Why a static read cannot forge the patched E1 observation
//!
//! Every strict-proof guarantee UTSUSHI-102 established is RE-DERIVED here over
//! the patched trace (not trusted from any self-declared verdict): the observed
//! translation must be live-DOM, E1-tiered, fully bridge-linked, and — the crux
//! — ABSENT from every consumed static input (the patched fixture bytes, the
//! PatchResult JSON, and the alpha proof JSON). The patched translation lives
//! ONLY inside the fixture's runtime base64 payload; the `PatchResult` carries
//! only a content hash, never the plaintext; the alpha proof carries only ids
//! and hashes. So no static read of any consumed input can surface the observed
//! translation — it can only have materialised from a live render.
//!
//! On top of that E1 floor this node adds the PATCH attestation:
//!
//! - **Provenance (it is THE patched output):** the canonical hash recomputed
//!   from the observed translated units must equal the `PatchResult.outputHash`.
//!   The observation therefore reproduces exactly the patched output the
//!   `PatchResult` attests to — not merely "some English."
//! - **Post-patch, not pre-patch:** every observed string must DIFFER from the
//!   pre-patch `sourceText` of its unit. The observation is provably the
//!   translated (patched) content, not the original the game shipped with.
//! - **Alpha continuity:** the consumed alpha proof must itself be a proven E1
//!   UTSUSHI-102 runtime-observation proof, and the patched observation must
//!   cover the same bridge units it proved reachable.
//!
//! ## Honest residual
//!
//! Like UTSUSHI-102, the guarantee is against LIFTING the observed text from a
//! consumed static input; an operator who hand-authors the correct translation
//! into a fabricated trace is out of scope (that is fabrication, not a static
//! read). The `outputHash` provenance link is what makes even a correctly-typed
//! string meaningful: it proves the observation matches a *specific* attested
//! patch, and the absent-from-static crux proves it was not lifted.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use utsushi_core::UtsushiResult;

use crate::mv_mz_screenshot_evidence::deterministic_uuid7;
use crate::mvmz_runtime_proof::{
    RUNTIME_OBSERVATION_PROOF_KIND, RuntimeObservationProofInputs,
    build_mvmz_runtime_observation_proof, read_static_fixture_source,
};

/// Schema version of the patched-runtime-observation-proof manifest wire shape.
pub const PATCHED_RUNTIME_PROOF_SCHEMA_VERSION: &str = "0.1.0";

/// Kind discriminant stamped on every patched-output proof manifest.
pub const PATCHED_RUNTIME_PROOF_KIND: &str = "utsushi.mvmz.patched_runtime_observation_proof";

/// Namespace the proof mints its deterministic ids under.
const PATCHED_RUNTIME_PROOF_UUID_NAMESPACE: &str = "utsushi-u119:mvmz-patched-runtime-proof";

/// The evidence tier a real launched-runtime patched observation claims.
const EVIDENCE_TIER_E1: &str = "E1";

// --- Check identifiers (stable, machine-readable) -------------------------

/// The patched trace passes the full UTSUSHI-102 E1 strict proof (live-DOM,
/// E1-tiered, fully linked, observed text absent from every static input).
pub const CHECK_BASE_RUNTIME_OBSERVATION_PROVEN_E1: &str = "base_runtime_observation_proven_e1";
/// The consumed Kaifuu PatchResult reports a passed patch-back.
pub const CHECK_PATCH_RESULT_STATUS_PASSED: &str = "patch_result_status_passed";
/// THE PROVENANCE CRUX: the hash recomputed from the observed translated units
/// equals the PatchResult.outputHash — the observation IS the attested patch.
pub const CHECK_PATCHED_OUTPUT_MATCHES_PATCH_RESULT_HASH: &str =
    "patched_output_matches_patch_result_hash";
/// THE POST-PATCH CRUX: every observed string differs from the pre-patch
/// sourceText of its unit — the observation is the translation, not the original.
pub const CHECK_OBSERVED_IS_TRANSLATION_NOT_PREPATCH_SOURCE: &str =
    "observed_text_is_translation_not_prepatch_source";
/// The consumed alpha proof is a proven E1 UTSUSHI-102 runtime-observation proof.
pub const CHECK_ALPHA_PROOF_BASELINE_E1: &str = "alpha_proof_manifest_baseline_e1_proven";
/// The patched observation covers the same bridge units the alpha proof proved.
pub const CHECK_PATCHED_UNITS_MATCH_ALPHA_PROOF_UNITS: &str =
    "patched_units_match_alpha_proof_units";

/// Inputs to the patched-runtime-observation proof.
pub struct PatchedRuntimeProofInputs<'a> {
    /// UTSUSHI-006 browser trace-probe output over the PATCHED fixture launch.
    pub patched_runtime_trace: &'a Value,
    /// The Kaifuu `PatchResult` whose `outputHash` attests the patched output.
    pub patch_result: &'a Value,
    /// The UTSUSHI-102 runtime-observation proof consumed as the alpha baseline.
    pub alpha_proof_manifest: &'a Value,
    /// Concatenated bytes of EVERY consumed static input: the patched fixture
    /// source, the PatchResult JSON, and the alpha proof JSON. The E1 crux
    /// confirms no observed translation is recoverable from any of them.
    pub combined_static_source: &'a str,
    /// Pre-patch `sourceText` per unit key, read from the patched fixture's
    /// `source.json`. The observation must differ from these originals.
    pub prepatch_source_texts: &'a BTreeMap<String, String>,
    /// Optional UTSUSHI-065 screenshot capture evidence.
    pub screenshot_evidence: Option<&'a Value>,
}

/// One strict-proof check result.
struct Check {
    id: &'static str,
    passed: bool,
    detail: String,
}

impl Check {
    fn to_json(&self) -> Value {
        json!({
            "checkId": self.id,
            "status": if self.passed { "pass" } else { "fail" },
            "mandatory": true,
            "detail": self.detail,
        })
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// The observation-hook events of a trace, or an empty slice.
fn observation_events(trace: &Value) -> &[Value] {
    trace
        .get("observationHookEvents")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

/// The bridge `sourceUnitKey` an observation event links to (its first bridge
/// ref), if any.
fn event_source_unit_key(event: &Value) -> Option<&str> {
    event
        .get("bridgeRefs")
        .and_then(Value::as_array)
        .and_then(|refs| refs.first())
        .and_then(|bridge| bridge.get("sourceUnitKey"))
        .and_then(Value::as_str)
}

/// Collect every observed (unit key -> translated string) pair from a patched
/// trace: dialogue text keyed by its bridge unit, and choice prompt + each
/// option label keyed by their own bridge units. This is the canonical patched
/// output the `PatchResult.outputHash` attests to.
fn observed_translated_units(trace: &Value) -> BTreeMap<String, String> {
    let mut units = BTreeMap::new();
    for event in observation_events(trace) {
        let payload = event.get("payload").unwrap_or(&Value::Null);
        match event.get("eventKind").and_then(Value::as_str) {
            Some("text") => {
                if let (Some(key), Some(text)) = (
                    event_source_unit_key(event),
                    payload.get("text").and_then(Value::as_str),
                ) && !text.is_empty()
                {
                    units.insert(key.to_string(), text.to_string());
                }
            }
            Some("choice") => {
                if let (Some(key), Some(prompt)) = (
                    event_source_unit_key(event),
                    payload.get("prompt").and_then(Value::as_str),
                ) && !prompt.is_empty()
                {
                    units.insert(key.to_string(), prompt.to_string());
                }
                if let Some(options) = payload.get("options").and_then(Value::as_array) {
                    for option in options {
                        if let (Some(key), Some(label)) = (
                            option
                                .get("bridgeRef")
                                .and_then(|bridge| bridge.get("sourceUnitKey"))
                                .and_then(Value::as_str),
                            option.get("label").and_then(Value::as_str),
                        ) && !label.is_empty()
                        {
                            units.insert(key.to_string(), label.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    units
}

/// The canonical `sha256:<hex>` hash over the observed translated units. Keys
/// are BTree-sorted, so the hash is a deterministic function of the patched
/// output content alone. The committed `PatchResult.outputHash` is this exact
/// value over the intended translation, so the observation reproduces it iff it
/// rendered that patch.
pub fn canonical_patched_output_hash(units: &BTreeMap<String, String>) -> String {
    let pairs: Vec<[&str; 2]> = units
        .iter()
        .map(|(key, value)| [key.as_str(), value.as_str()])
        .collect();
    // BTreeMap iteration is already sorted; serialize as a canonical array of
    // [unitKey, translatedText] pairs.
    let bytes = serde_json::to_vec(&pairs).unwrap_or_default();
    format!("sha256:{}", sha256_hex(&bytes))
}

/// The bridge unit ids the alpha (UTSUSHI-102) proof recorded as observed.
fn alpha_proof_bridge_units(alpha: &Value) -> Vec<String> {
    alpha
        .get("observation")
        .and_then(|observation| observation.get("observedBridgeUnitIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The bridge unit ids the patched trace observed (top-level event links).
fn patched_trace_bridge_units(trace: &Value) -> Vec<String> {
    observation_events(trace)
        .iter()
        .filter_map(|event| {
            event
                .get("bridgeRefs")
                .and_then(Value::as_array)
                .and_then(|refs| refs.first())
                .and_then(|bridge| bridge.get("bridgeUnitId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

/// Build the MV/MZ **patched-output** runtime-observation proof manifest.
///
/// Re-derives the full UTSUSHI-102 E1 verdict over the patched trace (a static
/// read cannot forge it), then layers the patch attestation: the observation
/// reproduces the `PatchResult`-attested output by hash, differs from the
/// pre-patch source, and continues the alpha proof's bridge units. The verdict
/// is `patchedRuntimeObservationProven: true` iff every check passes.
pub fn build_mvmz_patched_runtime_proof(
    inputs: &PatchedRuntimeProofInputs,
) -> UtsushiResult<Value> {
    let trace = inputs.patched_runtime_trace;

    // 1. RE-DERIVE the full UTSUSHI-102 E1 strict proof over the patched trace.
    //    This carries the live-DOM / E1 / full-linkage / observed-text-absent-
    //    from-every-static-input crux. We do NOT trust any self-declared
    //    verdict; we recompute it from the patched trace + combined static bytes.
    let base_proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: trace,
        static_fixture_source: inputs.combined_static_source,
        screenshot_evidence: inputs.screenshot_evidence,
    })?;
    let base_proven = base_proof
        .get("runtimeObservationProven")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut checks: Vec<Check> = Vec::new();
    let mut limitations: Vec<String> = Vec::new();

    checks.push(Check {
        id: CHECK_BASE_RUNTIME_OBSERVATION_PROVEN_E1,
        passed: base_proven,
        detail: format!(
            "the patched trace re-derives the full UTSUSHI-102 E1 proof (live-DOM, E1 tier, full \
             linkage, observed translation absent from every consumed static input): proven={base_proven}"
        ),
    });

    // 2. The consumed Kaifuu PatchResult reports a passed patch-back.
    let patch_status = inputs
        .patch_result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("<absent>");
    checks.push(Check {
        id: CHECK_PATCH_RESULT_STATUS_PASSED,
        passed: patch_status.eq_ignore_ascii_case("passed"),
        detail: format!("Kaifuu PatchResult status = {patch_status}; expected passed"),
    });

    // 3. PROVENANCE CRUX: the observed translated units hash to the attested
    //    PatchResult.outputHash.
    let observed_units = observed_translated_units(trace);
    let recomputed_hash = canonical_patched_output_hash(&observed_units);
    let patch_output_hash = inputs
        .patch_result
        .get("outputHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    let hash_matches = !observed_units.is_empty() && recomputed_hash == patch_output_hash;
    checks.push(Check {
        id: CHECK_PATCHED_OUTPUT_MATCHES_PATCH_RESULT_HASH,
        passed: hash_matches,
        detail: if observed_units.is_empty() {
            "no observed translated units to attest; a patched proof with nothing observed cannot \
             link to a PatchResult"
                .to_string()
        } else if hash_matches {
            format!(
                "canonical hash of the {} observed translated unit(s) equals the PatchResult \
                 outputHash ({recomputed_hash}); the observation reproduces exactly the attested \
                 patched output",
                observed_units.len()
            )
        } else {
            format!(
                "observed patched-output hash {recomputed_hash} does not equal the PatchResult \
                 outputHash {patch_output_hash}; the observation is not the attested patch"
            )
        },
    });

    // 4. POST-PATCH CRUX: every observed string differs from the pre-patch
    //    sourceText of its unit.
    let mut colliding: Vec<String> = Vec::new();
    let mut compared = 0usize;
    for (key, observed) in &observed_units {
        if let Some(source_text) = inputs.prepatch_source_texts.get(key) {
            compared += 1;
            if observed == source_text {
                colliding.push(key.clone());
            }
        }
    }
    let translation_distinct =
        !observed_units.is_empty() && compared == observed_units.len() && colliding.is_empty();
    checks.push(Check {
        id: CHECK_OBSERVED_IS_TRANSLATION_NOT_PREPATCH_SOURCE,
        passed: translation_distinct,
        detail: if observed_units.is_empty() {
            "no observed text to compare against the pre-patch source".to_string()
        } else if compared != observed_units.len() {
            format!(
                "{} of {} observed unit(s) had no matching pre-patch sourceText to compare; every \
                 observed unit must map to a known pre-patch original",
                observed_units.len() - compared,
                observed_units.len()
            )
        } else if colliding.is_empty() {
            format!(
                "all {} observed string(s) differ from their pre-patch sourceText; the observation \
                 is the PATCHED translation, not the original",
                observed_units.len()
            )
        } else {
            format!(
                "{} observed string(s) still equal the pre-patch sourceText ({colliding:?}); the \
                 observation is not provably post-patch",
                colliding.len()
            )
        },
    });

    // 5. The consumed alpha proof is a proven E1 UTSUSHI-102 proof.
    let alpha_kind = inputs
        .alpha_proof_manifest
        .get("proofKind")
        .and_then(Value::as_str)
        .unwrap_or("");
    let alpha_proven = inputs
        .alpha_proof_manifest
        .get("runtimeObservationProven")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let alpha_tier = inputs
        .alpha_proof_manifest
        .get("provenEvidenceTier")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let alpha_baseline_ok = alpha_kind == RUNTIME_OBSERVATION_PROOF_KIND
        && alpha_proven
        && alpha_tier == EVIDENCE_TIER_E1;
    checks.push(Check {
        id: CHECK_ALPHA_PROOF_BASELINE_E1,
        passed: alpha_baseline_ok,
        detail: format!(
            "alpha proof manifest proofKind={alpha_kind} runtimeObservationProven={alpha_proven} \
             provenEvidenceTier={alpha_tier}; expected the UTSUSHI-102 proof proven at E1"
        ),
    });

    // 6. The patched observation covers the same bridge units the alpha proof
    //    proved reachable.
    let alpha_units = alpha_proof_bridge_units(inputs.alpha_proof_manifest);
    let patched_units = patched_trace_bridge_units(trace);
    let continuity_ok =
        !alpha_units.is_empty() && alpha_units.iter().all(|unit| patched_units.contains(unit));
    checks.push(Check {
        id: CHECK_PATCHED_UNITS_MATCH_ALPHA_PROOF_UNITS,
        passed: continuity_ok,
        detail: format!(
            "alpha proof proved bridge units {alpha_units:?}; patched observation covers \
             {patched_units:?}; every alpha unit must be covered post-patch"
        ),
    });

    let proven = checks.iter().all(|check| check.passed);

    let proof_id = deterministic_uuid7(
        PATCHED_RUNTIME_PROOF_UUID_NAMESPACE,
        &format!(
            "proof-{}-{}",
            inputs
                .patch_result
                .get("patchResultId")
                .and_then(Value::as_str)
                .unwrap_or(""),
            trace
                .get("runtimeReportId")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
    );

    limitations.push(
        "Patched-runtime-observation proof re-derives the UTSUSHI-102 E1-vs-static distinction over \
         the patched trace and does not embed raw game bytes or pixels; it names the PatchResult and \
         alpha proof by id/hash only."
            .to_string(),
    );
    limitations.push(
        "The absent-from-static crux guarantees the observed translation was not LIFTED from any \
         consumed static input (patched fixture bytes, PatchResult, alpha proof); an operator who \
         hand-authors the correct translation into a fabricated trace is out of scope, exactly as in \
         UTSUSHI-102. The outputHash provenance link ties the observation to a specific attested patch."
            .to_string(),
    );

    Ok(json!({
        "schemaVersion": PATCHED_RUNTIME_PROOF_SCHEMA_VERSION,
        "proofKind": PATCHED_RUNTIME_PROOF_KIND,
        "proofId": proof_id,
        "engine": "rpg_maker_mv_mz",
        "patchedRuntimeObservationProven": proven,
        "provenEvidenceTier": if proven { EVIDENCE_TIER_E1 } else { "none" },
        "consumes": {
            "patchedRuntimeTraceSource": "UTSUSHI-006",
            "runtimeReportId": trace.get("runtimeReportId").cloned().unwrap_or(Value::Null),
            "patchResult": {
                "patchResultId": inputs.patch_result.get("patchResultId").cloned().unwrap_or(Value::Null),
                "patchExportId": inputs.patch_result.get("patchExportId").cloned().unwrap_or(Value::Null),
                "status": inputs.patch_result.get("status").cloned().unwrap_or(Value::Null),
                "outputHash": inputs.patch_result.get("outputHash").cloned().unwrap_or(Value::Null),
            },
            "alphaProofManifest": {
                "proofKind": inputs.alpha_proof_manifest.get("proofKind").cloned().unwrap_or(Value::Null),
                "proofId": inputs.alpha_proof_manifest.get("proofId").cloned().unwrap_or(Value::Null),
                "provenEvidenceTier": inputs.alpha_proof_manifest.get("provenEvidenceTier").cloned().unwrap_or(Value::Null),
            },
        },
        "patchAttestation": {
            "recomputedOutputHash": recomputed_hash,
            "patchResultOutputHash": patch_output_hash,
            "hashMatches": hash_matches,
            "translatedUnitKeys": observed_units.keys().cloned().collect::<Vec<_>>(),
        },
        "baseRuntimeObservationProof": {
            "proofKind": base_proof.get("proofKind").cloned().unwrap_or(Value::Null),
            "proofId": base_proof.get("proofId").cloned().unwrap_or(Value::Null),
            "runtimeObservationProven": base_proof.get("runtimeObservationProven").cloned().unwrap_or(Value::Null),
            "provenEvidenceTier": base_proof.get("provenEvidenceTier").cloned().unwrap_or(Value::Null),
            "observation": base_proof.get("observation").cloned().unwrap_or(Value::Null),
            "checks": base_proof.get("checks").cloned().unwrap_or(Value::Null),
            "screenshotEvidence": base_proof.get("screenshotEvidence").cloned().unwrap_or(Value::Null),
        },
        "checks": checks.iter().map(Check::to_json).collect::<Vec<_>>(),
        "limitations": limitations,
    }))
}

/// Read the pre-patch `sourceText` per unit key from the patched fixture's
/// `source.json`.
pub fn read_prepatch_source_texts(fixture_dir: &Path) -> UtsushiResult<BTreeMap<String, String>> {
    let source: Value =
        serde_json::from_str(&fs::read_to_string(fixture_dir.join("source.json"))?)?;
    let mut map = BTreeMap::new();
    if let Some(units) = source.get("units").and_then(Value::as_array) {
        for unit in units {
            if let (Some(key), Some(text)) = (
                unit.get("sourceUnitKey").and_then(Value::as_str),
                unit.get("sourceText").and_then(Value::as_str),
            ) {
                map.insert(key.to_string(), text.to_string());
            }
        }
    }
    Ok(map)
}

/// Concatenate every consumed static input's bytes: the patched fixture source
/// files, the PatchResult JSON, and the alpha proof JSON. The E1 crux confirms
/// no observed translation is recoverable from any of them.
fn combined_static_source(
    fixture_dir: &Path,
    patch_result_path: &Path,
    alpha_proof_path: &Path,
) -> UtsushiResult<String> {
    let mut combined = read_static_fixture_source(fixture_dir)?;
    combined.push('\n');
    combined.push_str(&fs::read_to_string(patch_result_path)?);
    combined.push('\n');
    combined.push_str(&fs::read_to_string(alpha_proof_path)?);
    Ok(combined)
}

/// The IO shell the CLI uses: read the patched runtime trace, the Kaifuu
/// PatchResult, the alpha proof manifest, the patched fixture source, and the
/// optional screenshot evidence, then delegate to
/// [`build_mvmz_patched_runtime_proof`].
pub fn mvmz_patched_runtime_proof_from_paths(
    patched_runtime_trace_path: &Path,
    patched_fixture_dir: &Path,
    patch_result_path: &Path,
    alpha_proof_path: &Path,
    screenshot_evidence_path: Option<&Path>,
) -> UtsushiResult<Value> {
    let patched_runtime_trace: Value =
        serde_json::from_str(&fs::read_to_string(patched_runtime_trace_path)?)?;
    let patch_result: Value = serde_json::from_str(&fs::read_to_string(patch_result_path)?)?;
    let alpha_proof_manifest: Value = serde_json::from_str(&fs::read_to_string(alpha_proof_path)?)?;
    let combined =
        combined_static_source(patched_fixture_dir, patch_result_path, alpha_proof_path)?;
    let prepatch_source_texts = read_prepatch_source_texts(patched_fixture_dir)?;
    let screenshot_evidence: Option<Value> = match screenshot_evidence_path {
        Some(path) => Some(serde_json::from_str(&fs::read_to_string(path)?)?),
        None => None,
    };

    build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
        patched_runtime_trace: &patched_runtime_trace,
        patch_result: &patch_result,
        alpha_proof_manifest: &alpha_proof_manifest,
        combined_static_source: &combined,
        prepatch_source_texts: &prepatch_source_texts,
        screenshot_evidence: screenshot_evidence.as_ref(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_patched_observation")
    }

    /// A live-DOM E1 patched trace shaped exactly as `BrowserLaunchAdapter::trace`
    /// emits it over the patched fixture: two translated text events + one
    /// translated choice event, every event carrying the full linkage envelope
    /// and `observationSource = live_dom`. The observed plaintext is the
    /// TRANSLATION, present only in the fixture's runtime base64 payload.
    fn patched_live_dom_trace() -> Value {
        let linkage = |unit_key: &str, bridge: &str| {
            json!({
                "runtimeTargetId": "fixture:mvmz-patched-fixture",
                "adapterId": {"name": "utsushi-browser", "version": "0.0.0"},
                "sourceRevision": {"sourceId": "mvmz-patched-fixture", "revisionId": "fixture-source-v0.1"},
                "environment": {"runtime": "browser", "engine": "browser-smoke-fixture", "platform": "linux"},
                "bridgeRefs": [{"bridgeUnitId": bridge, "sourceUnitKey": unit_key}],
                "observationSource": "live_dom",
                "evidenceTier": "E1",
            })
        };
        let mut text1 = linkage("mvmz.scene1.line1", "019ed000-0000-7000-8000-bridgeun0001");
        text1["eventKind"] = json!("text");
        text1["payload"] = json!({"payloadKind": "text", "text": "The lighthouse keeps watch over the quiet cove.", "speaker": "Mira"});
        let mut text2 = linkage("mvmz.scene1.line2", "019ed000-0000-7000-8000-bridgeun0002");
        text2["eventKind"] = json!("text");
        text2["payload"] = json!({"payloadKind": "text", "text": "Let us signal the passing ship.", "speaker": "Kai"});
        let mut choice = linkage("mvmz.scene1.choice", "019ed000-0000-7000-8000-bridgeun0003");
        choice["eventKind"] = json!("choice");
        choice["payload"] = json!({
            "payloadKind": "choice",
            "prompt": "What will you do?",
            "options": [
                {"optionId": "opt-0", "label": "Raise the lantern high.", "bridgeRef": {"bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0004", "sourceUnitKey": "mvmz.scene1.choice.opt0"}},
                {"optionId": "opt-1", "label": "Wait in the darkness.", "bridgeRef": {"bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0005", "sourceUnitKey": "mvmz.scene1.choice.opt1"}}
            ]
        });
        json!({
            "runtimeReportId": "019ed050-0000-7000-8000-000000001000",
            "adapterName": "utsushi-browser",
            "evidenceTier": "E1",
            "status": "passed",
            "observationHookEvents": [text1, text2, choice],
            "traceEvents": [],
        })
    }

    fn patch_result_for(trace: &Value) -> Value {
        let hash = canonical_patched_output_hash(&observed_translated_units(trace));
        json!({
            "schemaVersion": "0.2.0",
            "patchResultId": "019ed060-0000-7000-8000-000000000001",
            "patchExportId": "019ed060-0000-7000-8000-0000000000a1",
            "status": "passed",
            "outputHash": hash,
            "failures": [],
        })
    }

    /// A minimal proven E1 UTSUSHI-102 alpha proof manifest with the same three
    /// top-level bridge units the patched trace covers.
    fn alpha_proof() -> Value {
        json!({
            "proofKind": RUNTIME_OBSERVATION_PROOF_KIND,
            "proofId": "cac432af-03e2-7aa5-955b-bc1d66a3629a",
            "runtimeObservationProven": true,
            "provenEvidenceTier": "E1",
            "observation": {
                "observedBridgeUnitIds": [
                    "019ed000-0000-7000-8000-bridgeun0001",
                    "019ed000-0000-7000-8000-bridgeun0002",
                    "019ed000-0000-7000-8000-bridgeun0003"
                ]
            }
        })
    }

    fn source_map() -> BTreeMap<String, String> {
        read_prepatch_source_texts(&fixture_dir()).unwrap()
    }

    fn combined() -> String {
        // The observed TRANSLATION must be absent from the concatenated static
        // inputs. The alpha proof + patch result carry no plaintext translation.
        let mut s = read_static_fixture_source(&fixture_dir()).unwrap();
        s.push_str(&serde_json::to_string(&patch_result_for(&patched_live_dom_trace())).unwrap());
        s.push_str(&serde_json::to_string(&alpha_proof()).unwrap());
        s
    }

    fn check_status<'a>(proof: &'a Value, check_id: &str) -> &'a str {
        proof["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["checkId"] == check_id)
            .unwrap_or_else(|| panic!("missing check {check_id}"))["status"]
            .as_str()
            .unwrap()
    }

    #[test]
    fn patched_live_dom_trace_proves_patched_e1_observation() {
        let trace = patched_live_dom_trace();
        let patch_result = patch_result_for(&trace);
        let alpha = alpha_proof();
        let source = source_map();
        let combined = combined();
        let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
            patched_runtime_trace: &trace,
            patch_result: &patch_result,
            alpha_proof_manifest: &alpha,
            combined_static_source: &combined,
            prepatch_source_texts: &source,
            screenshot_evidence: None,
        })
        .unwrap();

        assert_eq!(proof["patchedRuntimeObservationProven"], true, "{proof}");
        assert_eq!(proof["provenEvidenceTier"], "E1");
        assert_eq!(proof["proofKind"], PATCHED_RUNTIME_PROOF_KIND);
        assert_eq!(proof["patchAttestation"]["hashMatches"], true);
        for check_id in [
            CHECK_BASE_RUNTIME_OBSERVATION_PROVEN_E1,
            CHECK_PATCH_RESULT_STATUS_PASSED,
            CHECK_PATCHED_OUTPUT_MATCHES_PATCH_RESULT_HASH,
            CHECK_OBSERVED_IS_TRANSLATION_NOT_PREPATCH_SOURCE,
            CHECK_ALPHA_PROOF_BASELINE_E1,
            CHECK_PATCHED_UNITS_MATCH_ALPHA_PROOF_UNITS,
        ] {
            assert_eq!(check_status(&proof, check_id), "pass", "check {check_id}");
        }
        // The observed translation is what was attested — line1 is the English
        // translation, not the Japanese source.
        assert_eq!(
            proof["patchAttestation"]["translatedUnitKeys"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
    }

    #[test]
    fn wrong_patch_result_hash_is_rejected() {
        // The observation is a genuine live-DOM render, but the PatchResult
        // attests a DIFFERENT output. The provenance crux rejects it: the
        // observed content is not the attested patch.
        let trace = patched_live_dom_trace();
        let mut patch_result = patch_result_for(&trace);
        patch_result["outputHash"] = json!("sha256:deadbeef");
        let alpha = alpha_proof();
        let source = source_map();
        let combined = combined();
        let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
            patched_runtime_trace: &trace,
            patch_result: &patch_result,
            alpha_proof_manifest: &alpha,
            combined_static_source: &combined,
            prepatch_source_texts: &source,
            screenshot_evidence: None,
        })
        .unwrap();
        assert_eq!(proof["patchedRuntimeObservationProven"], false);
        assert_eq!(proof["provenEvidenceTier"], "none");
        assert_eq!(
            check_status(&proof, CHECK_PATCHED_OUTPUT_MATCHES_PATCH_RESULT_HASH),
            "fail"
        );
    }

    #[test]
    fn observing_prepatch_source_is_not_a_patched_observation() {
        // STRICT-PROOF NEGATIVE CONTROL: a trace that "observes" the pre-patch
        // Japanese source text (the untranslated original) is not a patched
        // observation. It fails the post-patch crux AND the base
        // absent-from-static crux (the source text lives in source.json).
        let mut trace = patched_live_dom_trace();
        trace["observationHookEvents"][0]["payload"]["text"] =
            json!("灯台は静かな入り江を見守り続ける。");
        // Re-point the PatchResult hash so ONLY the post-patch / static checks
        // are what reject it (isolate the crux under test).
        let patch_result = patch_result_for(&trace);
        let alpha = alpha_proof();
        let source = source_map();
        let combined = combined();
        let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
            patched_runtime_trace: &trace,
            patch_result: &patch_result,
            alpha_proof_manifest: &alpha,
            combined_static_source: &combined,
            prepatch_source_texts: &source,
            screenshot_evidence: None,
        })
        .unwrap();
        assert_eq!(proof["patchedRuntimeObservationProven"], false);
        assert_eq!(
            check_status(&proof, CHECK_OBSERVED_IS_TRANSLATION_NOT_PREPATCH_SOURCE),
            "fail"
        );
        // And the base E1 crux also rejects it: the source text is recoverable
        // from source.json (a static read).
        assert_eq!(
            check_status(&proof, CHECK_BASE_RUNTIME_OBSERVATION_PROVEN_E1),
            "fail"
        );
    }

    #[test]
    fn static_read_of_placeholder_target_cannot_forge_patched_e1() {
        // An attacker lifts the declared PLACEHOLDER targetText out of
        // source.json and relabels it as a live_dom E1 observation. It is
        // present in the static source, so the base absent-from-static crux
        // rejects the forged patched E1.
        let mut trace = patched_live_dom_trace();
        trace["observationHookEvents"][0]["payload"]["text"] = json!(
            "PLACEHOLDER line1 -- the PATCHED translation is observed from the live DOM, not this field."
        );
        let patch_result = patch_result_for(&trace);
        let alpha = alpha_proof();
        let source = source_map();
        let combined = combined();
        let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
            patched_runtime_trace: &trace,
            patch_result: &patch_result,
            alpha_proof_manifest: &alpha,
            combined_static_source: &combined,
            prepatch_source_texts: &source,
            screenshot_evidence: None,
        })
        .unwrap();
        assert_eq!(proof["patchedRuntimeObservationProven"], false);
        assert_eq!(
            check_status(&proof, CHECK_BASE_RUNTIME_OBSERVATION_PROVEN_E1),
            "fail"
        );
    }

    #[test]
    fn unproven_alpha_proof_is_rejected() {
        let trace = patched_live_dom_trace();
        let patch_result = patch_result_for(&trace);
        let mut alpha = alpha_proof();
        alpha["runtimeObservationProven"] = json!(false);
        alpha["provenEvidenceTier"] = json!("none");
        let source = source_map();
        let combined = combined();
        let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
            patched_runtime_trace: &trace,
            patch_result: &patch_result,
            alpha_proof_manifest: &alpha,
            combined_static_source: &combined,
            prepatch_source_texts: &source,
            screenshot_evidence: None,
        })
        .unwrap();
        assert_eq!(proof["patchedRuntimeObservationProven"], false);
        assert_eq!(check_status(&proof, CHECK_ALPHA_PROOF_BASELINE_E1), "fail");
    }

    #[test]
    fn read_static_fixture_source_excludes_the_patched_translation() {
        // Sanity: the patched fixture's static bytes carry NONE of the observed
        // translation (only its base64 encoding + the PLACEHOLDER target).
        let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
        for observed in [
            "The lighthouse keeps watch over the quiet cove.",
            "Let us signal the passing ship.",
            "What will you do?",
            "Raise the lantern high.",
            "Wait in the darkness.",
        ] {
            assert!(
                !static_source.contains(observed),
                "static patched fixture source leaked the translation: {observed}"
            );
        }
    }
}
