use super::{
    triage::{validate_evidence_array, validate_provenance_array},
    *,
};

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

    validate_tool_versions(report)?;
    validate_command_lines(report)?;

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
            validate_benchmark_artifact_ref(artifact, &format!("{label}.outputArtifactRef"))?;
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
        let provider_run_id = validate_benchmark_provider_run(
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
    validate_benchmark_cost_ledger(
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
        let seed_id = validate_seeded_defect(seed, &label, &input_ref_ids)?;
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
        let finding_id =
            validate_benchmark_finding_record(finding, &label, &system_ids, &seeded_defect_ids)?;
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

    assert_count_buckets_match(
        &quality_severities,
        required(
            report,
            "countsByQualitySeverity",
            "BenchmarkReportV02.countsByQualitySeverity",
        )?,
        LOCALIZATION_QUALITY_SEVERITIES,
        "BenchmarkReportV02.countsByQualitySeverity",
    )?;
    assert_count_buckets_match(
        &categories,
        required(
            report,
            "countsByCategory",
            "BenchmarkReportV02.countsByCategory",
        )?,
        LOCALIZATION_QUALITY_CATEGORIES,
        "BenchmarkReportV02.countsByCategory",
    )?;
    assert_count_buckets_match(
        &root_causes,
        required(
            report,
            "countsByRootCause",
            "BenchmarkReportV02.countsByRootCause",
        )?,
        LOCALIZATION_ROOT_CAUSES,
        "BenchmarkReportV02.countsByRootCause",
    )?;
    assert_count_buckets_match(
        &detector_kinds,
        required(
            report,
            "countsByDetectorKind",
            "BenchmarkReportV02.countsByDetectorKind",
        )?,
        QUALITY_DETECTOR_KINDS,
        "BenchmarkReportV02.countsByDetectorKind",
    )?;
    assert_count_buckets_match(
        &adjudication_states,
        required(
            report,
            "countsByAdjudicationState",
            "BenchmarkReportV02.countsByAdjudicationState",
        )?,
        LOCALIZATION_ADJUDICATION_STATES,
        "BenchmarkReportV02.countsByAdjudicationState",
    )?;
    validate_benchmark_penalty_summary(
        required(
            report,
            "penaltySummary",
            "BenchmarkReportV02.penaltySummary",
        )?,
        &quality_severities,
        total_source_chars,
        total_source_units,
    )?;

    validate_deterministic_qa_results(report, &system_ids, &finding_ids)?;
    let qa_agent_refs = validate_qa_agent_evaluations(
        report,
        &system_ids,
        &provider_run_ids,
        &provider_run_system_ids,
        &finding_ids,
        &finding_system_ids,
    )?;
    validate_human_evaluations(report, &system_ids, &finding_ids)?;
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

fn validate_benchmark_provider_run(
    run: &Map<String, Value>,
    label: &str,
    system_ids: &HashSet<String>,
    cost_totals_by_system: &mut HashMap<String, u64>,
    report_total_micros_usd: &mut u64,
    includes_unknown_cost: &mut bool,
) -> BridgeContractResult<String> {
    let provider_run_id =
        assert_required_uuid7(run, "providerRunId", &format!("{label}.providerRunId"))?;
    let system_id = assert_required_string(run, "systemId", &format!("{label}.systemId"))?;
    assert_known_string(
        system_id,
        &format!("{label}.systemId"),
        "system",
        system_ids,
    )?;
    assert_required_one_of(
        run,
        "taskKind",
        &[
            "extract",
            "draft_translation",
            "deterministic_qa",
            "llm_qa",
            "patch",
            "runtime_verify",
            "human_review",
            "repair",
        ],
        &format!("{label}.taskKind"),
    )?;
    validate_started_completed(run, label)?;
    if let Some(latency_ms) = run.get("latencyMs") {
        non_negative_integer_value(latency_ms, &format!("{label}.latencyMs"))?;
    }
    assert_required_one_of(
        run,
        "status",
        &["succeeded", "failed", "partial", "skipped"],
        &format!("{label}.status"),
    )?;
    validate_benchmark_provider_identity(
        required(run, "provider", &format!("{label}.provider"))?,
        &format!("{label}.provider"),
    )?;
    validate_benchmark_prompt_identity(
        required(run, "prompt", &format!("{label}.prompt"))?,
        &format!("{label}.prompt"),
    )?;
    assert_required_string(
        run,
        "structuredOutputMode",
        &format!("{label}.structuredOutputMode"),
    )?;
    assert_required_non_negative_integer(run, "retryCount", &format!("{label}.retryCount"))?;
    assert_string_array(
        required(run, "errorClasses", &format!("{label}.errorClasses"))?,
        &format!("{label}.errorClasses"),
    )?;
    assert_required_bool(run, "fallbackUsed", &format!("{label}.fallbackUsed"))?;
    if let Some(fallback_plan) = run.get("fallbackPlan") {
        assert_string_array(fallback_plan, &format!("{label}.fallbackPlan"))?;
    }
    validate_token_usage(
        required(run, "tokenUsage", &format!("{label}.tokenUsage"))?,
        &format!("{label}.tokenUsage"),
    )?;
    let cost_amount = validate_cost_amount(
        required(run, "cost", &format!("{label}.cost"))?,
        &format!("{label}.cost"),
    )?;
    if cost_amount.is_none() {
        *includes_unknown_cost = true;
    } else {
        let amount = cost_amount.unwrap_or(0);
        *report_total_micros_usd += amount;
        *cost_totals_by_system
            .entry(system_id.to_string())
            .or_default() += amount;
    }
    Ok(provider_run_id.to_string())
}

fn validate_benchmark_provider_identity(value: &Value, label: &str) -> BridgeContractResult<()> {
    let provider = as_record(value, label)?;
    assert_required_one_of(
        provider,
        "providerFamily",
        &[
            "fake",
            "recorded",
            "openrouter",
            "local-openai-compatible",
            "external_mtl",
            "local_tool",
        ],
        &format!("{label}.providerFamily"),
    )?;
    for key in [
        "endpointFamily",
        "providerName",
        "requestedModelId",
        "actualModelId",
    ] {
        assert_required_string(provider, key, &format!("{label}.{key}"))?;
    }
    for key in ["upstreamProvider", "routeSettingsHash"] {
        if let Some(value) = provider.get(key) {
            if key == "routeSettingsHash" {
                assert_hash_value(value, &format!("{label}.{key}"))?;
            } else {
                string_value(value, &format!("{label}.{key}"))?;
            }
        }
    }
    Ok(())
}

fn validate_benchmark_prompt_identity(value: &Value, label: &str) -> BridgeContractResult<()> {
    let prompt = as_record(value, label)?;
    assert_required_string(prompt, "promptPresetId", &format!("{label}.promptPresetId"))?;
    assert_required_string(
        prompt,
        "promptTemplateVersion",
        &format!("{label}.promptTemplateVersion"),
    )?;
    for key in ["promptHash", "remotePresetConfigHash"] {
        if let Some(value) = prompt.get(key) {
            assert_hash_value(value, &format!("{label}.{key}"))?;
        }
    }
    for key in ["remotePresetSlug", "remotePresetVersion"] {
        if let Some(value) = prompt.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_token_usage(value: &Value, label: &str) -> BridgeContractResult<()> {
    let usage = as_record(value, label)?;
    assert_required_one_of(
        usage,
        "tokenCountSource",
        &[
            "provider_reported",
            "estimated",
            "deterministic_counter",
            "unknown",
        ],
        &format!("{label}.tokenCountSource"),
    )?;
    for key in [
        "promptTokens",
        "completionTokens",
        "reasoningTokens",
        "cachedInputTokens",
        "totalTokens",
    ] {
        if let Some(value) = usage.get(key) {
            non_negative_integer_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_cost_amount(value: &Value, label: &str) -> BridgeContractResult<Option<u64>> {
    let cost = as_record(value, label)?;
    let cost_kind = assert_required_one_of(
        cost,
        "costKind",
        &[
            "billed",
            "provider_estimate",
            "local_estimate",
            "zero",
            "unknown",
        ],
        &format!("{label}.costKind"),
    )?;
    assert_literal(cost, "currency", "USD", &format!("{label}.currency"))?;
    if let Some(pricing_snapshot_id) = cost.get("pricingSnapshotId") {
        string_value(pricing_snapshot_id, &format!("{label}.pricingSnapshotId"))?;
    }
    if cost_kind == "unknown" {
        return Ok(None);
    }
    let amount = match cost.get("amountMicrosUsd") {
        Some(value) => non_negative_integer_value(value, &format!("{label}.amountMicrosUsd"))?,
        None => 0,
    };
    Ok(Some(amount))
}

fn validate_benchmark_cost_ledger(
    value: &Value,
    system_ids: &HashSet<String>,
    report_total_micros_usd: u64,
    cost_totals_by_system: &HashMap<String, u64>,
    includes_unknown_cost: bool,
) -> BridgeContractResult<()> {
    let ledger = as_record(value, "BenchmarkReportV02.costLedger")?;
    assert_literal(
        ledger,
        "currency",
        "USD",
        "BenchmarkReportV02.costLedger.currency",
    )?;
    let report_total = assert_required_non_negative_integer(
        ledger,
        "reportTotalMicrosUsd",
        "BenchmarkReportV02.costLedger.reportTotalMicrosUsd",
    )?;
    if report_total != report_total_micros_usd {
        return error(
            "BenchmarkReportV02.costLedger.reportTotalMicrosUsd must equal providerModelCostRecords cost sum",
        );
    }
    let totals = required_array(
        ledger,
        "totalsBySystem",
        "BenchmarkReportV02.costLedger.totalsBySystem",
    )?;
    let mut seen_systems = HashSet::new();
    for (index, total) in totals.iter().enumerate() {
        let label = format!("BenchmarkReportV02.costLedger.totalsBySystem[{index}]");
        let total = as_record(total, &label)?;
        let system_id = assert_required_string(total, "systemId", &format!("{label}.systemId"))?;
        assert_known_string(
            system_id,
            &format!("{label}.systemId"),
            "system",
            system_ids,
        )?;
        if !seen_systems.insert(system_id.to_string()) {
            return error(format!(
                "{label}.systemId must be unique within totalsBySystem"
            ));
        }
        let total_value = assert_required_non_negative_integer(
            total,
            "totalMicrosUsd",
            &format!("{label}.totalMicrosUsd"),
        )?;
        if total_value != *cost_totals_by_system.get(system_id).unwrap_or(&0) {
            return error(format!(
                "{label}.totalMicrosUsd must equal providerModelCostRecords cost sum for system"
            ));
        }
    }
    let includes_unknown = assert_required_bool(
        ledger,
        "includesUnknownCost",
        "BenchmarkReportV02.costLedger.includesUnknownCost",
    )?;
    if includes_unknown != includes_unknown_cost {
        return error(
            "BenchmarkReportV02.costLedger.includesUnknownCost must match unknown provider costs",
        );
    }
    Ok(())
}

fn validate_seeded_defect(
    seed: &Map<String, Value>,
    label: &str,
    input_ref_ids: &HashSet<String>,
) -> BridgeContractResult<String> {
    let seeded_defect_id =
        assert_required_string(seed, "seededDefectId", &format!("{label}.seededDefectId"))?;
    let ref_id = assert_required_string(
        seed,
        "fixtureOrCorpusRefId",
        &format!("{label}.fixtureOrCorpusRefId"),
    )?;
    assert_known_string(
        ref_id,
        &format!("{label}.fixtureOrCorpusRefId"),
        "fixtureOrCorpusRef",
        input_ref_ids,
    )?;
    assert_required_string(seed, "seedKind", &format!("{label}.seedKind"))?;
    assert_required_string(seed, "targetLocale", &format!("{label}.targetLocale"))?;
    validate_triage_subject_refs(
        required(seed, "affectedRefs", &format!("{label}.affectedRefs"))?,
        &format!("{label}.affectedRefs"),
    )?;
    assert_required_one_of(
        seed,
        "category",
        LOCALIZATION_QUALITY_CATEGORIES,
        &format!("{label}.category"),
    )?;
    if let Some(subcategory) = seed.get("qualitySubcategory") {
        string_value(subcategory, &format!("{label}.qualitySubcategory"))?;
    }
    assert_required_one_of(
        seed,
        "qualitySeverity",
        LOCALIZATION_QUALITY_SEVERITIES,
        &format!("{label}.qualitySeverity"),
    )?;
    assert_required_one_of(
        seed,
        "expectedRootCause",
        LOCALIZATION_ROOT_CAUSES,
        &format!("{label}.expectedRootCause"),
    )?;
    assert_string_enum_array(
        required(
            seed,
            "expectedDetectorKinds",
            &format!("{label}.expectedDetectorKinds"),
        )?,
        QUALITY_DETECTOR_KINDS,
        &format!("{label}.expectedDetectorKinds"),
    )?;
    assert_uuid7_array(
        required(
            seed,
            "matchedFindingIds",
            &format!("{label}.matchedFindingIds"),
        )?,
        &format!("{label}.matchedFindingIds"),
    )?;
    assert_required_bool(seed, "publicContent", &format!("{label}.publicContent"))?;
    Ok(seeded_defect_id.to_string())
}

fn validate_benchmark_finding_record(
    finding: &Map<String, Value>,
    label: &str,
    system_ids: &HashSet<String>,
    seeded_defect_ids: &HashSet<String>,
) -> BridgeContractResult<String> {
    let finding_id = assert_required_uuid7(finding, "findingId", &format!("{label}.findingId"))?;
    let system_id = assert_required_string(finding, "systemId", &format!("{label}.systemId"))?;
    assert_known_string(
        system_id,
        &format!("{label}.systemId"),
        "system",
        system_ids,
    )?;
    assert_literal(
        finding,
        "taxonomyId",
        "itotori-lqa-1",
        &format!("{label}.taxonomyId"),
    )?;
    assert_literal(
        finding,
        "taxonomyVersion",
        "itotori-quality-taxonomy-0.1.0",
        &format!("{label}.taxonomyVersion"),
    )?;
    assert_required_one_of(
        finding,
        "detectorKind",
        QUALITY_DETECTOR_KINDS,
        &format!("{label}.detectorKind"),
    )?;
    assert_required_one_of(
        finding,
        "category",
        LOCALIZATION_QUALITY_CATEGORIES,
        &format!("{label}.category"),
    )?;
    if let Some(subcategory) = finding.get("qualitySubcategory") {
        string_value(subcategory, &format!("{label}.qualitySubcategory"))?;
    }
    assert_required_one_of(
        finding,
        "qualitySeverity",
        LOCALIZATION_QUALITY_SEVERITIES,
        &format!("{label}.qualitySeverity"),
    )?;
    let root_cause = assert_required_one_of(
        finding,
        "rootCause",
        LOCALIZATION_ROOT_CAUSES,
        &format!("{label}.rootCause"),
    )?;
    let adjudication_state = assert_required_one_of(
        finding,
        "adjudicationState",
        LOCALIZATION_ADJUDICATION_STATES,
        &format!("{label}.adjudicationState"),
    )?;
    validate_triage_subject_refs(
        required(finding, "affectedRefs", &format!("{label}.affectedRefs"))?,
        &format!("{label}.affectedRefs"),
    )?;
    validate_evidence_array(
        required(finding, "evidence", &format!("{label}.evidence"))?,
        &format!("{label}.evidence"),
    )?;
    validate_provenance_array(
        required(finding, "provenance", &format!("{label}.provenance"))?,
        &format!("{label}.provenance"),
    )?;
    validate_benchmark_finding_evidence_provenance(finding, label)?;
    if let Some(seeded_defect_id) = finding.get("seededDefectId") {
        let seeded_defect_id = string_value(seeded_defect_id, &format!("{label}.seededDefectId"))?;
        if !seeded_defect_ids.contains(seeded_defect_id) {
            return error(format!(
                "{label}.seededDefectId must reference seededDefectOracle"
            ));
        }
    }
    if let Some(rationale) = finding.get("reviewerRationale") {
        string_value(rationale, &format!("{label}.reviewerRationale"))?;
    }
    if root_cause == "unknown_unadjudicated"
        && adjudication_state != "unreviewed"
        && adjudication_state != "needs_more_context"
    {
        return error(format!(
            "{label}.rootCause cannot be unknown_unadjudicated after adjudication"
        ));
    }
    Ok(finding_id.to_string())
}

fn validate_benchmark_finding_evidence_provenance(
    finding: &Map<String, Value>,
    label: &str,
) -> BridgeContractResult<()> {
    let provenance = required_array(finding, "provenance", &format!("{label}.provenance"))?;
    let mut provenance_ids = HashSet::new();
    for record in provenance {
        provenance_ids.insert(
            string_field(as_record(record, "benchmark provenance")?, "provenanceId")?.to_string(),
        );
    }
    let evidence = required_array(finding, "evidence", &format!("{label}.evidence"))?;
    for (evidence_index, evidence_record) in evidence.iter().enumerate() {
        let evidence_label = format!("{label}.evidence[{evidence_index}]");
        let evidence_record = as_record(evidence_record, &evidence_label)?;
        let ids = required_array(
            evidence_record,
            "provenanceIds",
            &format!("{evidence_label}.provenanceIds"),
        )?;
        if ids.is_empty() {
            return error(format!(
                "{evidence_label}.provenanceIds must contain at least one provenance id"
            ));
        }
        for (index, id) in ids.iter().enumerate() {
            let id = string_value(id, &format!("{evidence_label}.provenanceIds[{index}]"))?;
            if !provenance_ids.contains(id) {
                return error(format!(
                    "{evidence_label}.provenanceIds[{index}] must reference provenance on the same finding"
                ));
            }
        }
    }
    Ok(())
}

fn validate_tool_versions(report: &Map<String, Value>) -> BridgeContractResult<()> {
    let versions = required_array(report, "toolVersions", "BenchmarkReportV02.toolVersions")?;
    for (index, version) in versions.iter().enumerate() {
        let label = format!("BenchmarkReportV02.toolVersions[{index}]");
        let version = as_record(version, &label)?;
        assert_required_string(version, "name", &format!("{label}.name"))?;
        assert_required_string(version, "version", &format!("{label}.version"))?;
        if let Some(commit) = version.get("gitCommit") {
            string_value(commit, &format!("{label}.gitCommit"))?;
        }
    }
    Ok(())
}

fn validate_command_lines(report: &Map<String, Value>) -> BridgeContractResult<()> {
    let commands = required_array(report, "commandLines", "BenchmarkReportV02.commandLines")?;
    for (index, command) in commands.iter().enumerate() {
        let label = format!("BenchmarkReportV02.commandLines[{index}]");
        let command = as_record(command, &label)?;
        assert_required_string(command, "commandId", &format!("{label}.commandId"))?;
        let argv = required_array(command, "argv", &format!("{label}.argv"))?;
        if argv.is_empty() {
            return error(format!(
                "{label}.argv must contain at least one command token"
            ));
        }
        for (arg_index, arg) in argv.iter().enumerate() {
            string_value(arg, &format!("{label}.argv[{arg_index}]"))?;
        }
    }
    Ok(())
}

fn validate_benchmark_artifact_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let artifact = as_record(value, label)?;
    assert_required_uuid7(artifact, "artifactId", &format!("{label}.artifactId"))?;
    assert_required_string(artifact, "artifactKind", &format!("{label}.artifactKind"))?;
    assert_portable_uri(
        required(artifact, "uri", &format!("{label}.uri"))?,
        &format!("{label}.uri"),
    )?;
    if let Some(hash) = artifact.get("hash") {
        assert_hash_value(hash, &format!("{label}.hash"))?;
    }
    if let Some(media_type) = artifact.get("mediaType") {
        string_value(media_type, &format!("{label}.mediaType"))?;
    }
    Ok(())
}

fn validate_started_completed(value: &Map<String, Value>, label: &str) -> BridgeContractResult<()> {
    let started = assert_required_rfc3339(value, "startedAt", &format!("{label}.startedAt"))?;
    if let Some(completed) = value.get("completedAt") {
        let completed = assert_rfc3339_value(completed, &format!("{label}.completedAt"))?;
        if completed < started {
            return error(format!(
                "{label}.completedAt must not be before {label}.startedAt"
            ));
        }
    }
    Ok(())
}

fn assert_count_buckets_match(
    actual_values: &[String],
    value: &Value,
    allowed_buckets: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    let records = array_value(value, label)?;
    let mut actual_counts: HashMap<&str, u64> = HashMap::new();
    for value in actual_values {
        *actual_counts.entry(value.as_str()).or_default() += 1;
    }
    let mut reported_buckets = HashSet::new();
    for (index, record) in records.iter().enumerate() {
        let bucket_label = format!("{label}[{index}]");
        let record = as_record(record, &bucket_label)?;
        let bucket = assert_required_one_of(
            record,
            "bucket",
            allowed_buckets,
            &format!("{bucket_label}.bucket"),
        )?;
        if !reported_buckets.insert(bucket.to_string()) {
            return error(format!(
                "{bucket_label}.bucket must be unique within {label}"
            ));
        }
        let count = assert_required_non_negative_integer(
            record,
            "count",
            &format!("{bucket_label}.count"),
        )?;
        let actual_count = *actual_counts.get(bucket).unwrap_or(&0);
        if count != actual_count {
            return error(format!("{label}.{bucket} count must match findingRecords"));
        }
    }
    for (bucket, count) in actual_counts {
        if count > 0 && !reported_buckets.contains(bucket) {
            return error(format!("{label} must include bucket {bucket}"));
        }
    }
    Ok(())
}

fn validate_benchmark_penalty_summary(
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

fn validate_deterministic_qa_results(
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
        validate_started_completed(result, &label)?;
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
            validate_benchmark_artifact_ref(
                artifact_ref,
                &format!("{label}.artifactRefs[{artifact_index}]"),
            )?;
        }
    }
    Ok(())
}

fn validate_qa_agent_evaluations(
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

fn validate_human_evaluations(
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
