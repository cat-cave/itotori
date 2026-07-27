use super::*;

pub fn run_round_trip_golden(
    registry: &AdapterRegistry,
    request: GoldenHarnessRequest<'_>,
) -> KaifuuResult<GoldenRoundTripReport> {
    let adapter = golden_adapter(registry, request.game_dir, request.adapter_id)?;
    let mut report = GoldenRoundTripReport {
        schema_version: "0.1.0".to_string(),
        report_id: deterministic_id("golden-round-trip", 1),
        adapter_id: adapter.id().to_string(),
        adapter_name: adapter.name().to_string(),
        status: OperationStatus::Passed,
        phases: vec![],
        failures: vec![],
    };

    let detection = adapter.detect(DetectRequest {
        game_dir: request.game_dir,
    });
    match detection {
        Ok(detection) if detection.detected => report_passed_phase(
            &mut report,
            "detect",
            "adapter detected the fixture input",
            None,
        ),
        Ok(detection) => {
            let failure = GoldenFailure {
                code: "adapter_not_detected".to_string(),
                phase: "detect".to_string(),
                adapter_id: adapter.id().to_string(),
                message: "selected adapter did not detect the fixture input".to_string(),
                asset_ref: detection
                    .evidence
                    .first()
                    .map(|evidence| evidence.path.clone()),
                source_unit_key: None,
                support_boundary: None,
                expected: Some("detected=true".to_string()),
                actual: Some("detected=false".to_string()),
                required_capability: None,
            };
            record_golden_failure(&mut report, failure);
            return Ok(finalize_golden_report(report));
        }
        Err(error) => {
            record_golden_failure(
                &mut report,
                GoldenFailure {
                    code: "detect_error".to_string(),
                    phase: "detect".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("successful detection".to_string()),
                    actual: Some("adapter error".to_string()),
                    required_capability: None,
                },
            );
            return Ok(finalize_golden_report(report));
        }
    }

    let extraction = match adapter.extract(ExtractRequest {
        game_dir: request.game_dir,
    }) {
        Ok(extraction) => {
            report_passed_phase(
                &mut report,
                "extract",
                format!("extracted {} bridge unit(s)", extraction.bridge.units.len()),
                None,
            );
            extraction
        }
        Err(error) => {
            record_golden_failure(
                &mut report,
                GoldenFailure {
                    code: "extract_error".to_string(),
                    phase: "extract".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("successful extraction".to_string()),
                    actual: Some("adapter error".to_string()),
                    required_capability: None,
                },
            );
            return Ok(finalize_golden_report(report));
        }
    };

    let unchanged_patch = match unchanged_patch_export(&extraction.bridge) {
        Ok(patch) => patch,
        Err(failure) => {
            record_golden_failure(&mut report, (*failure).with_adapter_id(adapter.id()));
            return Ok(finalize_golden_report(report));
        }
    };

    let Some(unchanged_output_dir) = run_golden_patch_phase(GoldenPatchPhaseArgs {
        adapter,
        report: &mut report,
        phase: "unchanged_patch",
        game_dir: request.game_dir,
        work_dir: request.work_dir,
        work_child: "unchanged-patch",
        patch_export: &unchanged_patch,
        success_details: "unchanged patch applied successfully",
        patch_error_code: "unchanged_patch_error",
        patch_expected: "successful unchanged patch",
    })?
    else {
        return Ok(finalize_golden_report(report));
    };

    report_byte_equivalence(
        adapter,
        &mut report,
        request.game_dir,
        &unchanged_output_dir,
        &request.byte_equivalence,
    );
    report_verify_phase(
        adapter,
        &mut report,
        "unchanged_verify",
        &unchanged_output_dir,
    );
    report_output_equivalence(
        adapter,
        &mut report,
        &extraction,
        &unchanged_output_dir,
        "unchanged_output_equivalence",
    );

    if let Some(translated_patch_export) = request.translated_patch_export {
        report_translated_patch(
            adapter,
            &mut report,
            &extraction,
            request.game_dir,
            request.work_dir,
            translated_patch_export,
            request.translated_source_bridge,
        )?;
    }

    Ok(finalize_golden_report(report))
}

/// Arguments for [`run_golden_patch_phase`], grouping the distinct pipeline-stage
/// inputs into a single struct so the driver keeps a one-argument signature.
pub(crate) struct GoldenPatchPhaseArgs<'a> {
    pub(crate) adapter: &'a dyn EngineAdapter,
    pub(crate) report: &'a mut GoldenRoundTripReport,
    pub(crate) phase: &'a str,
    pub(crate) game_dir: &'a Path,
    pub(crate) work_dir: &'a Path,
    pub(crate) work_child: &'a str,
    pub(crate) patch_export: &'a PatchExport,
    pub(crate) success_details: &'a str,
    pub(crate) patch_error_code: &'a str,
    pub(crate) patch_expected: &'a str,
}

pub(crate) fn run_golden_patch_phase(
    args: GoldenPatchPhaseArgs<'_>,
) -> KaifuuResult<Option<PathBuf>> {
    let GoldenPatchPhaseArgs {
        adapter,
        report,
        phase,
        game_dir,
        work_dir,
        work_child,
        patch_export,
        success_details,
        patch_error_code,
        patch_expected,
    } = args;
    match adapter.patch_preflight(PatchPreflightRequest {
        game_dir,
        patch_export,
    }) {
        Ok(preflight)
            if preflight.status == OperationStatus::Failed
                && preflight.has_preflight_blocking_failure() =>
        {
            let preflight = preflight.redacted_for_report();
            record_adapter_failures(report, adapter.id(), phase, &preflight);
            return Ok(None);
        }
        Ok(_) => {}
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: format!("{phase}_preflight_error"),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some(format!("{patch_expected} preflight")),
                    actual: Some("adapter error".to_string()),
                    required_capability: None,
                },
            );
            return Ok(None);
        }
    }

    let output_dir = prepare_golden_work_dir(work_dir, work_child)?;
    match adapter.patch(PatchRequest {
        game_dir,
        patch_export,
        output_dir: &output_dir,
    }) {
        Ok(patch_result) if patch_result.status == OperationStatus::Passed => {
            report_passed_phase(report, phase, success_details, Some("source.json"));
        }
        Ok(patch_result) => {
            let patch_result = patch_result.redacted_for_report();
            record_adapter_failures(report, adapter.id(), phase, &patch_result);
            return Ok(None);
        }
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: patch_error_code.to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some(patch_expected.to_string()),
                    actual: Some("adapter error".to_string()),
                    required_capability: None,
                },
            );
            return Ok(None);
        }
    }

    Ok(Some(output_dir))
}

pub(crate) fn golden_adapter<'a>(
    registry: &'a AdapterRegistry,
    game_dir: &Path,
    adapter_id: Option<&str>,
) -> KaifuuResult<&'a dyn EngineAdapter> {
    if let Some(adapter_id) = adapter_id {
        return registry
            .get(adapter_id)
            .ok_or_else(|| format!("adapter {adapter_id} is not registered").into());
    }

    let detection = registry
        .detect(game_dir)?
        .ok_or_else(|| format!("no registered adapter detected {}", game_dir.display()))?;
    registry.get(&detection.adapter_id).ok_or_else(|| {
        format!(
            "detected adapter {} is not registered",
            detection.adapter_id
        )
        .into()
    })
}

pub(crate) fn prepare_golden_work_dir(root: &Path, child: &str) -> KaifuuResult<PathBuf> {
    let path = safe_join_relative(root, child)?;
    match fs::remove_dir_all(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub(crate) fn unchanged_patch_export(
    bridge: &BridgeBundle,
) -> Result<PatchExport, Box<GoldenFailure>> {
    let mut entries = Vec::with_capacity(bridge.units.len());
    for unit in &bridge.units {
        let mut protected_span_mappings = Vec::new();
        let mut search_start = 0;
        for span in &unit.protected_spans {
            if span.raw.is_empty() {
                continue;
            }
            let Some(relative_start) = unit.source_text[search_start..].find(&span.raw) else {
                let span_summary = RedactedContentSummary::from_text(&span.raw);
                let source_summary = RedactedContentSummary::from_text(&unit.source_text);
                return Err(Box::new(GoldenFailure {
                    code: "unchanged_patch_protected_span_missing".to_string(),
                    phase: "unchanged_patch_build".to_string(),
                    adapter_id: String::new(),
                    message: format!(
                        "protected span raw text {span_summary} was not present while building unchanged patch"
                    ),
                    asset_ref: Some(unit.patch_ref.asset_id.clone()),
                    source_unit_key: Some(unit.source_unit_key.clone()),
                    support_boundary: Some(
                        "unchanged patch generation requires protected span raw text to exist in sourceText"
                            .to_string(),
                    ),
                    expected: Some(span_summary.to_string()),
                    actual: Some(source_summary.to_string()),
                                    required_capability: None,
}));
            };
            let target_start = search_start + relative_start;
            let target_end = target_start + span.raw.len();
            search_start = target_end;
            protected_span_mappings.push(
                ProtectedSpanMapping::new(&span.raw, target_start as u64, target_end as u64)
                    .with_source_identity(span.span_id.clone(), span.start, span.end),
            );
        }
        entries.push(PatchExportEntry {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            source_hash: unit.source_hash.clone(),
            target_text: unit.source_text.clone(),
            protected_span_mappings,
        });
    }

    Ok(PatchExport {
        patch_export_id: deterministic_id("round-trip-patch", 1),
        source_locale: bridge.source_locale.clone(),
        target_locale: bridge.source_locale.clone(),
        entries,
    })
}

impl GoldenFailure {
    pub(crate) fn with_adapter_id(mut self, adapter_id: &str) -> Self {
        self.adapter_id = adapter_id.to_string();
        self
    }
}

pub(crate) fn report_passed_phase(
    report: &mut GoldenRoundTripReport,
    phase: &str,
    details: impl Into<String>,
    asset_ref: Option<&str>,
) {
    report.phases.push(GoldenPhaseReport {
        phase: phase.to_string(),
        status: GoldenAssertionStatus::Passed,
        details: details.into(),
        asset_ref: asset_ref.map(str::to_string),
        source_unit_key: None,
        support_boundary: None,
        expected: None,
        actual: None,
        required_capability: None,
    });
}

pub(crate) fn record_golden_failure(report: &mut GoldenRoundTripReport, failure: GoldenFailure) {
    report.phases.push(GoldenPhaseReport {
        phase: failure.phase.clone(),
        status: GoldenAssertionStatus::Failed,
        details: failure.message.clone(),
        asset_ref: failure.asset_ref.clone(),
        source_unit_key: failure.source_unit_key.clone(),
        support_boundary: failure.support_boundary.clone(),
        expected: failure.expected.clone(),
        actual: failure.actual.clone(),
        required_capability: None,
    });
    report.failures.push(failure);
}

pub(crate) fn golden_error_summary(error: impl fmt::Display) -> String {
    let rendered = error.to_string();
    format!("error {}", RedactedContentSummary::from_text(&rendered))
}

pub(crate) fn golden_diagnostic_summary(diagnostic: &str) -> String {
    format!(
        "diagnostic {}",
        RedactedContentSummary::from_text(diagnostic)
    )
}
