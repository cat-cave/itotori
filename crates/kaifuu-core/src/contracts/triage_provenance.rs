use super::*;

pub(super) fn validate_provenance_record(value: &Value, label: &str) -> BridgeContractResult<()> {
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

pub(super) fn validate_triage_artifact_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
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

pub(super) fn validate_causal_links(value: &Value, label: &str) -> BridgeContractResult<()> {
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

pub(super) fn collect_provenance_ids(
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

pub(super) fn validate_causal_link_targets(
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

pub(super) fn assert_optional_known_reference(
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

pub(super) fn validate_finding_evidence_provenance(
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

pub(super) fn validate_finding_evidence_own_provenance(
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
