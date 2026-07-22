use super::*;

pub(super) fn validate_benchmark_provider_run(
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
    super::benchmark_findings::validate_started_completed(run, label)?;
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

pub(super) fn validate_benchmark_cost_ledger(
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
