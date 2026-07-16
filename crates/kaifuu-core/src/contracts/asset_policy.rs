use super::*;

pub fn validate_asset_policy_bundle_v02(value: &Value) -> BridgeContractResult<()> {
    let bundle = as_record(value, "AssetPolicyBundleV02")?;
    assert_schema_version(bundle, "AssetPolicyBundleV02")?;
    assert_required_uuid7(
        bundle,
        "assetPolicyBundleId",
        "AssetPolicyBundleV02.assetPolicyBundleId",
    )?;
    assert_required_uuid7(
        bundle,
        "sourceBridgeId",
        "AssetPolicyBundleV02.sourceBridgeId",
    )?;
    if let Some(hash) = bundle.get("sourceBundleHash") {
        assert_hash_value(hash, "AssetPolicyBundleV02.sourceBundleHash")?;
    }
    assert_required_string(bundle, "sourceLocale", "AssetPolicyBundleV02.sourceLocale")?;
    validate_locale_branch_scope(
        required(bundle, "localeBranch", "AssetPolicyBundleV02.localeBranch")?,
        "AssetPolicyBundleV02.localeBranch",
    )?;

    let assets = required_array(bundle, "assets", "AssetPolicyBundleV02.assets")?;
    let mut assets_by_id = HashMap::new();
    for (index, asset) in assets.iter().enumerate() {
        let label = format!("AssetPolicyBundleV02.assets[{index}]");
        let (asset_id, summary) = validate_bridge_asset(asset, &label)?;
        if assets_by_id.insert(asset_id, summary).is_some() {
            return error(format!(
                "{label}.assetId must be unique within AssetPolicyBundleV02.assets"
            ));
        }
    }

    let decisions = required_array(bundle, "decisions", "AssetPolicyBundleV02.decisions")?;
    if decisions.is_empty() {
        return error("AssetPolicyBundleV02.decisions must contain at least one policy decision");
    }
    let mut decision_ids = HashSet::new();
    for (index, decision) in decisions.iter().enumerate() {
        let label = format!("AssetPolicyBundleV02.decisions[{index}]");
        let decision = as_record(decision, &label)?;
        let decision_id = assert_required_uuid7(
            decision,
            "assetPolicyDecisionId",
            &format!("{label}.assetPolicyDecisionId"),
        )?;
        if !decision_ids.insert(decision_id.to_string()) {
            return error(format!(
                "{label}.assetPolicyDecisionId must be unique within AssetPolicyBundleV02.decisions"
            ));
        }
        validate_asset_policy_decision(decision, &label, &assets_by_id)?;
    }
    assert_string_array(
        required(
            bundle,
            "compatibilityNotes",
            "AssetPolicyBundleV02.compatibilityNotes",
        )?,
        "AssetPolicyBundleV02.compatibilityNotes",
    )?;
    Ok(())
}

fn validate_asset_policy_decision(
    decision: &Map<String, Value>,
    label: &str,
    assets_by_id: &HashMap<String, AssetSummary>,
) -> BridgeContractResult<()> {
    let surface_kind = assert_required_one_of(
        decision,
        "assetSurfaceKind",
        &[
            "image_text",
            "ui_art",
            "song_title",
            "font",
            "credits",
            "video",
        ],
        &format!("{label}.assetSurfaceKind"),
    )?;
    let source_asset_ref = required_record(
        decision,
        "sourceAssetRef",
        &format!("{label}.sourceAssetRef"),
    )?;
    let source_asset_id = assert_required_uuid7(
        source_asset_ref,
        "assetId",
        &format!("{label}.sourceAssetRef.assetId"),
    )?;
    if let Some(source_location) = decision.get("sourceLocation") {
        validate_source_location(source_location, &format!("{label}.sourceLocation"))?;
    }
    if let Some(source_text) = decision.get("sourceText") {
        string_value(source_text, &format!("{label}.sourceText"))?;
    }
    assert_required_hash(decision, "sourceHash", &format!("{label}.sourceHash"))?;
    validate_source_revision(
        required(
            decision,
            "sourceRevision",
            &format!("{label}.sourceRevision"),
        )?,
        &format!("{label}.sourceRevision"),
    )?;
    let policy_action = assert_required_one_of(
        decision,
        "policyAction",
        &["localize", "romanize", "do_not_translate"],
        &format!("{label}.policyAction"),
    )?;
    if let Some(target_text) = decision.get("targetText") {
        string_value(target_text, &format!("{label}.targetText"))?;
    }
    if let Some(system) = decision.get("romanizationSystem") {
        string_value(system, &format!("{label}.romanizationSystem"))?;
    }
    if let Some(preserve_form) = decision.get("preserveForm") {
        string_value(preserve_form, &format!("{label}.preserveForm"))?;
    }
    assert_required_string(decision, "policyReason", &format!("{label}.policyReason"))?;
    let text_source_kind = assert_required_one_of(
        decision,
        "textSourceKind",
        &[
            "metadata",
            "manual_transcription",
            "ocr_hint",
            "not_applicable",
        ],
        &format!("{label}.textSourceKind"),
    )?;
    let patch_mode = assert_required_one_of(
        decision,
        "patchMode",
        &[
            "metadata_only",
            "no_patch_required",
            "region_redraw_required",
            "asset_replacement_required",
            "font_substitution_required",
            "unsupported",
        ],
        &format!("{label}.patchMode"),
    )?;
    if let Some(runtime_expectation) = decision.get("runtimeExpectation") {
        validate_runtime_expectation(runtime_expectation, &format!("{label}.runtimeExpectation"))?;
    } else {
        return error(format!("{label}.runtimeExpectation must be an object"));
    }
    if let Some(review_required) = decision.get("reviewRequired")
        && review_required.as_bool().is_none()
    {
        return error(format!("{label}.reviewRequired must be a boolean"));
    }
    if let Some(refs) = decision.get("linkedBridgeUnitRefs") {
        let refs = array_value(refs, &format!("{label}.linkedBridgeUnitRefs"))?;
        for (index, unit_ref) in refs.iter().enumerate() {
            validate_runtime_bridge_unit_ref(
                unit_ref,
                &format!("{label}.linkedBridgeUnitRefs[{index}]"),
            )?;
        }
    }
    if let Some(notes) = decision.get("notes") {
        assert_string_array(notes, &format!("{label}.notes"))?;
    }

    let has_text_source = text_source_kind != "not_applicable";
    if (policy_action == "localize" || policy_action == "romanize")
        && has_text_source
        && decision.get("targetText").is_none()
    {
        return error(format!(
            "{label}.targetText is required for localized or romanized asset text"
        ));
    }
    if policy_action == "romanize" && decision.get("romanizationSystem").is_none() {
        return error(format!(
            "{label}.romanizationSystem is required for romanize asset policies"
        ));
    }
    if policy_action == "do_not_translate"
        && has_text_source
        && decision.get("preserveForm").is_none()
        && decision.get("sourceText").is_none()
    {
        return error(format!(
            "{label}.preserveForm or sourceText is required for do_not_translate"
        ));
    }
    if text_source_kind == "not_applicable" && !["ui_art", "font", "video"].contains(&surface_kind)
    {
        return error(format!(
            "{label}.textSourceKind not_applicable is only valid for textless asset policy surfaces"
        ));
    }
    if text_source_kind != "not_applicable" && decision.get("sourceText").is_none() {
        return error(format!(
            "{label}.sourceText is required when textSourceKind is text-bearing"
        ));
    }
    if text_source_kind == "ocr_hint" && !["image_text", "ui_art", "video"].contains(&surface_kind)
    {
        return error(format!(
            "{label}.textSourceKind ocr_hint is only valid for visual asset surfaces"
        ));
    }

    let runtime_expectation = required_record(
        decision,
        "runtimeExpectation",
        &format!("{label}.runtimeExpectation"),
    )?;
    if patch_mode == "metadata_only"
        && string_field(runtime_expectation, "expectationKind")? != "metadata_only"
    {
        return error(format!(
            "{label}.patchMode metadata_only requires runtimeExpectation.expectationKind metadata_only"
        ));
    }
    if (patch_mode == "unsupported" || patch_mode == "no_patch_required")
        && decision.get("patchRef").is_some()
    {
        return error(format!("{label}.patchRef must be omitted for {patch_mode}"));
    }
    if let Some(patch_ref) = decision.get("patchRef") {
        validate_asset_policy_patch_ref(patch_ref, &format!("{label}.patchRef"))?;
        let write_mode = string_field(
            as_record(patch_ref, &format!("{label}.patchRef"))?,
            "writeMode",
        )?;
        let allowed_write_modes = match patch_mode {
            "metadata_only" => Some(&["metadata"][..]),
            "region_redraw_required" => Some(&["update_region"][..]),
            "asset_replacement_required" => Some(&["replace_asset"][..]),
            "font_substitution_required" => Some(&["replace_asset", "metadata"][..]),
            _ => None,
        };
        if let Some(allowed_write_modes) = allowed_write_modes
            && !allowed_write_modes.contains(&write_mode)
        {
            return error(format!(
                "{label}.patchRef.writeMode must be {} for {patch_mode}",
                allowed_write_modes.join(" or ")
            ));
        }
    }

    let source_asset = assets_by_id.get(source_asset_id).ok_or_else(|| {
        BridgeContractValidationError::new(format!(
            "{label}.sourceAssetRef.assetId must reference an asset in asset policy assets"
        ))
    })?;
    if let Some(asset_key) = source_asset_ref.get("assetKey") {
        let asset_key = string_value(asset_key, &format!("{label}.sourceAssetRef.assetKey"))?;
        if asset_key != source_asset.asset_key {
            return error(format!(
                "{label}.sourceAssetRef.assetKey must match the referenced asset"
            ));
        }
    }
    if !asset_kinds_for_asset_policy_surface(surface_kind)
        .contains(&source_asset.asset_kind.as_str())
    {
        return error(format!(
            "{label}.assetSurfaceKind {surface_kind} is not valid for assetKind {}",
            source_asset.asset_kind
        ));
    }
    assert_revision_matches_summary(
        required(
            decision,
            "sourceRevision",
            &format!("{label}.sourceRevision"),
        )?,
        source_asset,
        &format!("{label}.sourceRevision"),
    )?;
    if let Some(patch_ref) = decision.get("patchRef") {
        let patch_ref = as_record(patch_ref, &format!("{label}.patchRef"))?;
        let patch_asset_id =
            assert_required_uuid7(patch_ref, "assetId", &format!("{label}.patchRef.assetId"))?;
        let patch_asset = assets_by_id.get(patch_asset_id).ok_or_else(|| {
            BridgeContractValidationError::new(format!(
                "{label}.patchRef.assetId must reference an asset in asset policy assets"
            ))
        })?;
        assert_revision_matches_summary(
            required(
                patch_ref,
                "sourceRevision",
                &format!("{label}.patchRef.sourceRevision"),
            )?,
            patch_asset,
            &format!("{label}.patchRef.sourceRevision"),
        )?;
        let allowed_kinds = asset_kinds_for_asset_policy_patch(surface_kind, patch_mode);
        if !allowed_kinds.contains(&patch_asset.asset_kind.as_str()) {
            return error(format!(
                "{label}.patchRef.assetId assetKind {} is not valid for {patch_mode} on {surface_kind}",
                patch_asset.asset_kind
            ));
        }
    }
    Ok(())
}

fn validate_asset_policy_patch_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let patch_ref = as_record(value, label)?;
    assert_required_uuid7(patch_ref, "assetId", &format!("{label}.assetId"))?;
    assert_required_one_of(
        patch_ref,
        "writeMode",
        PATCH_WRITE_MODES,
        &format!("{label}.writeMode"),
    )?;
    if let Some(source_unit_key) = patch_ref.get("sourceUnitKey") {
        string_value(source_unit_key, &format!("{label}.sourceUnitKey"))?;
    }
    validate_source_revision(
        required(
            patch_ref,
            "sourceRevision",
            &format!("{label}.sourceRevision"),
        )?,
        &format!("{label}.sourceRevision"),
    )?;
    if let Some(constraints) = patch_ref.get("constraints") {
        assert_string_array(constraints, &format!("{label}.constraints"))?;
    }
    Ok(())
}

fn validate_locale_branch_scope(value: &Value, label: &str) -> BridgeContractResult<()> {
    let scope = as_record(value, label)?;
    assert_required_uuid7(scope, "localeBranchId", &format!("{label}.localeBranchId"))?;
    assert_required_string(scope, "targetLocale", &format!("{label}.targetLocale"))?;
    if let Some(locale_branch_key) = scope.get("localeBranchKey") {
        string_value(locale_branch_key, &format!("{label}.localeBranchKey"))?;
    }
    Ok(())
}

fn validate_bridge_asset(
    value: &Value,
    label: &str,
) -> BridgeContractResult<(String, AssetSummary)> {
    let asset = as_record(value, label)?;
    let asset_id = assert_required_uuid7(asset, "assetId", &format!("{label}.assetId"))?;
    let asset_key = assert_required_string(asset, "assetKey", &format!("{label}.assetKey"))?;
    let asset_kind = assert_required_one_of(
        asset,
        "assetKind",
        &[
            "script",
            "image",
            "audio",
            "video",
            "ui_texture",
            "font",
            "database",
            "metadata",
            "text",
        ],
        &format!("{label}.assetKind"),
    )?;
    let source_hash = assert_required_hash(asset, "sourceHash", &format!("{label}.sourceHash"))?;
    let source_revision = required(asset, "sourceRevision", &format!("{label}.sourceRevision"))?;
    validate_source_revision(source_revision, &format!("{label}.sourceRevision"))?;
    assert_revision_hash_matches(
        source_revision,
        source_hash,
        &format!("{label}.sourceRevision"),
    )?;
    if let Some(path) = asset.get("path") {
        string_value(path, &format!("{label}.path"))?;
    }
    let source_revision = as_record(source_revision, &format!("{label}.sourceRevision"))?;
    Ok((
        asset_id.to_string(),
        AssetSummary {
            asset_key: asset_key.to_string(),
            asset_kind: asset_kind.to_string(),
            source_revision_id: string_field(source_revision, "revisionId")?.to_string(),
            source_revision_value: string_field(source_revision, "value")?.to_string(),
        },
    ))
}

fn asset_kinds_for_asset_policy_surface(surface_kind: &str) -> &'static [&'static str] {
    match surface_kind {
        "image_text" => &["image", "ui_texture", "video"],
        "ui_art" => &["ui_texture", "image"],
        "song_title" => &["audio", "metadata"],
        "font" => &["font"],
        "credits" => &["metadata", "video"],
        "video" => &["video"],
        _ => &[],
    }
}

fn asset_kinds_for_patch_mode(patch_mode: &str) -> &'static [&'static str] {
    match patch_mode {
        "metadata_only" | "asset_replacement_required" => &[
            "script",
            "image",
            "audio",
            "video",
            "ui_texture",
            "font",
            "database",
            "metadata",
            "text",
        ],
        "region_redraw_required" => &["image", "video", "ui_texture"],
        "font_substitution_required" => &["font"],
        // "no_patch_required", "unsupported", and any other strategy require no assets.
        _ => &[],
    }
}

fn asset_kinds_for_asset_policy_patch(surface_kind: &str, patch_mode: &str) -> Vec<&'static str> {
    let surface_kinds = asset_kinds_for_asset_policy_surface(surface_kind);
    let mode_kinds = asset_kinds_for_patch_mode(patch_mode);
    surface_kinds
        .iter()
        .copied()
        .filter(|kind| mode_kinds.contains(kind))
        .collect()
}
