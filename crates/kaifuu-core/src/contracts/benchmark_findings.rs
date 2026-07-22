use super::*;

pub(super) fn validate_seeded_defect(
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

pub(super) fn validate_benchmark_finding_record(
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

pub(super) fn validate_tool_versions(report: &Map<String, Value>) -> BridgeContractResult<()> {
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

pub(super) fn validate_command_lines(report: &Map<String, Value>) -> BridgeContractResult<()> {
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

pub(super) fn validate_benchmark_artifact_ref(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
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

pub(super) fn validate_started_completed(
    value: &Map<String, Value>,
    label: &str,
) -> BridgeContractResult<()> {
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

pub(super) fn assert_count_buckets_match(
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
