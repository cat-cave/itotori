//! RGSS3 synthetic-fixture round-trip driver and negative-case evaluation.

use crate::{
    KaifuuResult, OperationStatus, PartialDiagnosticSeverity, SemanticErrorCode,
    rgss3_profile::{
        MarshalValue, Rgss3LayeredTransformProfile, Rgss3PatchBackDependency,
        Rgss3XorKeystreamScheme, build_synthetic_rgss3a, decode_synthetic_rgss3a, read_marshal,
        write_marshal,
    },
};

use super::{
    MarshalPath, MarshalStep, RGSS3_SMOKE_SCHEMA_VERSION, RGSS3_SMOKE_SOURCE_NODE_ID,
    RGSS3_SMOKE_SUPPORT_BOUNDARY, Rgss3ExtractError, Rgss3IdentityReport, Rgss3LayerVerification,
    Rgss3PatchError, Rgss3PatchReport, Rgss3SmokeReport, Rgss3TextUnitReport, Rgss3UnsupportedKind,
    Rgss3UnsupportedReport, SCRIPTS_MEMBER_NAME, extract_rgss3, marshal_structural_diff,
    proof_hash, rebuild_rgss3,
};

// Synthetic fixture (public, in-module — no retail bytes)

/// The seed of the canonical synthetic fixture archive.
const FIXTURE_SEED: u32 = 0x1234_5678;

/// The synthetic fixture's text-bearing `.rvdata2` object graph: a VX Ace
/// `System`/`CommonEvent`-style record with a title, a nested message list, and
/// a speaker — all from KNOWN synthetic values, no retail bytes.
pub(super) fn synthetic_text_bearing_value() -> MarshalValue {
    MarshalValue::Array(vec![
        MarshalValue::Int(1),
        MarshalValue::ByteString(b"Prologue".to_vec()),
        MarshalValue::Hash(vec![
            (
                MarshalValue::Symbol("messages".to_string()),
                MarshalValue::Array(vec![
                    MarshalValue::ByteString("Hello, traveler.".as_bytes().to_vec()),
                    MarshalValue::ByteString("Welcome to the village.".as_bytes().to_vec()),
                    MarshalValue::ByteString("Safe travels.".as_bytes().to_vec()),
                ]),
            ),
            (
                MarshalValue::Symbol("speaker".to_string()),
                MarshalValue::ByteString("Guide".as_bytes().to_vec()),
            ),
            (
                MarshalValue::Symbol("visited".to_string()),
                MarshalValue::Bool(false),
            ),
        ]),
    ])
}

/// Build the canonical synthetic RGSSAD v3 fixture archive: a text-bearing
/// `System.rvdata2` Marshal payload plus an opaque `Map001.rvdata2` binary entry.
pub(super) fn build_fixture_archive(scheme: Rgss3XorKeystreamScheme) -> Vec<u8> {
    let system_payload = write_marshal(&synthetic_text_bearing_value());
    // A non-`.rvdata2` asset (a synthetic PNG-shaped blob) carried byte-exact —
    // proves the opaque path leaves non-text entries untouched.
    let asset_payload: &[u8] = b"\x89PNG\r\n\x1a\n synthetic title art \x00\x01\x02\x03\xff";
    let entries: Vec<(&str, &[u8])> = vec![
        ("Data/System.rvdata2", system_payload.as_slice()),
        ("Graphics/Titles/Title.png", asset_payload),
    ];
    build_synthetic_rgss3a(scheme, FIXTURE_SEED, &entries)
}

// The smoke driver

/// Run the bounded RGSS3 extract→patch→rebuild→verify smoke on the in-module
/// public synthetic fixture.
/// Returns `Err` only on an environmental failure (e.g. a hashing failure the
/// report cannot represent). Extraction / patch / verification / unsupported
/// outcomes are folded into the report's `status` and typed diagnostics.
pub fn generate_rgss3_smoke() -> KaifuuResult<Rgss3SmokeReport> {
    let profile = Rgss3LayeredTransformProfile::canonical();
    let scheme = profile.crypto_scheme;
    let mut findings = Vec::new();

    let source = build_fixture_archive(scheme);
    let source_hash = proof_hash(&source)?;
    let extraction = extract_rgss3(scheme, &source)
        .map_err(|error| format!("synthetic fixture must extract cleanly: {error}"))?;
    let entry_ids: Vec<String> = extraction.entries.iter().map(|e| e.name.clone()).collect();

    let text_units_raw = extraction.text_units();
    let text_units: Vec<Rgss3TextUnitReport> = text_units_raw
        .iter()
        .map(|(entry_index, path, text)| Rgss3TextUnitReport {
            entry_id: extraction.entries[*entry_index].name.clone(),
            locator: path.locator(),
            text: text.clone(),
        })
        .collect();
    if text_units.is_empty() {
        findings.push(finding(
            "rgss3.smoke.no_text_extracted",
            PartialDiagnosticSeverity::P0,
            "textUnits",
            SemanticErrorCode::MissingCodecCapability,
            "no text-bearing data extracted from the synthetic fixture".to_string(),
        ));
    }

    let identity_rebuilt = rebuild_rgss3(&extraction);
    let identity_byte_identical = identity_rebuilt == source;
    if !identity_byte_identical {
        findings.push(finding(
            "rgss3.smoke.identity_not_byte_preserving",
            PartialDiagnosticSeverity::P0,
            "identity",
            SemanticErrorCode::MissingPatchBackCapability,
            "rebuild(extract(x)) with no change was not byte-identical to the source".to_string(),
        ));
    }
    let identity = Rgss3IdentityReport {
        byte_identical: identity_byte_identical,
        source_hash: source_hash.clone(),
        rebuilt_hash: proof_hash(&identity_rebuilt)?,
        source_bytes: source.len() as u64,
        rebuilt_bytes: identity_rebuilt.len() as u64,
    };

    // Target the first text-bearing string of the System entry (its title).
    let (target_entry, target_path, old_text) = text_units_raw
        .iter()
        .find(|(entry_index, _, _)| extraction.entries[*entry_index].name == "Data/System.rvdata2")
        .cloned()
        .ok_or("synthetic fixture must contain a System.rvdata2 text unit")?;
    // A length-changing localization (proves bounds + offsets are recomputed).
    let new_text = "Josho: Tabidachi no Hi";
    let length_delta = new_text.len() as i64 - old_text.len() as i64;

    let mut patched = extraction.clone();
    let applied_old = patched
        .localize(target_entry, &target_path, new_text)
        .map_err(|error| format!("trivial localization must apply: {error}"))?;

    let patched_rebuilt = rebuild_rgss3(&patched);

    // Re-extract both archives and compare layer by layer.
    let source_entries = decode_synthetic_rgss3a(scheme, &source)
        .map_err(|error| format!("re-decode source: {error}"))?;
    let patched_entries = decode_synthetic_rgss3a(scheme, &patched_rebuilt)
        .map_err(|error| format!("re-decode patched: {error}"))?;

    // Container layer: entry names + count preserved.
    let entry_names_preserved = source_entries.len() == patched_entries.len()
        && source_entries
            .iter()
            .zip(patched_entries.iter())
            .all(|(a, b)| a.name == b.name);

    // Crypto layer: the patched archive is genuinely re-obfuscated (its raw bytes
    // do not contain the new plaintext) yet decrypts back to it.
    let keystream_reproduced = !patched_rebuilt
        .windows(new_text.len())
        .any(|w| w == new_text.as_bytes())
        && patched_entries.iter().any(|e| {
            read_marshal(&e.payload)
                .ok()
                .is_some_and(|v| marshal_contains_text(&v, new_text))
        });

    // Patch-back layer: every entry other than the patched one is byte-identical.
    let mut other_entries_byte_identical = true;
    for (index, (src, pat)) in source_entries
        .iter()
        .zip(patched_entries.iter())
        .enumerate()
    {
        if index == target_entry {
            continue;
        }
        if src.payload != pat.payload {
            other_entries_byte_identical = false;
        }
    }

    // Codec layer: the patched entry diverges at exactly one Marshal path.
    let source_tree = read_marshal(&source_entries[target_entry].payload)
        .map_err(|error| format!("decode source patched entry: {error}"))?;
    let patched_tree = read_marshal(&patched_entries[target_entry].payload)
        .map_err(|error| format!("decode patched entry: {error}"))?;
    let diverging = marshal_structural_diff(&source_tree, &patched_tree);
    let diverging_paths: Vec<String> = diverging.iter().map(MarshalPath::locator).collect();
    let single_divergence = diverging.len() == 1 && diverging[0] == target_path;

    // The rebuilt archive carries the new text, not the old text.
    let change_applied = marshal_contains_text(&patched_tree, new_text)
        && !marshal_contains_text(&patched_tree, &applied_old);

    if !change_applied {
        findings.push(finding(
            "rgss3.smoke.change_not_applied",
            PartialDiagnosticSeverity::P0,
            "patch",
            SemanticErrorCode::MissingCodecCapability,
            "the localized string was not present in the rebuilt archive".to_string(),
        ));
    }
    if !single_divergence {
        findings.push(finding(
            "rgss3.smoke.unexpected_divergence",
            PartialDiagnosticSeverity::P0,
            "patch",
            SemanticErrorCode::MissingCodecCapability,
            format!(
                "patched entry diverged at {} paths, expected exactly the localized one",
                diverging.len()
            ),
        ));
    }
    if !other_entries_byte_identical {
        findings.push(finding(
            "rgss3.smoke.collateral_change",
            PartialDiagnosticSeverity::P0,
            "patch",
            SemanticErrorCode::MissingPatchBackCapability,
            "a non-patched entry changed during the patched rebuild".to_string(),
        ));
    }
    if !entry_names_preserved {
        findings.push(finding(
            "rgss3.smoke.entry_names_changed",
            PartialDiagnosticSeverity::P0,
            "layers.container",
            SemanticErrorCode::MissingContainerCapability,
            "the archive entry set changed across the rebuild".to_string(),
        ));
    }
    if !keystream_reproduced {
        findings.push(finding(
            "rgss3.smoke.keystream_not_reproduced",
            PartialDiagnosticSeverity::P0,
            "layers.crypto",
            SemanticErrorCode::MissingCryptoCapability,
            "the rebuilt archive did not reproduce the XOR keystream".to_string(),
        ));
    }

    let patch = Rgss3PatchReport {
        entry_id: extraction.entries[target_entry].name.clone(),
        locator: target_path.locator(),
        old_text: applied_old,
        new_text: new_text.to_string(),
        change_applied,
        length_delta,
        diverging_paths,
        other_entries_byte_identical,
    };

    // The patch-back dependencies this bounded round-trip actually exercised.
    let dependencies_exercised = vec![
        Rgss3PatchBackDependency::MarshalStructurePreserved
            .as_str()
            .to_string(),
        Rgss3PatchBackDependency::StringTableRewriteBoundsUpdated
            .as_str()
            .to_string(),
        Rgss3PatchBackDependency::XorKeystreamReproduced
            .as_str()
            .to_string(),
        Rgss3PatchBackDependency::ArchiveOffsetsRecomputed
            .as_str()
            .to_string(),
    ];

    let layers = Rgss3LayerVerification {
        container_transform: format!("{:?}", profile.container).to_lowercase(),
        entry_names_preserved,
        entry_count: source_entries.len() as u64,
        crypto_transform: format!("{:?}", profile.crypto).to_lowercase(),
        keystream_reproduced,
        codec_transform: "ruby_marshal".to_string(),
        patch_back_transform: "repack_archive".to_string(),
        dependencies_exercised,
    };

    let unsupported = evaluate_unsupported_cases(scheme);
    for case in &unsupported {
        if !case.rejected_before_rebuild {
            findings.push(finding(
                "rgss3.smoke.unsupported_not_rejected",
                PartialDiagnosticSeverity::P0,
                "unsupported",
                SemanticErrorCode::UnsupportedLayeredTransform,
                format!(
                    "unsupported case {} was not rejected with a typed diagnostic",
                    case.case_id
                ),
            ));
        }
    }

    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    Ok(Rgss3SmokeReport {
        schema_version: RGSS3_SMOKE_SCHEMA_VERSION.to_string(),
        fixture_id: "fixture/rgss3/vx-ace/localization-smoke".to_string(),
        source_node_id: RGSS3_SMOKE_SOURCE_NODE_ID.to_string(),
        engine_family: profile.engine_family.clone(),
        support_boundary: RGSS3_SMOKE_SUPPORT_BOUNDARY.to_string(),
        status,
        entry_ids,
        text_units,
        identity,
        patch,
        layers,
        unsupported,
        findings,
    })
}

/// Whether any `String` leaf in a Marshal tree equals `needle`.
fn marshal_contains_text(value: &MarshalValue, needle: &str) -> bool {
    match value {
        MarshalValue::ByteString(bytes) => bytes.as_slice() == needle.as_bytes(),
        MarshalValue::Array(items) => items.iter().any(|v| marshal_contains_text(v, needle)),
        MarshalValue::Hash(pairs) => pairs.iter().any(|(_, v)| marshal_contains_text(v, needle)),
        MarshalValue::Nil
        | MarshalValue::Bool(_)
        | MarshalValue::Int(_)
        | MarshalValue::Symbol(_) => false,
    }
}

/// Build + evaluate the negative cases, each producing a typed unsupported
/// diagnostic. Every case must be rejected before any rebuild byte for the
/// offending entry.
fn evaluate_unsupported_cases(scheme: Rgss3XorKeystreamScheme) -> Vec<Rgss3UnsupportedReport> {
    let mut cases = Vec::new();

    // 1. Bad container: not an RGSSAD archive at all.
    let bad = b"NOTRGSS\x03 garbage bytes that are not a real archive";
    let report = match extract_rgss3(scheme, bad) {
        Err(error @ Rgss3ExtractError::Container(_)) => Rgss3UnsupportedReport {
            case_id: "bad-container".to_string(),
            kind: Rgss3UnsupportedKind::BadContainer,
            rejected_before_rebuild: true,
            semantic_code: error.semantic_code().as_str().to_string(),
            message: error.to_string(),
        },
        other => did_not_reject("bad-container", Rgss3UnsupportedKind::BadContainer, other),
    };
    cases.push(report);

    // 2. Unsupported Marshal type: a `.rvdata2` payload using a type tag outside
    // the bounded subset (`c` = class), which the codec rejects (no silent
    // drop of the entry's text).
    let bad_marshal = vec![0x04u8, 0x08, b'c'];
    let archive = build_synthetic_rgss3a(scheme, 7, &[("Data/System.rvdata2", &bad_marshal)]);
    let report = match extract_rgss3(scheme, &archive) {
        Err(error @ Rgss3ExtractError::Codec { .. }) => Rgss3UnsupportedReport {
            case_id: "unsupported-marshal-type".to_string(),
            kind: Rgss3UnsupportedKind::UnsupportedMarshalType,
            rejected_before_rebuild: true,
            semantic_code: error.semantic_code().as_str().to_string(),
            message: error.to_string(),
        },
        other => did_not_reject(
            "unsupported-marshal-type",
            Rgss3UnsupportedKind::UnsupportedMarshalType,
            other,
        ),
    };
    cases.push(report);

    // 3. Scripts.rvdata2 (zlib-deflated Ruby code) is out of scope.
    let scripts = build_synthetic_rgss3a(scheme, 9, &[(SCRIPTS_MEMBER_NAME, b"\x04\x08[\x00")]);
    let report = match extract_rgss3(scheme, &scripts) {
        Err(error @ Rgss3ExtractError::ScriptsOutOfScope { .. }) => Rgss3UnsupportedReport {
            case_id: "scripts-out-of-scope".to_string(),
            kind: Rgss3UnsupportedKind::ScriptsOutOfScope,
            rejected_before_rebuild: true,
            semantic_code: error.semantic_code().as_str().to_string(),
            message: error.to_string(),
        },
        other => did_not_reject(
            "scripts-out-of-scope",
            Rgss3UnsupportedKind::ScriptsOutOfScope,
            other,
        ),
    };
    cases.push(report);

    // 4. Patch target is not a text leaf: localizing an Int node is a typed error.
    let good = build_fixture_archive(scheme);
    let report = match extract_rgss3(scheme, &good) {
        Ok(mut extraction) => {
            // Path [0] of System.rvdata2 is the Int(1) header — not a String.
            let int_path = MarshalPath(vec![MarshalStep::Index(0)]);
            match extraction.localize(0, &int_path, "not text") {
                Err(error @ Rgss3PatchError::NotATextLeaf { .. }) => Rgss3UnsupportedReport {
                    case_id: "patch-target-not-text".to_string(),
                    kind: Rgss3UnsupportedKind::PatchTargetNotText,
                    rejected_before_rebuild: true,
                    semantic_code: SemanticErrorCode::MissingCodecCapability
                        .as_str()
                        .to_string(),
                    message: error.to_string(),
                },
                other => Rgss3UnsupportedReport {
                    case_id: "patch-target-not-text".to_string(),
                    kind: Rgss3UnsupportedKind::PatchTargetNotText,
                    rejected_before_rebuild: false,
                    semantic_code: SemanticErrorCode::MissingCodecCapability
                        .as_str()
                        .to_string(),
                    message: format!("expected a NotATextLeaf error, got {other:?}"),
                },
            }
        }
        Err(error) => Rgss3UnsupportedReport {
            case_id: "patch-target-not-text".to_string(),
            kind: Rgss3UnsupportedKind::PatchTargetNotText,
            rejected_before_rebuild: false,
            semantic_code: error.semantic_code().as_str().to_string(),
            message: format!("fixture extraction failed: {error}"),
        },
    };
    cases.push(report);

    cases
}

fn did_not_reject(
    case_id: &str,
    kind: Rgss3UnsupportedKind,
    got: Result<super::Rgss3Extraction, Rgss3ExtractError>,
) -> Rgss3UnsupportedReport {
    let detail = match got {
        Ok(_) => "extraction unexpectedly succeeded".to_string(),
        Err(error) => format!("wrong error class: {error}"),
    };
    Rgss3UnsupportedReport {
        case_id: case_id.to_string(),
        kind,
        rejected_before_rebuild: false,
        semantic_code: SemanticErrorCode::UnsupportedLayeredTransform
            .as_str()
            .to_string(),
        message: detail,
    }
}

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    semantic_code: SemanticErrorCode,
    message: String,
) -> super::Rgss3SmokeFinding {
    super::Rgss3SmokeFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        semantic_code: semantic_code.as_str().to_string(),
        message,
    }
}
