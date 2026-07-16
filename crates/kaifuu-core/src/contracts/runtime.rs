use super::*;

pub fn validate_runtime_evidence_report_v02(value: &Value) -> BridgeContractResult<()> {
    let report = as_record(value, "RuntimeEvidenceReportV02")?;
    assert_schema_version(report, "RuntimeEvidenceReportV02")?;
    assert_required_uuid7(
        report,
        "runtimeReportId",
        "RuntimeEvidenceReportV02.runtimeReportId",
    )?;
    if let Some(source_bridge_id) = report.get("sourceBridgeId") {
        assert_uuid7_value(source_bridge_id, "RuntimeEvidenceReportV02.sourceBridgeId")?;
    }
    if let Some(source_bundle_hash) = report.get("sourceBundleHash") {
        assert_hash_value(
            source_bundle_hash,
            "RuntimeEvidenceReportV02.sourceBundleHash",
        )?;
    }
    if let Some(source_locale) = report.get("sourceLocale") {
        string_value(source_locale, "RuntimeEvidenceReportV02.sourceLocale")?;
    }
    if let Some(target_locale) = report.get("targetLocale") {
        string_value(target_locale, "RuntimeEvidenceReportV02.targetLocale")?;
    }
    assert_required_string(
        report,
        "adapterName",
        "RuntimeEvidenceReportV02.adapterName",
    )?;
    assert_required_string(
        report,
        "adapterVersion",
        "RuntimeEvidenceReportV02.adapterVersion",
    )?;
    let fidelity_tier = assert_required_one_of(
        report,
        "fidelityTier",
        RUNTIME_FIDELITY_TIERS,
        "RuntimeEvidenceReportV02.fidelityTier",
    )?;
    let evidence_tier = assert_required_one_of(
        report,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        "RuntimeEvidenceReportV02.evidenceTier",
    )?;
    assert_runtime_evidence_tier_within_fidelity(evidence_tier, fidelity_tier)?;
    let report_status = assert_required_one_of(
        report,
        "status",
        &["passed", "failed"],
        "RuntimeEvidenceReportV02.status",
    )?;
    if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
        validate_runtime_capability_contract(
            runtime_capabilities,
            "RuntimeEvidenceReportV02.runtimeCapabilities",
            fidelity_tier,
            evidence_tier,
        )?;
    }
    if let Some(controlled_playback_session) = report.get("controlledPlaybackSession") {
        validate_controlled_playback_session(
            controlled_playback_session,
            "RuntimeEvidenceReportV02.controlledPlaybackSession",
            report,
            fidelity_tier,
            evidence_tier,
            report_status,
        )?;
    }
    assert_required_rfc3339(report, "createdAt", "RuntimeEvidenceReportV02.createdAt")?;

    let trace_events = required_array(
        report,
        "traceEvents",
        "RuntimeEvidenceReportV02.traceEvents",
    )?;
    for (index, event) in trace_events.iter().enumerate() {
        validate_runtime_trace_event(
            event,
            &format!("RuntimeEvidenceReportV02.traceEvents[{index}]"),
        )?;
    }
    let branch_events = required_array(
        report,
        "branchEvents",
        "RuntimeEvidenceReportV02.branchEvents",
    )?;
    for (index, event) in branch_events.iter().enumerate() {
        validate_runtime_branch_event(
            event,
            &format!("RuntimeEvidenceReportV02.branchEvents[{index}]"),
        )?;
    }
    let observation_hook_events = optional_array(
        report,
        "observationHookEvents",
        "RuntimeEvidenceReportV02.observationHookEvents",
    )?;
    for (index, event) in observation_hook_events.iter().enumerate() {
        validate_observation_hook_event(
            event,
            &format!("RuntimeEvidenceReportV02.observationHookEvents[{index}]"),
            evidence_tier,
        )?;
    }
    let captures = required_array(report, "captures", "RuntimeEvidenceReportV02.captures")?;
    for (index, capture) in captures.iter().enumerate() {
        validate_runtime_capture(
            capture,
            &format!("RuntimeEvidenceReportV02.captures[{index}]"),
        )?;
    }
    let recordings = required_array(report, "recordings", "RuntimeEvidenceReportV02.recordings")?;
    for (index, recording) in recordings.iter().enumerate() {
        validate_runtime_recording(
            recording,
            &format!("RuntimeEvidenceReportV02.recordings[{index}]"),
        )?;
    }
    let approximations = required_array(
        report,
        "approximations",
        "RuntimeEvidenceReportV02.approximations",
    )?;
    for (index, approximation) in approximations.iter().enumerate() {
        validate_runtime_approximation(
            approximation,
            &format!("RuntimeEvidenceReportV02.approximations[{index}]"),
        )?;
    }
    let findings = required_array(
        report,
        "validationFindings",
        "RuntimeEvidenceReportV02.validationFindings",
    )?;
    for (index, finding) in findings.iter().enumerate() {
        validate_runtime_validation_finding(
            finding,
            &format!("RuntimeEvidenceReportV02.validationFindings[{index}]"),
        )?;
    }
    let reference_comparisons = optional_array(
        report,
        "referenceComparisons",
        "RuntimeEvidenceReportV02.referenceComparisons",
    )?;
    let mut has_passed_reference_comparison = false;
    for (index, comparison) in reference_comparisons.iter().enumerate() {
        if validate_runtime_reference_comparison(
            comparison,
            &format!("RuntimeEvidenceReportV02.referenceComparisons[{index}]"),
        )? {
            has_passed_reference_comparison = true;
        }
    }
    assert_string_array(
        required(
            report,
            "limitations",
            "RuntimeEvidenceReportV02.limitations",
        )?,
        "RuntimeEvidenceReportV02.limitations",
    )?;

    if let Some(controlled_playback_session) = report.get("controlledPlaybackSession") {
        let session = as_record(
            controlled_playback_session,
            "RuntimeEvidenceReportV02.controlledPlaybackSession",
        )?;
        validate_controlled_playback_session_evidence_surface(
            string_field(session, "requestedOperation")?,
            !branch_events.is_empty(),
            !captures.is_empty(),
            !recordings.is_empty(),
            !reference_comparisons.is_empty(),
            "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation",
        )?;
    }

    if trace_events.is_empty()
        && observation_hook_events.is_empty()
        && captures.is_empty()
        && recordings.is_empty()
    {
        return error(
            "RuntimeEvidenceReportV02 must contain trace, observation hook, capture, or recording evidence",
        );
    }
    if !captures.is_empty() {
        assert_minimum_runtime_evidence_tier(
            evidence_tier,
            "E2",
            "RuntimeEvidenceReportV02.evidenceTier",
        )?;
        if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
            validate_runtime_capability_supports_feature(
                runtime_capabilities,
                "frame_capture",
                "RuntimeEvidenceReportV02.runtimeCapabilities",
            )?;
        }
    }
    if !recordings.is_empty() {
        assert_minimum_runtime_evidence_tier(
            evidence_tier,
            "E3",
            "RuntimeEvidenceReportV02.evidenceTier",
        )?;
        if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
            validate_runtime_capability_supports_feature(
                runtime_capabilities,
                "recording",
                "RuntimeEvidenceReportV02.runtimeCapabilities",
            )?;
        }
    }
    if !trace_events.is_empty()
        && let Some(runtime_capabilities) = report.get("runtimeCapabilities")
    {
        validate_runtime_capability_supports_feature(
            runtime_capabilities,
            "text_trace",
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
    }
    if !branch_events.is_empty()
        && let Some(runtime_capabilities) = report.get("runtimeCapabilities")
    {
        validate_runtime_capability_supports_feature(
            runtime_capabilities,
            "branch_discovery",
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
    }
    if !observation_hook_events.is_empty() {
        let runtime_capabilities = report.get("runtimeCapabilities").ok_or_else(|| {
            BridgeContractValidationError::new(
                "RuntimeEvidenceReportV02.runtimeCapabilities is required when observationHookEvents are present",
            )
        })?;
        validate_runtime_capability_supports_feature(
            runtime_capabilities,
            "instrumentation_hooks",
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
    }
    if fidelity_tier != "reference_fidelity" && approximations.is_empty() {
        return error(
            "RuntimeEvidenceReportV02.approximations must document non-reference runtime limits",
        );
    }
    if (fidelity_tier == "reference_fidelity" || evidence_tier == "E4")
        && !has_passed_reference_comparison
    {
        return error(
            "RuntimeEvidenceReportV02.referenceComparisons must include passed reference-runtime or conformance comparison evidence for E4/reference_fidelity claims",
        );
    }
    if !reference_comparisons.is_empty()
        && let Some(runtime_capabilities) = report.get("runtimeCapabilities")
    {
        validate_runtime_capability_supports_feature(
            runtime_capabilities,
            "reference_comparison",
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
    }
    if string_field(report, "status")? == "failed" && findings.is_empty() {
        return error(
            "RuntimeEvidenceReportV02.validationFindings must explain failed runtime evidence",
        );
    }
    Ok(())
}
