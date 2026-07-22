use super::{
    triage::{validate_evidence_array, validate_provenance_array},
    *,
};

#[path = "benchmark_evaluations.rs"]
mod benchmark_evaluations;
#[path = "benchmark_findings.rs"]
mod benchmark_findings;
#[path = "benchmark_provider.rs"]
mod benchmark_provider;

pub fn validate_benchmark_report_v02(value: &Value) -> BridgeContractResult<()> {
    assert_no_confidence_fields(value, "BenchmarkReportV02")?;
    let report = as_record(value, "BenchmarkReportV02")?;
    assert_schema_version(report, "BenchmarkReportV02")?;
    assert_required_uuid7(
        report,
        "benchmarkRunId",
        "BenchmarkReportV02.benchmarkRunId",
    )?;
    assert_literal(
        report,
        "taxonomyId",
        "itotori-lqa-1",
        "BenchmarkReportV02.taxonomyId",
    )?;
    assert_literal(
        report,
        "taxonomyVersion",
        "itotori-quality-taxonomy-0.1.0",
        "BenchmarkReportV02.taxonomyVersion",
    )?;
    assert_required_rfc3339(report, "createdAt", "BenchmarkReportV02.createdAt")?;
    assert_required_string(report, "benchmarkName", "BenchmarkReportV02.benchmarkName")?;
    assert_required_one_of(
        report,
        "status",
        &["passed", "failed", "partial"],
        "BenchmarkReportV02.status",
    )?;
    assert_required_string(report, "sourceLocale", "BenchmarkReportV02.sourceLocale")?;
    assert_required_string(report, "targetLocale", "BenchmarkReportV02.targetLocale")?;
    assert_required_string(report, "engineProfile", "BenchmarkReportV02.engineProfile")?;
    assert_required_string(report, "gitCommit", "BenchmarkReportV02.gitCommit")?;
    assert_literal(
        report,
        "bridgeSchemaVersion",
        BRIDGE_SCHEMA_VERSION_V02,
        "BenchmarkReportV02.bridgeSchemaVersion",
    )?;
    if let Some(seed) = report.get("deterministicSeed") {
        string_value(seed, "BenchmarkReportV02.deterministicSeed")?;
    }

    let input_refs = required_array(
        report,
        "fixtureOrCorpusRefs",
        "BenchmarkReportV02.fixtureOrCorpusRefs",
    )?;
    if input_refs.is_empty() {
        return error("BenchmarkReportV02.fixtureOrCorpusRefs must contain at least one ref");
    }
    let mut input_ref_ids = HashSet::new();
    let mut total_source_units = 0_u64;
    let mut total_source_chars = 0_u64;
    for (index, input_ref) in input_refs.iter().enumerate() {
        let label = format!("BenchmarkReportV02.fixtureOrCorpusRefs[{index}]");
        let input_ref = as_record(input_ref, &label)?;
        let corpus_ref_id =
            assert_required_string(input_ref, "corpusRefId", &format!("{label}.corpusRefId"))?;
        if !input_ref_ids.insert(corpus_ref_id.to_string()) {
            return error(format!(
                "{label}.corpusRefId must be unique within fixtureOrCorpusRefs"
            ));
        }
        let corpus_kind = assert_required_one_of(
            input_ref,
            "corpusKind",
            &[
                "public_fixture",
                "private_local_corpus",
                "synthetic_fixture",
            ],
            &format!("{label}.corpusKind"),
        )?;
        assert_required_string(input_ref, "label", &format!("{label}.label"))?;
        if let Some(uri) = input_ref.get("manifestUri") {
            assert_portable_uri(uri, &format!("{label}.manifestUri"))?;
        }
        if let Some(hash) = input_ref.get("manifestHash") {
            assert_hash_value(hash, &format!("{label}.manifestHash"))?;
        }
        if let Some(hash) = input_ref.get("sourceBundleHash") {
            assert_hash_value(hash, &format!("{label}.sourceBundleHash"))?;
        }
        for key in [
            "sourceLocale",
            "targetLocale",
            "engineProfile",
            "benchmarkSplit",
        ] {
            assert_required_string(input_ref, key, &format!("{label}.{key}"))?;
        }
        let source_unit_count = assert_required_positive_integer(
            input_ref,
            "sourceUnitCount",
            &format!("{label}.sourceUnitCount"),
        )?;
        let source_char_count = assert_required_positive_integer(
            input_ref,
            "sourceCharacterCount",
            &format!("{label}.sourceCharacterCount"),
        )?;
        total_source_units += source_unit_count;
        total_source_chars += source_char_count;
        let public_content = assert_required_bool(
            input_ref,
            "publicContent",
            &format!("{label}.publicContent"),
        )?;
        if corpus_kind == "private_local_corpus" && public_content {
            return error(format!(
                "{label}.publicContent must be false for private_local_corpus"
            ));
        }
    }

    benchmark_findings::validate_tool_versions(report)?;
    benchmark_findings::validate_command_lines(report)?;

    let systems = required_array(
        report,
        "systemsCompared",
        "BenchmarkReportV02.systemsCompared",
    )?;
    if systems.is_empty() {
        return error("BenchmarkReportV02.systemsCompared must contain at least one system");
    }
    let mut system_ids = HashSet::new();
    let mut declared_provider_run_ids = HashSet::new();
    for (index, system) in systems.iter().enumerate() {
        let label = format!("BenchmarkReportV02.systemsCompared[{index}]");
        let system = as_record(system, &label)?;
        let system_id = assert_required_string(system, "systemId", &format!("{label}.systemId"))?;
        if !system_ids.insert(system_id.to_string()) {
            return error(format!(
                "{label}.systemId must be unique within systemsCompared"
            ));
        }
        assert_required_one_of(
            system,
            "systemKind",
            &[
                "raw_mtl_baseline",
                "itotori_draft",
                "itotori_repaired",
                "human_reference",
                "deterministic_fixture",
            ],
            &format!("{label}.systemKind"),
        )?;
        assert_required_string(system, "displayName", &format!("{label}.displayName"))?;
        assert_required_rfc3339(system, "generatedAt", &format!("{label}.generatedAt"))?;
        let provider_run_ids =
            required_array(system, "providerRunIds", &format!("{label}.providerRunIds"))?;
        for (provider_index, provider_run_id) in provider_run_ids.iter().enumerate() {
            let provider_run_id = string_value(
                provider_run_id,
                &format!("{label}.providerRunIds[{provider_index}]"),
            )?;
            assert_uuid7(
                provider_run_id,
                &format!("{label}.providerRunIds[{provider_index}]"),
            )?;
            declared_provider_run_ids.insert(provider_run_id.to_string());
        }
        if !provider_run_ids.is_empty() && system.get("promptPresetId").is_none() {
            return error(format!(
                "{label}.promptPresetId is required when providerRunIds are present"
            ));
        }
        if let Some(prompt_preset_id) = system.get("promptPresetId") {
            string_value(prompt_preset_id, &format!("{label}.promptPresetId"))?;
        }
        if let Some(prompt_preset_version) = system.get("promptPresetVersion") {
            string_value(
                prompt_preset_version,
                &format!("{label}.promptPresetVersion"),
            )?;
        }
        if let Some(artifact) = system.get("outputArtifactRef") {
            benchmark_findings::validate_benchmark_artifact_ref(
                artifact,
                &format!("{label}.outputArtifactRef"),
            )?;
        }
    }

    let provider_runs = required_array(
        report,
        "providerModelCostRecords",
        "BenchmarkReportV02.providerModelCostRecords",
    )?;
    let mut provider_run_ids = HashSet::new();
    let mut provider_run_system_ids = HashMap::new();
    let mut llm_qa_provider_run_system_ids = HashMap::new();
    let mut cost_totals_by_system: HashMap<String, u64> = HashMap::new();
    let mut report_total_micros_usd = 0_u64;
    let mut includes_unknown_cost = false;
    for (index, run) in provider_runs.iter().enumerate() {
        let label = format!("BenchmarkReportV02.providerModelCostRecords[{index}]");
        let run = as_record(run, &label)?;
        let provider_run_id = benchmark_provider::validate_benchmark_provider_run(
            run,
            &label,
            &system_ids,
            &mut cost_totals_by_system,
            &mut report_total_micros_usd,
            &mut includes_unknown_cost,
        )?;
        if !provider_run_ids.insert(provider_run_id.clone()) {
            return error(format!(
                "{label}.providerRunId must be unique within providerModelCostRecords"
            ));
        }
        let provider_run_system_id = string_field(run, "systemId")?.to_string();
        provider_run_system_ids.insert(provider_run_id.clone(), provider_run_system_id.clone());
        if string_field(run, "taskKind")? == "llm_qa" {
            llm_qa_provider_run_system_ids.insert(provider_run_id, provider_run_system_id);
        }
    }
    for provider_run_id in &declared_provider_run_ids {
        if !provider_run_ids.contains(provider_run_id) {
            return error(format!(
                "BenchmarkReportV02.systemsCompared providerRunId {provider_run_id} must reference providerModelCostRecords"
            ));
        }
    }
    benchmark_provider::validate_benchmark_cost_ledger(
        required(report, "costLedger", "BenchmarkReportV02.costLedger")?,
        &system_ids,
        report_total_micros_usd,
        &cost_totals_by_system,
        includes_unknown_cost,
    )?;

    let seed_records = required_array(
        report,
        "seededDefectOracle",
        "BenchmarkReportV02.seededDefectOracle",
    )?;
    let mut seeded_defect_ids = HashSet::new();
    let mut seeded_matched_finding_ids: Vec<(usize, usize, String)> = Vec::new();
    for (index, seed) in seed_records.iter().enumerate() {
        let label = format!("BenchmarkReportV02.seededDefectOracle[{index}]");
        let seed = as_record(seed, &label)?;
        let seed_id = benchmark_findings::validate_seeded_defect(seed, &label, &input_ref_ids)?;
        if !seeded_defect_ids.insert(seed_id) {
            return error(format!(
                "{label}.seededDefectId must be unique within seededDefectOracle"
            ));
        }
        let matched = required_array(
            seed,
            "matchedFindingIds",
            &format!("{label}.matchedFindingIds"),
        )?;
        for (matched_index, finding_id) in matched.iter().enumerate() {
            seeded_matched_finding_ids.push((
                index,
                matched_index,
                string_value(
                    finding_id,
                    &format!("{label}.matchedFindingIds[{matched_index}]"),
                )?
                .to_string(),
            ));
        }
    }

    let finding_records = required_array(
        report,
        "findingRecords",
        "BenchmarkReportV02.findingRecords",
    )?;
    let mut finding_ids = HashSet::new();
    let mut quality_severities = Vec::new();
    let mut categories = Vec::new();
    let mut root_causes = Vec::new();
    let mut detector_kinds = Vec::new();
    let mut adjudication_states = Vec::new();
    let mut finding_system_ids = HashMap::new();
    let mut llm_qa_finding_system_ids = HashMap::new();
    for (index, finding) in finding_records.iter().enumerate() {
        let label = format!("BenchmarkReportV02.findingRecords[{index}]");
        let finding = as_record(finding, &label)?;
        let finding_id = benchmark_findings::validate_benchmark_finding_record(
            finding,
            &label,
            &system_ids,
            &seeded_defect_ids,
        )?;
        if !finding_ids.insert(finding_id.clone()) {
            return error(format!(
                "{label}.findingId must be unique within findingRecords"
            ));
        }
        let severity = string_field(finding, "qualitySeverity")?.to_string();
        let category = string_field(finding, "category")?.to_string();
        let root_cause = string_field(finding, "rootCause")?.to_string();
        let detector_kind = string_field(finding, "detectorKind")?.to_string();
        let adjudication_state = string_field(finding, "adjudicationState")?.to_string();
        let finding_system_id = string_field(finding, "systemId")?.to_string();
        finding_system_ids.insert(finding_id.clone(), finding_system_id.clone());
        if detector_kind == "llm_qa" {
            llm_qa_finding_system_ids.insert(finding_id, finding_system_id);
        }
        quality_severities.push(severity);
        categories.push(category);
        root_causes.push(root_cause);
        detector_kinds.push(detector_kind);
        adjudication_states.push(adjudication_state);
    }
    for (seed_index, match_index, finding_id) in seeded_matched_finding_ids {
        if !finding_ids.contains(&finding_id) {
            return error(format!(
                "BenchmarkReportV02.seededDefectOracle[{seed_index}].matchedFindingIds[{match_index}] must reference findingRecords"
            ));
        }
    }

    benchmark_findings::assert_count_buckets_match(
        &quality_severities,
        required(
            report,
            "countsByQualitySeverity",
            "BenchmarkReportV02.countsByQualitySeverity",
        )?,
        LOCALIZATION_QUALITY_SEVERITIES,
        "BenchmarkReportV02.countsByQualitySeverity",
    )?;
    benchmark_findings::assert_count_buckets_match(
        &categories,
        required(
            report,
            "countsByCategory",
            "BenchmarkReportV02.countsByCategory",
        )?,
        LOCALIZATION_QUALITY_CATEGORIES,
        "BenchmarkReportV02.countsByCategory",
    )?;
    benchmark_findings::assert_count_buckets_match(
        &root_causes,
        required(
            report,
            "countsByRootCause",
            "BenchmarkReportV02.countsByRootCause",
        )?,
        LOCALIZATION_ROOT_CAUSES,
        "BenchmarkReportV02.countsByRootCause",
    )?;
    benchmark_findings::assert_count_buckets_match(
        &detector_kinds,
        required(
            report,
            "countsByDetectorKind",
            "BenchmarkReportV02.countsByDetectorKind",
        )?,
        QUALITY_DETECTOR_KINDS,
        "BenchmarkReportV02.countsByDetectorKind",
    )?;
    benchmark_findings::assert_count_buckets_match(
        &adjudication_states,
        required(
            report,
            "countsByAdjudicationState",
            "BenchmarkReportV02.countsByAdjudicationState",
        )?,
        LOCALIZATION_ADJUDICATION_STATES,
        "BenchmarkReportV02.countsByAdjudicationState",
    )?;
    benchmark_evaluations::validate_benchmark_penalty_summary(
        required(
            report,
            "penaltySummary",
            "BenchmarkReportV02.penaltySummary",
        )?,
        &quality_severities,
        total_source_chars,
        total_source_units,
    )?;

    benchmark_evaluations::validate_deterministic_qa_results(report, &system_ids, &finding_ids)?;
    let qa_agent_refs = benchmark_evaluations::validate_qa_agent_evaluations(
        report,
        &system_ids,
        &provider_run_ids,
        &provider_run_system_ids,
        &finding_ids,
        &finding_system_ids,
    )?;
    benchmark_evaluations::validate_human_evaluations(report, &system_ids, &finding_ids)?;
    for (provider_run_id, system_id) in &llm_qa_provider_run_system_ids {
        if !qa_agent_refs
            .provider_run_ids
            .get(system_id)
            .is_some_and(|ids| ids.contains(provider_run_id))
        {
            return error(format!(
                "BenchmarkReportV02.qaAgentEvaluations.providerRunIds must cover llm_qa providerModelCostRecords run {provider_run_id} for evaluatedSystemId {system_id}"
            ));
        }
    }
    for (finding_id, system_id) in &llm_qa_finding_system_ids {
        if !qa_agent_refs
            .finding_ids
            .get(system_id)
            .is_some_and(|ids| ids.contains(finding_id))
        {
            return error(format!(
                "BenchmarkReportV02.qaAgentEvaluations.findingIds must cover llm_qa findingRecords finding {finding_id} for evaluatedSystemId {system_id}"
            ));
        }
    }
    assert_string_array(
        required(
            report,
            "knownBlindSpots",
            "BenchmarkReportV02.knownBlindSpots",
        )?,
        "BenchmarkReportV02.knownBlindSpots",
    )?;
    Ok(())
}
