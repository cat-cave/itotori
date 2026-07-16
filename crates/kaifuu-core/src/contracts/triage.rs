use super::*;

pub fn validate_finding_record_fixture_v02(value: &Value) -> BridgeContractResult<()> {
    assert_no_confidence_fields(value, "FindingRecordFixtureV02")?;
    let fixture = as_record(value, "FindingRecordFixtureV02")?;
    assert_schema_version(fixture, "FindingRecordFixtureV02")?;
    assert_required_uuid7(
        fixture,
        "findingFixtureId",
        "FindingRecordFixtureV02.findingFixtureId",
    )?;
    if let Some(id) = fixture.get("sourceTriageBundleId") {
        assert_uuid7_value(id, "FindingRecordFixtureV02.sourceTriageBundleId")?;
    }
    let finding = required(fixture, "finding", "FindingRecordFixtureV02.finding")?;
    validate_finding_record(finding, "FindingRecordFixtureV02.finding")?;
    validate_finding_evidence_own_provenance(finding, "FindingRecordFixtureV02.finding")?;
    assert_string_array(
        required(
            fixture,
            "compatibilityNotes",
            "FindingRecordFixtureV02.compatibilityNotes",
        )?,
        "FindingRecordFixtureV02.compatibilityNotes",
    )?;
    Ok(())
}

pub fn validate_triage_bundle_v02(value: &Value) -> BridgeContractResult<()> {
    assert_no_confidence_fields(value, "TriageBundleV02")?;
    let bundle = as_record(value, "TriageBundleV02")?;
    assert_schema_version(bundle, "TriageBundleV02")?;
    assert_required_uuid7(bundle, "triageBundleId", "TriageBundleV02.triageBundleId")?;
    for (key, label) in [
        ("projectId", "TriageBundleV02.projectId"),
        ("sourceBridgeId", "TriageBundleV02.sourceBridgeId"),
        ("localeBranchId", "TriageBundleV02.localeBranchId"),
    ] {
        if let Some(value) = bundle.get(key) {
            assert_uuid7_value(value, label)?;
        }
    }

    let events = required_array(bundle, "events", "TriageBundleV02.events")?;
    let tasks = required_array(bundle, "tasks", "TriageBundleV02.tasks")?;
    let findings = required_array(bundle, "findings", "TriageBundleV02.findings")?;
    let mut event_ids = HashSet::new();
    let mut task_ids = HashSet::new();
    let mut finding_ids = HashSet::new();
    let mut provenance_ids = HashSet::new();

    for (index, event) in events.iter().enumerate() {
        let label = format!("TriageBundleV02.events[{index}]");
        let id = validate_triage_event(event, &label, &event_ids)?;
        if !event_ids.insert(id) {
            return error(format!(
                "{label}.eventId must be unique within TriageBundleV02.events"
            ));
        }
        collect_provenance_ids(event, &mut provenance_ids)?;
    }
    for (index, task) in tasks.iter().enumerate() {
        let label = format!("TriageBundleV02.tasks[{index}]");
        let id = validate_triage_task(task, &label)?;
        if !task_ids.insert(id) {
            return error(format!(
                "{label}.taskId must be unique within TriageBundleV02.tasks"
            ));
        }
        collect_provenance_ids(task, &mut provenance_ids)?;
    }
    for (index, finding) in findings.iter().enumerate() {
        let label = format!("TriageBundleV02.findings[{index}]");
        let id = validate_finding_record(finding, &label)?;
        if !finding_ids.insert(id) {
            return error(format!(
                "{label}.findingId must be unique within TriageBundleV02.findings"
            ));
        }
        collect_provenance_ids(finding, &mut provenance_ids)?;
    }

    for (index, event) in events.iter().enumerate() {
        let label = format!("TriageBundleV02.events[{index}]");
        let event = as_record(event, &label)?;
        assert_optional_known_reference(
            event.get("taskId"),
            &format!("{label}.taskId"),
            "task",
            &task_ids,
        )?;
        assert_optional_known_reference(
            event.get("findingId"),
            &format!("{label}.findingId"),
            "finding",
            &finding_ids,
        )?;
        validate_causal_link_targets(
            event,
            &format!("{label}.causalLinks"),
            &event_ids,
            &task_ids,
            &finding_ids,
        )?;
    }
    for (index, task) in tasks.iter().enumerate() {
        let label = format!("TriageBundleV02.tasks[{index}]");
        let task = as_record(task, &label)?;
        assert_optional_known_reference(
            task.get("createdByEventId"),
            &format!("{label}.createdByEventId"),
            "event",
            &event_ids,
        )?;
        validate_causal_link_targets(
            task,
            &format!("{label}.causalLinks"),
            &event_ids,
            &task_ids,
            &finding_ids,
        )?;
    }
    for (index, finding) in findings.iter().enumerate() {
        let label = format!("TriageBundleV02.findings[{index}]");
        let finding_record = as_record(finding, &label)?;
        assert_optional_known_reference(
            finding_record.get("reportedByTaskId"),
            &format!("{label}.reportedByTaskId"),
            "task",
            &task_ids,
        )?;
        assert_optional_known_reference(
            finding_record.get("firstSeenEventId"),
            &format!("{label}.firstSeenEventId"),
            "event",
            &event_ids,
        )?;
        validate_causal_link_targets(
            finding_record,
            &format!("{label}.causalLinks"),
            &event_ids,
            &task_ids,
            &finding_ids,
        )?;
        validate_finding_evidence_provenance(finding, &label, &provenance_ids)?;
    }
    Ok(())
}

fn validate_triage_event(
    value: &Value,
    label: &str,
    prior_event_ids: &HashSet<String>,
) -> BridgeContractResult<String> {
    assert_no_mutable_event_bucket_fields(value, label)?;
    let event = as_record(value, label)?;
    let event_id = assert_required_uuid7(event, "eventId", &format!("{label}.eventId"))?;
    assert_required_one_of(
        event,
        "eventKind",
        &[
            "task_requested",
            "task_started",
            "model_output_recorded",
            "qa_finding_reported",
            "patch_result_recorded",
            "finding_superseded",
        ],
        &format!("{label}.eventKind"),
    )?;
    assert_required_rfc3339(event, "occurredAt", &format!("{label}.occurredAt"))?;
    validate_triage_actor(
        required(event, "actor", &format!("{label}.actor"))?,
        &format!("{label}.actor"),
    )?;
    for key in ["taskId", "findingId"] {
        if let Some(value) = event.get(key) {
            assert_uuid7_value(value, &format!("{label}.{key}"))?;
        }
    }
    validate_triage_subject_refs(
        required(event, "subjectRefs", &format!("{label}.subjectRefs"))?,
        &format!("{label}.subjectRefs"),
    )?;
    validate_provenance_array(
        required(event, "provenance", &format!("{label}.provenance"))?,
        &format!("{label}.provenance"),
    )?;
    validate_causal_links(
        required(event, "causalLinks", &format!("{label}.causalLinks"))?,
        &format!("{label}.causalLinks"),
    )?;
    let causal_links = array_value(
        required(event, "causalLinks", &format!("{label}.causalLinks"))?,
        &format!("{label}.causalLinks"),
    )?;
    for (index, link) in causal_links.iter().enumerate() {
        let link = as_record(link, &format!("{label}.causalLinks[{index}]"))?;
        if string_field(link, "targetKind")? == "event" {
            let target_id = string_field(link, "targetId")?;
            if !prior_event_ids.contains(target_id) {
                return error(format!(
                    "{label}.causalLinks[{index}].targetId must reference a prior event"
                ));
            }
        }
    }
    if let Some(payload) = event.get("payload") {
        as_record(payload, &format!("{label}.payload"))?;
    }
    Ok(event_id.to_string())
}

fn validate_triage_task(value: &Value, label: &str) -> BridgeContractResult<String> {
    let task = as_record(value, label)?;
    let task_id = assert_required_uuid7(task, "taskId", &format!("{label}.taskId"))?;
    assert_required_one_of(
        task,
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
    assert_required_rfc3339(task, "createdAt", &format!("{label}.createdAt"))?;
    assert_required_string(task, "summary", &format!("{label}.summary"))?;
    if let Some(created_by_event_id) = task.get("createdByEventId") {
        assert_uuid7_value(created_by_event_id, &format!("{label}.createdByEventId"))?;
    }
    validate_triage_subject_refs(
        required(task, "inputRefs", &format!("{label}.inputRefs"))?,
        &format!("{label}.inputRefs"),
    )?;
    validate_provenance_array(
        required(task, "provenance", &format!("{label}.provenance"))?,
        &format!("{label}.provenance"),
    )?;
    validate_causal_links(
        required(task, "causalLinks", &format!("{label}.causalLinks"))?,
        &format!("{label}.causalLinks"),
    )?;
    Ok(task_id.to_string())
}

fn validate_finding_record(value: &Value, label: &str) -> BridgeContractResult<String> {
    let finding = as_record(value, label)?;
    let finding_id = assert_required_uuid7(finding, "findingId", &format!("{label}.findingId"))?;
    assert_required_one_of(
        finding,
        "findingKind",
        &[
            "source_annotation_issue",
            "style_guide_violation",
            "model_output_issue",
            "patching_issue",
            "runtime_issue",
            "policy_issue",
            "protected_span_issue",
        ],
        &format!("{label}.findingKind"),
    )?;
    assert_required_one_of(
        finding,
        "severity",
        TRIAGE_SEVERITIES,
        &format!("{label}.severity"),
    )?;
    if let Some(category) = finding.get("qualityCategory") {
        let category = string_value(category, &format!("{label}.qualityCategory"))?;
        assert_one_of(
            category,
            LOCALIZATION_QUALITY_CATEGORIES,
            &format!("{label}.qualityCategory"),
        )?;
    }
    for key in ["title", "description", "impact"] {
        assert_required_string(finding, key, &format!("{label}.{key}"))?;
    }
    assert_required_rfc3339(finding, "createdAt", &format!("{label}.createdAt"))?;
    for key in ["reportedByTaskId", "firstSeenEventId"] {
        if let Some(value) = finding.get(key) {
            assert_uuid7_value(value, &format!("{label}.{key}"))?;
        }
    }
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
    validate_causal_links(
        required(finding, "causalLinks", &format!("{label}.causalLinks"))?,
        &format!("{label}.causalLinks"),
    )?;
    Ok(finding_id.to_string())
}

fn validate_triage_actor(value: &Value, label: &str) -> BridgeContractResult<()> {
    let actor = as_record(value, label)?;
    assert_required_one_of(
        actor,
        "actorKind",
        &["human", "agent", "tool", "system"],
        &format!("{label}.actorKind"),
    )?;
    if let Some(actor_id) = actor.get("actorId") {
        assert_uuid7_value(actor_id, &format!("{label}.actorId"))?;
    }
    if let Some(display_name) = actor.get("displayName") {
        string_value(display_name, &format!("{label}.displayName"))?;
    }
    Ok(())
}

pub(super) fn validate_evidence_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let evidence = array_value(value, label)?;
    if evidence.is_empty() {
        return error(format!("{label} must contain at least one evidence record"));
    }
    for (index, record) in evidence.iter().enumerate() {
        validate_evidence_record(record, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn validate_evidence_record(value: &Value, label: &str) -> BridgeContractResult<()> {
    let evidence = as_record(value, label)?;
    assert_required_uuid7(evidence, "evidenceId", &format!("{label}.evidenceId"))?;
    assert_required_one_of(
        evidence,
        "evidenceKind",
        &[
            "text_excerpt",
            "json_pointer",
            "artifact",
            "trace",
            "screenshot_region",
            "diff",
            "validator_message",
        ],
        &format!("{label}.evidenceKind"),
    )?;
    assert_required_string(evidence, "summary", &format!("{label}.summary"))?;
    if let Some(subject_ref) = evidence.get("subjectRef") {
        validate_triage_subject_refs(
            &Value::Array(vec![subject_ref.clone()]),
            &format!("{label}.subjectRef"),
        )?;
    }
    if let Some(artifact_ref) = evidence.get("artifactRef") {
        validate_triage_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
    }
    if let Some(source_location) = evidence.get("sourceLocation") {
        validate_source_location(source_location, &format!("{label}.sourceLocation"))?;
    }
    for key in ["expectedValue", "observedValue"] {
        if let Some(value) = evidence.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    assert_uuid7_array(
        required(evidence, "provenanceIds", &format!("{label}.provenanceIds"))?,
        &format!("{label}.provenanceIds"),
    )?;
    Ok(())
}

pub(super) fn validate_provenance_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let provenance = array_value(value, label)?;
    if provenance.is_empty() {
        return error(format!(
            "{label} must contain at least one provenance record"
        ));
    }
    for (index, record) in provenance.iter().enumerate() {
        validate_provenance_record(record, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn validate_provenance_record(value: &Value, label: &str) -> BridgeContractResult<()> {
    let provenance = as_record(value, label)?;
    assert_required_uuid7(provenance, "provenanceId", &format!("{label}.provenanceId"))?;
    let kind = assert_required_one_of(
        provenance,
        "provenanceKind",
        &[
            "source_annotation",
            "style_guide",
            "model_output",
            "patching_cause",
            "runtime_evidence",
            "human_review",
            "deterministic_check",
        ],
        &format!("{label}.provenanceKind"),
    )?;
    match kind {
        "source_annotation" => {
            assert_required_uuid7(provenance, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
            if let Some(span_id) = provenance.get("spanId") {
                assert_uuid7_value(span_id, &format!("{label}.spanId"))?;
            }
            if let Some(source_asset_ref) = provenance.get("sourceAssetRef") {
                validate_asset_ref(source_asset_ref, &format!("{label}.sourceAssetRef"))?;
            }
            if let Some(source_location) = provenance.get("sourceLocation") {
                validate_source_location(source_location, &format!("{label}.sourceLocation"))?;
            }
            if let Some(annotation_text) = provenance.get("annotationText") {
                string_value(annotation_text, &format!("{label}.annotationText"))?;
            }
            if let Some(observed_at) = provenance.get("observedAt") {
                assert_rfc3339_value(observed_at, &format!("{label}.observedAt"))?;
            }
        }
        "style_guide" => {
            assert_required_uuid7(provenance, "styleGuideId", &format!("{label}.styleGuideId"))?;
            assert_required_uuid7(
                provenance,
                "styleGuideVersionId",
                &format!("{label}.styleGuideVersionId"),
            )?;
            assert_required_string(provenance, "ruleId", &format!("{label}.ruleId"))?;
            for key in ["rulePath", "excerptHash"] {
                if let Some(value) = provenance.get(key) {
                    string_value(value, &format!("{label}.{key}"))?;
                }
            }
        }
        "model_output" => {
            assert_required_uuid7(
                provenance,
                "modelOutputId",
                &format!("{label}.modelOutputId"),
            )?;
            if let Some(task_id) = provenance.get("taskId") {
                assert_uuid7_value(task_id, &format!("{label}.taskId"))?;
            }
            for key in ["provider", "model", "outputHash"] {
                assert_required_string(provenance, key, &format!("{label}.{key}"))?;
            }
            if let Some(prompt_hash) = provenance.get("promptHash") {
                string_value(prompt_hash, &format!("{label}.promptHash"))?;
            }
            if let Some(artifact_ref) = provenance.get("artifactRef") {
                validate_triage_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
            }
        }
        "patching_cause" => {
            for key in ["patchResultId", "patchExportId", "bridgeUnitId"] {
                if let Some(value) = provenance.get(key) {
                    assert_uuid7_value(value, &format!("{label}.{key}"))?;
                }
            }
            if let Some(asset_ref) = provenance.get("assetRef") {
                validate_asset_ref(asset_ref, &format!("{label}.assetRef"))?;
            }
            if let Some(write_mode) = provenance.get("writeMode") {
                let write_mode = string_value(write_mode, &format!("{label}.writeMode"))?;
                assert_one_of(write_mode, PATCH_WRITE_MODES, &format!("{label}.writeMode"))?;
            }
            for key in ["failureCode", "failureDetail"] {
                if let Some(value) = provenance.get(key) {
                    string_value(value, &format!("{label}.{key}"))?;
                }
            }
            if provenance.get("patchResultId").is_none()
                && provenance.get("patchExportId").is_none()
            {
                return error(format!(
                    "{label} must include patchResultId or patchExportId"
                ));
            }
        }
        "runtime_evidence" => {
            assert_required_uuid7(
                provenance,
                "runtimeReportId",
                &format!("{label}.runtimeReportId"),
            )?;
            if let Some(bridge_unit_id) = provenance.get("bridgeUnitId") {
                assert_uuid7_value(bridge_unit_id, &format!("{label}.bridgeUnitId"))?;
            }
            if let Some(artifact_ref) = provenance.get("artifactRef") {
                validate_triage_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
            }
            if let Some(evidence_tier) = provenance.get("evidenceTier") {
                let evidence_tier = string_value(evidence_tier, &format!("{label}.evidenceTier"))?;
                assert_one_of(
                    evidence_tier,
                    RUNTIME_EVIDENCE_TIERS,
                    &format!("{label}.evidenceTier"),
                )?;
            }
        }
        "human_review" => {
            for key in ["reviewerId", "reviewSessionId"] {
                if let Some(value) = provenance.get(key) {
                    assert_uuid7_value(value, &format!("{label}.{key}"))?;
                }
            }
            assert_required_string(provenance, "noteHash", &format!("{label}.noteHash"))?;
        }
        "deterministic_check" => {
            assert_required_uuid7(provenance, "checkId", &format!("{label}.checkId"))?;
            assert_required_string(provenance, "checkName", &format!("{label}.checkName"))?;
            assert_required_string(provenance, "checkVersion", &format!("{label}.checkVersion"))?;
            if let Some(artifact_ref) = provenance.get("artifactRef") {
                validate_triage_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn validate_triage_artifact_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let artifact = as_record(value, label)?;
    assert_required_uuid7(artifact, "artifactId", &format!("{label}.artifactId"))?;
    assert_required_string(artifact, "artifactKind", &format!("{label}.artifactKind"))?;
    for key in ["uri", "hash"] {
        if let Some(value) = artifact.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_causal_links(value: &Value, label: &str) -> BridgeContractResult<()> {
    let links = array_value(value, label)?;
    for (index, link) in links.iter().enumerate() {
        let link_label = format!("{label}[{index}]");
        let link = as_record(link, &link_label)?;
        assert_required_uuid7(link, "causalLinkId", &format!("{link_label}.causalLinkId"))?;
        assert_required_one_of(
            link,
            "linkKind",
            &[
                "caused_by",
                "derived_from",
                "supersedes",
                "blocks",
                "unblocks",
            ],
            &format!("{link_label}.linkKind"),
        )?;
        assert_required_one_of(
            link,
            "targetKind",
            &["event", "task", "finding"],
            &format!("{link_label}.targetKind"),
        )?;
        assert_required_uuid7(link, "targetId", &format!("{link_label}.targetId"))?;
        if let Some(rationale) = link.get("rationale") {
            string_value(rationale, &format!("{link_label}.rationale"))?;
        }
    }
    Ok(())
}

fn collect_provenance_ids(
    value: &Value,
    provenance_ids: &mut HashSet<String>,
) -> BridgeContractResult<()> {
    let object = as_record(value, "provenance owner")?;
    let Some(provenance) = object.get("provenance") else {
        return Ok(());
    };
    for record in array_value(provenance, "provenance")? {
        let record = as_record(record, "provenance record")?;
        provenance_ids.insert(string_field(record, "provenanceId")?.to_string());
    }
    Ok(())
}

fn validate_causal_link_targets(
    owner: &Map<String, Value>,
    label: &str,
    event_ids: &HashSet<String>,
    task_ids: &HashSet<String>,
    finding_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let links = required_array(owner, "causalLinks", label)?;
    for (index, link) in links.iter().enumerate() {
        let link = as_record(link, &format!("{label}[{index}]"))?;
        let target_kind = string_field(link, "targetKind")?;
        let target_id = string_field(link, "targetId")?;
        let known = match target_kind {
            "event" => event_ids.contains(target_id),
            "task" => task_ids.contains(target_id),
            "finding" => finding_ids.contains(target_id),
            _ => false,
        };
        if !known {
            return error(format!(
                "{label}[{index}].targetId must reference an existing triage {target_kind}"
            ));
        }
    }
    Ok(())
}

fn assert_optional_known_reference(
    value: Option<&Value>,
    label: &str,
    target_kind: &str,
    known_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    if let Some(value) = value {
        let id = string_value(value, label)?;
        assert_uuid7(id, label)?;
        if !known_ids.contains(id) {
            return error(format!(
                "{label} must reference an existing triage {target_kind}"
            ));
        }
    }
    Ok(())
}

fn validate_finding_evidence_provenance(
    finding: &Value,
    label: &str,
    all_provenance_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let finding_record = as_record(finding, label)?;
    let finding_provenance =
        required_array(finding_record, "provenance", &format!("{label}.provenance"))?;
    let mut own_provenance_ids = HashSet::new();
    for provenance in finding_provenance {
        own_provenance_ids.insert(
            string_field(as_record(provenance, "finding provenance")?, "provenanceId")?.to_string(),
        );
    }
    let evidence = required_array(finding_record, "evidence", &format!("{label}.evidence"))?;
    for (evidence_index, evidence_record) in evidence.iter().enumerate() {
        let evidence_label = format!("{label}.evidence[{evidence_index}]");
        let evidence_record = as_record(evidence_record, &evidence_label)?;
        let provenance_ids = required_array(
            evidence_record,
            "provenanceIds",
            &format!("{evidence_label}.provenanceIds"),
        )?;
        if provenance_ids.is_empty() {
            return error(format!(
                "{evidence_label}.provenanceIds must contain at least one provenance id"
            ));
        }
        for (provenance_index, provenance_id) in provenance_ids.iter().enumerate() {
            let provenance_label = format!("{evidence_label}.provenanceIds[{provenance_index}]");
            let provenance_id = string_value(provenance_id, &provenance_label)?;
            if !all_provenance_ids.contains(provenance_id) {
                return error(format!(
                    "{provenance_label} must reference provenance in TriageBundleV02"
                ));
            }
            if !own_provenance_ids.contains(provenance_id) {
                return error(format!(
                    "{provenance_label} must reference provenance on the same finding"
                ));
            }
        }
    }
    Ok(())
}

fn validate_finding_evidence_own_provenance(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let finding = as_record(value, label)?;
    let provenance = required_array(finding, "provenance", &format!("{label}.provenance"))?;
    let mut provenance_ids = HashSet::new();
    for record in provenance {
        provenance_ids.insert(
            string_field(as_record(record, "finding provenance")?, "provenanceId")?.to_string(),
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
