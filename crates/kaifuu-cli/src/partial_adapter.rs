use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_core::{
    AdapterRegistry, DetectionResult, EngineAdapter, EvidenceStatus, KaifuuResult,
    PartialAdapterCommand, PartialAdapterDiagnostic, PartialAdapterInventory, PartialAdapterReport,
    PartialDiagnosticSeverity, atomic_write_text, redact_for_log_or_report, sha256_hash_bytes,
    stable_json,
};

fn detect_registered_adapter(
    registry: &AdapterRegistry,
    game_dir: &Path,
) -> KaifuuResult<DetectionResult> {
    registry.detect(game_dir)?.ok_or_else(|| {
        format!(
            "no registered adapter detected {}",
            redact_for_log_or_report(&game_dir.display().to_string())
        )
        .into()
    })
}

pub(crate) fn registered_adapter_for_game<'a>(
    registry: &'a AdapterRegistry,
    game_dir: &Path,
) -> KaifuuResult<&'a dyn EngineAdapter> {
    let detection = detect_registered_adapter(registry, game_dir)?;
    registry.get(&detection.adapter_id).ok_or_else(|| {
        format!(
            "detected adapter {} is not registered",
            detection.adapter_id
        )
        .into()
    })
}

/// Outcome of the detect-vs-diagnostic-vs-partial gate. A diagnostic route is
/// deliberately distinct from a full detection: it invokes an adapter only so
/// it can return a structured `AdapterFailure`, never as a support claim.
pub(crate) enum DetectOutcome<'a> {
    FullDetect(&'a dyn EngineAdapter),
    Diagnostic(&'a dyn EngineAdapter),
    Partial(DetectionResult),
}

/// Implements the partial gate, with optional
/// diagnostic routing for commands that can faithfully expose AdapterFailure.
/// Order of precedence:
/// 1. Any adapter that returns `detected == true` (highest-priority
///    Matched evidence wins by registry ordering, like `AdapterRegistry::detect`).
/// 2. Otherwise, an explicit registry diagnostic candidate is routed to its
///    adapter so its semantic `AdapterFailure` reaches the caller. This is not
///    a detection or a support claim.
/// 3. Otherwise, the DetectionResult with the most `EvidenceStatus::Matched`
///    rows (provided that count is non-zero) drives the partial path.
/// 4. Otherwise — no Matched evidence anywhere — the historical
///    `"no registered adapter detected"` error is returned. Partial output
///    is never a substitute for "no adapter recognized anything"; without
///    Matched evidence we have nothing to surface.
pub(crate) fn detect_or_partial<'a>(
    registry: &'a AdapterRegistry,
    game_dir: &Path,
    include_diagnostic_candidates: bool,
) -> KaifuuResult<DetectOutcome<'a>> {
    let detections = registry.detect_all(game_dir)?;
    if let Some(detection) = detections.iter().find(|detection| detection.detected) {
        let adapter =
            registry
                .get(&detection.adapter_id)
                .ok_or_else(|| -> Box<dyn std::error::Error> {
                    format!(
                        "detected adapter {} is not registered",
                        detection.adapter_id
                    )
                    .into()
                })?;
        return Ok(DetectOutcome::FullDetect(adapter));
    }
    if include_diagnostic_candidates
        && let Some(detection) = registry.diagnostic_candidate_from_results(&detections)
    {
        let adapter =
            registry
                .get(&detection.adapter_id)
                .ok_or_else(|| -> Box<dyn std::error::Error> {
                    format!(
                        "diagnostic adapter {} is not registered",
                        detection.adapter_id
                    )
                    .into()
                })?;
        return Ok(DetectOutcome::Diagnostic(adapter));
    }
    let best_partial = detections
        .into_iter()
        .filter(|detection| matched_evidence_count(detection) > 0)
        .max_by_key(matched_evidence_count);
    match best_partial {
        Some(detection) => Ok(DetectOutcome::Partial(detection)),
        None => Err(format!(
            "no registered adapter detected {}",
            redact_for_log_or_report(&game_dir.display().to_string())
        )
        .into()),
    }
}

fn matched_evidence_count(detection: &DetectionResult) -> usize {
    detection
        .evidence
        .iter()
        .filter(|evidence| evidence.status == EvidenceStatus::Matched)
        .count()
}

/// Build the PartialAdapterReport for a detection that did not
/// reach `detected == true`. Routes by adapter id to a partial extractor
/// that knows how to read the surviving bytes (RealLive: parse the
/// SEEN.TXT envelope and count scene-index entries). Adapter families that
/// do not yet have a partial extractor get a generic report carrying the
/// evidence and a single P2 diagnostic explaining that no engine-specific
/// partial path is implemented.
pub(crate) fn build_partial_adapter_report(
    detection: &DetectionResult,
    game_dir: &Path,
    command: PartialAdapterCommand,
) -> PartialAdapterReport {
    match detection.adapter_id.as_str() {
        kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID => {
            build_reallive_partial_report(detection, game_dir, command)
        }
        _ => build_generic_partial_report(detection, command),
    }
}

fn build_generic_partial_report(
    detection: &DetectionResult,
    command: PartialAdapterCommand,
) -> PartialAdapterReport {
    let diagnostics = vec![PartialAdapterDiagnostic {
        code: "kaifuu.partial.no_engine_specific_path".to_string(),
        severity: PartialDiagnosticSeverity::P2,
        message: format!(
            "adapter {} reported nonzero evidence but no engine-specific partial extractor is wired",
            detection.adapter_id
        ),
        asset_ref: None,
        remediation: Some(
            "implement a partial extractor for this adapter family before downstream apply/verify can consume the recovered evidence"
                .to_string(),
        ),
    }];
    PartialAdapterReport::new(
        detection.adapter_id.clone(),
        detection.detected_variant.clone(),
        command,
        detection.evidence.clone(),
        diagnostics,
        PartialAdapterInventory::default(),
    )
}

/// RealLive partial path. Parses the SEEN.TXT envelope
/// directly to count populated scene-index entries, classifies the
/// Gameexe.ini key-catalogue mismatch into a P2 diagnostic, and surfaces
/// SEEN.TXT envelope failures as P0. Output `inventory.entries` is the
/// scene-count from `kaifuu_reallive::parse_archive` — non-zero on the
/// canonical case (envelope OK, Gameexe.ini key mismatch).
fn build_reallive_partial_report(
    detection: &DetectionResult,
    game_dir: &Path,
    command: PartialAdapterCommand,
) -> PartialAdapterReport {
    let resolved_data_dir = kaifuu_reallive::detect_reallive_data_dir(game_dir)
        .ok()
        .flatten()
        .map(|evidence| evidence.reallive_data_path);
    let data_root: &Path = resolved_data_dir.as_deref().unwrap_or(game_dir);
    let seen_path = resolve_reallive_seen_path_for_partial(data_root);

    let mut diagnostics: Vec<PartialAdapterDiagnostic> = Vec::new();
    let mut inventory = PartialAdapterInventory::default();
    let mut sources: Vec<String> = Vec::new();

    match fs::read(&seen_path) {
        Ok(bytes) => {
            inventory.source_bundle_hash = Some(sha256_hash_bytes(&bytes));
            let display = relative_to_game_dir(game_dir, &seen_path);
            sources.push(display);
            match kaifuu_reallive::parse_archive(&bytes) {
                Ok(index) => {
                    inventory.entries = index.entries.len() as u64;
                    if index.entries.is_empty() {
                        diagnostics.push(PartialAdapterDiagnostic {
                            code: "kaifuu.reallive.partial.scene_index_empty".to_string(),
                            severity: PartialDiagnosticSeverity::P1,
                            message: "SEEN.TXT envelope parsed but contains zero populated scene slots; partial extraction has no bytes to surface"
                                .to_string(),
                            asset_ref: Some("Seen.txt".to_string()),
                            remediation: Some(
                                "verify the SEEN.TXT bytes were copied intact from the game install"
                                    .to_string(),
                            ),
                        });
                    }
                }
                Err(diag) => {
                    diagnostics.push(PartialAdapterDiagnostic {
                        code: format!("kaifuu.reallive.partial.{}", diag.code.as_str()),
                        severity: PartialDiagnosticSeverity::P0,
                        message: format!("SEEN.TXT envelope parse failed: {}", diag.message),
                        asset_ref: Some("Seen.txt".to_string()),
                        remediation: Some(
                            "audit SEEN.TXT against the 10,000-slot envelope shape".to_string(),
                        ),
                    });
                }
            }
        }
        Err(err) => {
            diagnostics.push(PartialAdapterDiagnostic {
                code: "kaifuu.reallive.partial.seen_txt_missing".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                message: format!("SEEN.TXT could not be read: {err}"),
                asset_ref: Some("Seen.txt".to_string()),
                remediation: Some(
                    "confirm REALLIVEDATA/Seen.txt is present and readable in the source tree"
                        .to_string(),
                ),
            });
        }
    }

    // Gameexe.ini key-catalogue mismatch: emitted whenever the
    // `reallive_gameexe_ini_keys` evidence row is Missing/Invalid. P2 by
    // design — Gameexe.ini coverage is a follow-up, not a
    // contract violation. Apply/verify must still treat the partial
    // bundle as untrusted (downstream gates use `partial: true`), but
    // P2 lets `verify` exit 0 so dashboards ingest the report instead
    // of treating it as a hard failure.
    if let Some(row) = detection
        .evidence
        .iter()
        .find(|evidence| evidence.kind == "reallive_gameexe_ini_keys")
        && row.status != EvidenceStatus::Matched
    {
        diagnostics.push(PartialAdapterDiagnostic {
            code: "kaifuu.reallive.partial.gameexe_key_catalogue_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P2,
            message: format!(
                "Gameexe.ini key catalogue mismatch: {} (RealLive-specific key prefixes absent or unrecognized)",
                row.detail
            ),
            asset_ref: Some("Gameexe.ini".to_string()),
            remediation: Some(
                "extend the Gameexe.ini classifier catalogue or audit the input game"
                    .to_string(),
            ),
        });
        // Record Gameexe.ini in sources when the file actually exists
        // on disk (Matched-or-Invalid both imply existence; Missing
        // means absent and is not a recovered source).
        if row.status == EvidenceStatus::Invalid {
            sources.push(relative_to_game_dir(
                game_dir,
                &data_root.join("Gameexe.ini"),
            ));
        }
    }

    // SEEN.GAN missing is informational at the partial layer.
    if let Some(row) = detection
        .evidence
        .iter()
        .find(|evidence| evidence.kind == "reallive_seen_gan_marker")
        && row.status == EvidenceStatus::Missing
    {
        diagnostics.push(PartialAdapterDiagnostic {
            code: "kaifuu.reallive.partial.seen_gan_missing".to_string(),
            severity: PartialDiagnosticSeverity::P3,
            message: "SEEN.GAN marker absent; not required for partial scene-index extraction"
                .to_string(),
            asset_ref: Some("Seen.gan".to_string()),
            remediation: None,
        });
    }

    inventory.sources = sources;

    PartialAdapterReport::new(
        detection.adapter_id.clone(),
        detection.detected_variant.clone(),
        command,
        detection.evidence.clone(),
        diagnostics,
        inventory,
    )
}

fn resolve_reallive_seen_path_for_partial(data_root: &Path) -> PathBuf {
    // Case-insensitive lookup so the real Sweetie HD bytes
    // (`REALLIVEDATA/Seen.txt`) and the upper-case test fixture
    // (`REALLIVEDATA/SEEN.TXT`) both resolve.
    for candidate in ["Seen.txt", "SEEN.TXT", "seen.txt"] {
        let path = data_root.join(candidate);
        if path.is_file() {
            return path;
        }
    }
    data_root.join("Seen.txt")
}

fn relative_to_game_dir(game_dir: &Path, target: &Path) -> String {
    let display = target
        .strip_prefix(game_dir)
        .map_or_else(|_| target.to_path_buf(), Path::to_path_buf);
    display
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn write_partial_adapter_report(
    output: &Path,
    report: &PartialAdapterReport,
) -> KaifuuResult<()> {
    let redacted = report.redacted_for_report();
    let json = stable_json(&redacted)?;
    atomic_write_text(output, &json)
}
