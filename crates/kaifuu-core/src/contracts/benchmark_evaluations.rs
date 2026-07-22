use super::*;

pub(super) fn validate_benchmark_penalty_summary(
    value: &Value,
    quality_severities: &[String],
    total_source_chars: u64,
    total_source_units: u64,
) -> BridgeContractResult<()> {
    let summary = as_record(value, "BenchmarkReportV02.penaltySummary")?;
    let penalty_total = required_number(
        summary,
        "penaltyTotal",
        "BenchmarkReportV02.penaltySummary.penaltyTotal",
    )?;
    let chars_penalty = required_number(
        summary,
        "penaltyPerThousandSourceChars",
        "BenchmarkReportV02.penaltySummary.penaltyPerThousandSourceChars",
    )?;
    let units_penalty = required_number(
        summary,
        "penaltyPerHundredSourceUnits",
        "BenchmarkReportV02.penaltySummary.penaltyPerHundredSourceUnits",
    )?;
    let expected_total: f64 = quality_severities
        .iter()
        .map(|severity| match severity.as_str() {
            "critical" => 25.0,
            "major" => 5.0,
            "minor" => 1.0,
            // "neutral" and any other severity contribute no penalty.
            _ => 0.0,
        })
        .sum();
    if (penalty_total - expected_total).abs() > f64::EPSILON {
        return error(
            "BenchmarkReportV02.penaltySummary.penaltyTotal must match findingRecords qualitySeverity weights from itotori-lqa-1",
        );
    }
    assert_number_within_tolerance(
        chars_penalty,
        (expected_total / total_source_chars as f64) * 1000.0,
        "BenchmarkReportV02.penaltySummary.penaltyPerThousandSourceChars",
        "findingRecords qualitySeverity weights normalized by fixtureOrCorpusRefs.sourceCharacterCount",
    )?;
    assert_number_within_tolerance(
        units_penalty,
        (expected_total / total_source_units as f64) * 100.0,
        "BenchmarkReportV02.penaltySummary.penaltyPerHundredSourceUnits",
        "findingRecords qualitySeverity weights normalized by fixtureOrCorpusRefs.sourceUnitCount",
    )
}

pub(super) fn validate_deterministic_qa_results(
    report: &Map<String, Value>,
    system_ids: &HashSet<String>,
    finding_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let results = required_array(
        report,
        "deterministicQaResults",
        "BenchmarkReportV02.deterministicQaResults",
    )?;
    for (index, result) in results.iter().enumerate() {
        let label = format!("BenchmarkReportV02.deterministicQaResults[{index}]");
        let result = as_record(result, &label)?;
        assert_required_uuid7(
            result,
            "deterministicQaRunId",
            &format!("{label}.deterministicQaRunId"),
        )?;
        let system_id = assert_required_string(
            result,
            "evaluatedSystemId",
            &format!("{label}.evaluatedSystemId"),
        )?;
        assert_known_string(
            system_id,
            &format!("{label}.evaluatedSystemId"),
            "system",
            system_ids,
        )?;
        assert_required_string(result, "checkName", &format!("{label}.checkName"))?;
        assert_required_string(result, "checkVersion", &format!("{label}.checkVersion"))?;
        super::benchmark_findings::validate_started_completed(result, &label)?;
        let rule_count = assert_required_non_negative_integer(
            result,
            "ruleCount",
            &format!("{label}.ruleCount"),
        )?;
        let passed = assert_required_non_negative_integer(
            result,
            "passedRuleCount",
            &format!("{label}.passedRuleCount"),
        )?;
        let failed = assert_required_non_negative_integer(
            result,
            "failedRuleCount",
            &format!("{label}.failedRuleCount"),
        )?;
        if passed + failed != rule_count {
            return error(format!(
                "{label}.passedRuleCount plus failedRuleCount must equal ruleCount"
            ));
        }
        assert_known_uuid_refs(
            required(result, "findingIds", &format!("{label}.findingIds"))?,
            &format!("{label}.findingIds"),
            "finding",
            finding_ids,
        )?;
        let artifact_refs =
            required_array(result, "artifactRefs", &format!("{label}.artifactRefs"))?;
        for (artifact_index, artifact_ref) in artifact_refs.iter().enumerate() {
            super::benchmark_findings::validate_benchmark_artifact_ref(
                artifact_ref,
                &format!("{label}.artifactRefs[{artifact_index}]"),
            )?;
        }
    }
    Ok(())
}

pub(super) fn validate_qa_agent_evaluations(
    report: &Map<String, Value>,
    system_ids: &HashSet<String>,
    provider_run_ids: &HashSet<String>,
    provider_run_system_ids: &HashMap<String, String>,
    finding_ids: &HashSet<String>,
    finding_system_ids: &HashMap<String, String>,
) -> BridgeContractResult<QaAgentEvaluationRefs> {
    let evaluations = required_array(
        report,
        "qaAgentEvaluations",
        "BenchmarkReportV02.qaAgentEvaluations",
    )?;
    let mut qa_agent_provider_ids: HashMap<String, HashSet<String>> = HashMap::new();
    let mut qa_agent_finding_ids: HashMap<String, HashSet<String>> = HashMap::new();
    for (index, evaluation) in evaluations.iter().enumerate() {
        let label = format!("BenchmarkReportV02.qaAgentEvaluations[{index}]");
        let evaluation = as_record(evaluation, &label)?;
        assert_required_uuid7(
            evaluation,
            "qaAgentEvaluationId",
            &format!("{label}.qaAgentEvaluationId"),
        )?;
        assert_required_string(evaluation, "qaAgentId", &format!("{label}.qaAgentId"))?;
        assert_required_string(
            evaluation,
            "qaAgentVersion",
            &format!("{label}.qaAgentVersion"),
        )?;
        let system_id = assert_required_string(
            evaluation,
            "evaluatedSystemId",
            &format!("{label}.evaluatedSystemId"),
        )?;
        assert_known_string(
            system_id,
            &format!("{label}.evaluatedSystemId"),
            "system",
            system_ids,
        )?;
        for id in assert_known_uuid_refs(
            required(
                evaluation,
                "providerRunIds",
                &format!("{label}.providerRunIds"),
            )?,
            &format!("{label}.providerRunIds"),
            "providerRun",
            provider_run_ids,
        )? {
            if provider_run_system_ids.get(&id) != Some(&system_id.to_string()) {
                return error(format!(
                    "{label}.providerRunIds must reference providerModelCostRecords for evaluatedSystemId {system_id}"
                ));
            }
            qa_agent_provider_ids
                .entry(system_id.to_string())
                .or_default()
                .insert(id);
        }
        for id in assert_known_uuid_refs(
            required(evaluation, "findingIds", &format!("{label}.findingIds"))?,
            &format!("{label}.findingIds"),
            "finding",
            finding_ids,
        )? {
            if finding_system_ids.get(&id) != Some(&system_id.to_string()) {
                return error(format!(
                    "{label}.findingIds must reference findingRecords for evaluatedSystemId {system_id}"
                ));
            }
            qa_agent_finding_ids
                .entry(system_id.to_string())
                .or_default()
                .insert(id);
        }
        validate_qa_agent_metrics(
            required(evaluation, "metrics", &format!("{label}.metrics"))?,
            &format!("{label}.metrics"),
        )?;
        assert_string_array(
            required(evaluation, "limitations", &format!("{label}.limitations"))?,
            &format!("{label}.limitations"),
        )?;
    }
    Ok(QaAgentEvaluationRefs {
        provider_run_ids: qa_agent_provider_ids,
        finding_ids: qa_agent_finding_ids,
    })
}

fn validate_qa_agent_metrics(value: &Value, label: &str) -> BridgeContractResult<()> {
    let metrics = as_record(value, label)?;
    for key in [
        "seededRecall",
        "seededPrecision",
        "f1",
        "categoryAccuracy",
        "qualitySeverityAccuracy",
        "rootCauseAccuracy",
        "criticalRecall",
        "unscorableRate",
    ] {
        assert_required_ratio(metrics, key, &format!("{label}.{key}"))?;
    }
    if let Some(value) = metrics.get("humanConfirmedPrecision") {
        ratio_value(value, &format!("{label}.humanConfirmedPrecision"))?;
    }
    let emitted = assert_required_non_negative_integer(
        metrics,
        "findingsEmitted",
        &format!("{label}.findingsEmitted"),
    )?;
    let scorable = assert_required_non_negative_integer(
        metrics,
        "scorableFindings",
        &format!("{label}.scorableFindings"),
    )?;
    let adjudicated = assert_required_non_negative_integer(
        metrics,
        "adjudicatedFindings",
        &format!("{label}.adjudicatedFindings"),
    )?;
    if scorable > emitted {
        return error(format!(
            "{label}.scorableFindings must not exceed findingsEmitted"
        ));
    }
    if adjudicated > emitted {
        return error(format!(
            "{label}.adjudicatedFindings must not exceed findingsEmitted"
        ));
    }
    Ok(())
}

pub(super) fn validate_human_evaluations(
    report: &Map<String, Value>,
    system_ids: &HashSet<String>,
    finding_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let evaluations = required_array(
        report,
        "humanEvaluationResults",
        "BenchmarkReportV02.humanEvaluationResults",
    )?;
    for (index, evaluation) in evaluations.iter().enumerate() {
        let label = format!("BenchmarkReportV02.humanEvaluationResults[{index}]");
        let evaluation = as_record(evaluation, &label)?;
        assert_required_uuid7(
            evaluation,
            "humanEvaluationId",
            &format!("{label}.humanEvaluationId"),
        )?;
        assert_required_uuid7(
            evaluation,
            "reviewSessionId",
            &format!("{label}.reviewSessionId"),
        )?;
        let evaluated_systems = required_array(
            evaluation,
            "evaluatedSystemIds",
            &format!("{label}.evaluatedSystemIds"),
        )?;
        if evaluated_systems.is_empty() {
            return error(format!(
                "{label}.evaluatedSystemIds must contain at least one system id"
            ));
        }
        for (system_index, system_id) in evaluated_systems.iter().enumerate() {
            let system_id = string_value(
                system_id,
                &format!("{label}.evaluatedSystemIds[{system_index}]"),
            )?;
            assert_known_string(
                system_id,
                &format!("{label}.evaluatedSystemIds[{system_index}]"),
                "system",
                system_ids,
            )?;
        }
        assert_required_positive_integer(
            evaluation,
            "reviewerCount",
            &format!("{label}.reviewerCount"),
        )?;
        assert_required_positive_integer(
            evaluation,
            "sampleUnitCount",
            &format!("{label}.sampleUnitCount"),
        )?;
        assert_required_positive_integer(
            evaluation,
            "sampleSourceCharacterCount",
            &format!("{label}.sampleSourceCharacterCount"),
        )?;
        assert_required_bool(evaluation, "blindReview", &format!("{label}.blindReview"))?;
        assert_known_uuid_refs(
            required(
                evaluation,
                "adjudicatedFindingIds",
                &format!("{label}.adjudicatedFindingIds"),
            )?,
            &format!("{label}.adjudicatedFindingIds"),
            "finding",
            finding_ids,
        )?;
        if let Some(notes) = evaluation.get("reviewerAgreementNotes") {
            string_value(notes, &format!("{label}.reviewerAgreementNotes"))?;
        }
    }
    Ok(())
}
