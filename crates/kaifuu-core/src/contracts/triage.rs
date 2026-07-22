use super::*;

#[path = "triage_provenance.rs"]
mod provenance;

use provenance::{
    assert_optional_known_reference, collect_provenance_ids, validate_causal_link_targets,
    validate_causal_links, validate_finding_evidence_own_provenance,
    validate_finding_evidence_provenance, validate_provenance_record, validate_triage_artifact_ref,
};

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
