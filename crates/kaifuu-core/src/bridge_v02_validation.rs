use super::*;

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRecordV02 {
    pub policy_record_id: String,
    pub policy_record_kind: String,
    pub policy_action: String,
    pub term_key: String,
    pub source_text: String,
    pub target_locale: Option<String>,
    pub locale_branch_id: Option<String>,
    pub romanization_system: Option<String>,
    pub preserve_form: Option<String>,
    pub scope: Option<String>,
    pub policy_reason: String,
    pub review_required: Option<bool>,
}

impl fmt::Debug for PolicyRecordV02 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PolicyRecordV02")
            .field("policy_record_id", &self.policy_record_id)
            .field("policy_record_kind", &self.policy_record_kind)
            .field("policy_action", &self.policy_action)
            .field(
                "term_key",
                &RedactedContentSummary::from_text(&self.term_key),
            )
            .field(
                "source_text",
                &RedactedContentSummary::from_text(&self.source_text),
            )
            .field(
                "target_locale",
                &self
                    .target_locale
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("locale_branch_id", &self.locale_branch_id)
            .field(
                "romanization_system",
                &self
                    .romanization_system
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "preserve_form",
                &self
                    .preserve_form
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "scope",
                &self.scope.as_deref().map(RedactedContentSummary::from_text),
            )
            .field(
                "policy_reason",
                &RedactedContentSummary::from_text(&self.policy_reason),
            )
            .field("review_required", &self.review_required)
            .finish()
    }
}

impl PolicyRecordV02 {
    pub(crate) fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.policy_record_id, &format!("{label}.policyRecordId"))?;
        assert_one_of(
            &self.policy_record_kind,
            &["romanized_term", "non_translated_term"],
            &format!("{label}.policyRecordKind"),
        )?;
        assert_one_of(
            &self.policy_action,
            &["localize", "romanize", "do_not_translate"],
            &format!("{label}.policyAction"),
        )?;
        assert_non_empty(&self.term_key, &format!("{label}.termKey"))?;
        assert_non_empty(&self.source_text, &format!("{label}.sourceText"))?;
        if let Some(target_locale) = &self.target_locale {
            assert_non_empty(target_locale, &format!("{label}.targetLocale"))?;
        }
        if let Some(locale_branch_id) = &self.locale_branch_id {
            assert_uuid7(locale_branch_id, &format!("{label}.localeBranchId"))?;
        }
        if self.target_locale.is_none() && self.locale_branch_id.is_none() {
            return Err(BridgeContractValidationError::new(format!(
                "{label} must include targetLocale or localeBranchId"
            )));
        }
        if let Some(scope) = &self.scope {
            assert_surface_kind(scope, &format!("{label}.scope"))?;
        }
        if let Some(romanization_system) = &self.romanization_system {
            assert_non_empty(romanization_system, &format!("{label}.romanizationSystem"))?;
        }
        if let Some(preserve_form) = &self.preserve_form {
            assert_non_empty(preserve_form, &format!("{label}.preserveForm"))?;
        }
        assert_non_empty(&self.policy_reason, &format!("{label}.policyReason"))?;
        Ok(())
    }
}

pub(crate) fn assert_source_location_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let location = as_record(value, label)?;
    assert_optional_value_string(
        location.get("containerKey"),
        &format!("{label}.containerKey"),
    )?;
    if let Some(entry_path) = location.get("entryPath") {
        assert_value_string_array(entry_path, &format!("{label}.entryPath"))?;
    }
    if let Some(range) = location.get("range") {
        assert_byte_range_v02(range, &format!("{label}.range"))?;
    }
    if let Some(region) = location.get("region") {
        assert_pixel_region_v02(region, &format!("{label}.region"))?;
    }
    Ok(())
}

pub(crate) fn assert_surface_context_v02(
    value: &Value,
    label: &str,
    surface_kind: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let context = as_record(value, label)?;
    if let Some(route) = context.get("route") {
        assert_route_context_v02(route, &format!("{label}.route"))?;
    }
    if let Some(choice) = context.get("choice") {
        assert_choice_context_v02(choice, &format!("{label}.choice"))?;
    }
    if let Some(ui) = context.get("ui") {
        assert_ui_context_v02(ui, &format!("{label}.ui"))?;
    }
    if let Some(tutorial) = context.get("tutorial") {
        assert_tutorial_context_v02(tutorial, &format!("{label}.tutorial"))?;
    }
    if let Some(database) = context.get("database") {
        assert_database_context_v02(database, &format!("{label}.database"))?;
    }
    if let Some(song) = context.get("song") {
        assert_song_context_v02(song, &format!("{label}.song"), asset_ids)?;
    }
    if let Some(image_text) = context.get("imageText") {
        assert_image_text_context_v02(image_text, &format!("{label}.imageText"))?;
    }
    if let Some(metadata) = context.get("metadata") {
        assert_metadata_context_v02(metadata, &format!("{label}.metadata"))?;
    }
    if let Some(speaker_name) = context.get("speakerName") {
        assert_speaker_name_context_v02(speaker_name, &format!("{label}.speakerName"))?;
    }

    if let Some(required_context) = required_context_for_surface_kind(surface_kind)
        && !context.contains_key(required_context)
    {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.{required_context} is required for {surface_kind}"
        )));
    }
    Ok(())
}

pub(crate) fn required_context_for_surface_kind(surface_kind: &str) -> Option<&'static str> {
    match surface_kind {
        "choice_label" => Some("choice"),
        "ui_label" => Some("ui"),
        "tutorial_text" => Some("tutorial"),
        "database_entry" => Some("database"),
        "song_title" => Some("song"),
        "image_text" => Some("imageText"),
        "metadata_text" => Some("metadata"),
        "speaker_name" => Some("speakerName"),
        _ => None,
    }
}

pub(crate) fn assert_route_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let route = as_record(value, label)?;
    assert_optional_value_uuid7(route.get("routeId"), &format!("{label}.routeId"))?;
    assert_optional_value_string(route.get("routeKey"), &format!("{label}.routeKey"))?;
    assert_optional_value_uuid7(route.get("sceneId"), &format!("{label}.sceneId"))?;
    assert_optional_value_string(route.get("sceneKey"), &format!("{label}.sceneKey"))?;
    assert_optional_value_uuid7(route.get("branchId"), &format!("{label}.branchId"))?;
    assert_optional_value_string(route.get("branchKey"), &format!("{label}.branchKey"))?;
    assert_optional_value_string(route.get("position"), &format!("{label}.position"))
}

pub(crate) fn assert_choice_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let choice = as_record(value, label)?;
    assert_required_value_uuid7(
        choice.get("choiceGroupId"),
        &format!("{label}.choiceGroupId"),
    )?;
    assert_required_value_uuid7(choice.get("choiceId"), &format!("{label}.choiceId"))?;
    assert_non_negative_integer_value(choice.get("optionIndex"), &format!("{label}.optionIndex"))?;
    assert_optional_value_string(
        choice.get("routeTargetRef"),
        &format!("{label}.routeTargetRef"),
    )
}

pub(crate) fn assert_ui_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let ui = as_record(value, label)?;
    assert_value_one_of(
        ui.get("uiArea"),
        &[
            "dialogue_window",
            "menu",
            "hud",
            "settings",
            "save_load",
            "battle",
            "status",
            "system",
        ],
        &format!("{label}.uiArea"),
    )?;
    assert_optional_value_string(ui.get("controlRef"), &format!("{label}.controlRef"))?;
    assert_optional_value_string(
        ui.get("layoutConstraint"),
        &format!("{label}.layoutConstraint"),
    )
}

pub(crate) fn assert_tutorial_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let tutorial = as_record(value, label)?;
    assert_required_value_string(
        tutorial.get("tutorialStepRef"),
        &format!("{label}.tutorialStepRef"),
    )?;
    if let Some(input_action_refs) = tutorial.get("inputActionRefs") {
        assert_value_string_array(input_action_refs, &format!("{label}.inputActionRefs"))?;
    }
    assert_optional_value_string(
        tutorial.get("platformCondition"),
        &format!("{label}.platformCondition"),
    )
}

pub(crate) fn assert_database_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let database = as_record(value, label)?;
    assert_value_one_of(
        database.get("databaseKind"),
        &[
            "item",
            "skill",
            "quest",
            "location",
            "achievement",
            "character_bio",
            "bestiary",
            "codex",
            "encyclopedia",
        ],
        &format!("{label}.databaseKind"),
    )?;
    assert_required_value_string(database.get("entryId"), &format!("{label}.entryId"))?;
    assert_required_value_string(database.get("fieldKey"), &format!("{label}.fieldKey"))?;
    assert_optional_value_string(database.get("sortKey"), &format!("{label}.sortKey"))
}

pub(crate) fn assert_song_context_v02(
    value: &Value,
    label: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let song = as_record(value, label)?;
    if let Some(audio_asset_ref) = song.get("audioAssetRef") {
        let asset_id =
            assert_asset_ref_value_v02(audio_asset_ref, &format!("{label}.audioAssetRef"))?;
        assert_known_asset_id(
            asset_id,
            &format!("{label}.audioAssetRef.assetId"),
            asset_ids,
        )?;
    }
    assert_optional_value_string(song.get("trackId"), &format!("{label}.trackId"))?;
    assert_required_value_string(song.get("titleField"), &format!("{label}.titleField"))?;
    if let Some(credit_refs) = song.get("creditRefs") {
        assert_value_string_array(credit_refs, &format!("{label}.creditRefs"))?;
    }
    Ok(())
}

pub(crate) fn assert_image_text_context_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let image_text = as_record(value, label)?;
    assert_required_pixel_region_v02(image_text.get("region"), &format!("{label}.region"))?;
    assert_optional_value_string(image_text.get("ocrText"), &format!("{label}.ocrText"))?;
    assert_required_boolean(image_text.get("editable"), &format!("{label}.editable"))?;
    assert_value_one_of(
        image_text.get("replacementMode"),
        &[
            "redraw_region",
            "overlay_text",
            "replace_asset",
            "metadata_only",
        ],
        &format!("{label}.replacementMode"),
    )
}

pub(crate) fn assert_metadata_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let metadata = as_record(value, label)?;
    assert_value_one_of(
        metadata.get("metadataScope"),
        &[
            "package",
            "platform",
            "save_data",
            "credits",
            "config",
            "achievement",
        ],
        &format!("{label}.metadataScope"),
    )?;
    assert_required_value_string(metadata.get("fieldKey"), &format!("{label}.fieldKey"))?;
    assert_value_one_of(
        metadata.get("visibility"),
        &["runtime", "package", "platform", "internal"],
        &format!("{label}.visibility"),
    )
}

pub(crate) fn assert_speaker_name_context_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let speaker_name = as_record(value, label)?;
    assert_value_one_of(
        speaker_name.get("displayContext"),
        &["name_plate", "backlog", "chat", "battle_callout"],
        &format!("{label}.displayContext"),
    )?;
    assert_optional_value_string(
        speaker_name.get("canonicalNameRef"),
        &format!("{label}.canonicalNameRef"),
    )
}

pub(crate) fn assert_localization_policy_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let policy = as_record(value, label)?;
    assert_value_one_of(
        policy.get("policyAction"),
        &["localize", "romanize", "do_not_translate"],
        &format!("{label}.policyAction"),
    )?;
    assert_optional_value_string(policy.get("targetLocale"), &format!("{label}.targetLocale"))?;
    assert_optional_value_uuid7(
        policy.get("localeBranchId"),
        &format!("{label}.localeBranchId"),
    )?;
    assert_optional_value_string(policy.get("targetText"), &format!("{label}.targetText"))?;
    assert_optional_value_string(
        policy.get("romanizationSystem"),
        &format!("{label}.romanizationSystem"),
    )?;
    assert_optional_value_string(policy.get("policyReason"), &format!("{label}.policyReason"))?;
    if policy.get("targetLocale").is_none() && policy.get("localeBranchId").is_none() {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must include targetLocale or localeBranchId"
        )));
    }
    Ok(())
}

pub(crate) fn assert_asset_ref_value_v02<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let asset_ref = as_record(value, label)?;
    let asset_id =
        assert_required_value_uuid7(asset_ref.get("assetId"), &format!("{label}.assetId"))?;
    assert_optional_value_string(asset_ref.get("assetKey"), &format!("{label}.assetKey"))?;
    Ok(asset_id)
}
