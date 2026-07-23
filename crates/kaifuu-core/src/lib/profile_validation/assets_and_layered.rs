use super::*;

pub(super) struct ValidatedAssets {
    pub(super) patching_capabilities: Vec<(String, String)>,
    pub(super) asset_ids: std::collections::BTreeSet<String>,
}

pub(super) fn validate_identifier(
    failures: &mut Vec<ProfileValidationFailure>,
    field: &str,
    value: &str,
) {
    if value.chars().any(char::is_whitespace) || value.contains('\0') {
        failures.push(ProfileValidationFailure {
            code: "invalid_identifier".to_string(),
            field: field.to_string(),
            message: format!("{field} must not contain whitespace or null bytes"),
        });
    }
}

pub(super) fn validate_assets(
    failures: &mut Vec<ProfileValidationFailure>,
    assets: Option<&Value>,
) -> ValidatedAssets {
    let mut patching_capabilities = Vec::new();
    let mut asset_ids = std::collections::BTreeSet::new();
    let Some(assets) = assets else {
        failures.push(ProfileValidationFailure {
            code: "missing_assets".to_string(),
            field: "assets".to_string(),
            message: "profile must identify at least one asset or manifest surface".to_string(),
        });
        return ValidatedAssets {
            patching_capabilities,
            asset_ids,
        };
    };
    let Some(assets) = assets.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "assets".to_string(),
            message: "assets must be an array".to_string(),
        });
        return ValidatedAssets {
            patching_capabilities,
            asset_ids,
        };
    };
    if assets.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_assets".to_string(),
            field: "assets".to_string(),
            message: "profile must identify at least one asset or manifest surface".to_string(),
        });
    }
    for (index, asset) in assets.iter().enumerate() {
        let field = format!("assets.{index}");
        if !asset.is_object() {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "asset must be a JSON object".to_string(),
            });
            continue;
        }
        let asset_id = required_string_value(failures, asset, &format!("assets.{index}.assetId"));
        if asset_id
            .as_deref()
            .is_some_and(|id| id.chars().any(char::is_whitespace) || id.contains('\0'))
        {
            failures.push(ProfileValidationFailure {
                code: "invalid_asset_id".to_string(),
                field: format!("assets.{index}.assetId"),
                message: "assetId must not contain whitespace or null bytes".to_string(),
            });
        }
        if let Some(asset_id) = asset_id
            && !asset_ids.insert(asset_id.clone())
        {
            failures.push(ProfileValidationFailure {
                code: "duplicate_asset_id".to_string(),
                field: format!("assets.{index}.assetId"),
                message: format!("assetId {asset_id} is duplicated"),
            });
        }
        if let Some(path) = required_string_value(failures, asset, &format!("assets.{index}.path"))
        {
            validate_profile_relative_path(failures, &format!("assets.{index}.path"), &path);
        }
        validate_enum_string(
            failures,
            asset,
            &format!("assets.{index}.assetKind"),
            &[
                "script", "database", "metadata", "image", "audio", "archive", "unknown",
            ],
        );
        validate_text_surfaces(failures, asset.get("textSurfaces"), index);
        if let Some(capability) = validate_capability_report(
            failures,
            asset.get("patching"),
            &format!("assets.{index}.patching"),
        ) {
            patching_capabilities.push((format!("assets.{index}.patching.capability"), capability));
        }
        if let Some(source_hash) = asset.get("sourceHash")
            && !source_hash.is_null()
            && source_hash
                .as_str()
                .is_none_or(|hash| hash.trim().is_empty())
        {
            failures.push(ProfileValidationFailure {
                code: "invalid_source_hash".to_string(),
                field: format!("assets.{index}.sourceHash"),
                message: "sourceHash must be null or a non-empty string".to_string(),
            });
        }
    }
    ValidatedAssets {
        patching_capabilities,
        asset_ids,
    }
}

pub(super) fn validate_layered_access_profile(
    failures: &mut Vec<ProfileValidationFailure>,
    layered_access: Option<&Value>,
    asset_ids: &std::collections::BTreeSet<String>,
    key_requirements: &[KeyRequirement],
) {
    let Some(layered_access) = layered_access else {
        return;
    };
    if !layered_access.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "layeredAccess".to_string(),
            message: "layeredAccess must be a JSON object".to_string(),
        });
        return;
    }
    match layered_access.get("schemaVersion").and_then(Value::as_str) {
        Some(PROFILE_SCHEMA_VERSION) => {}
        Some(version) if version.trim().is_empty() => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "layeredAccess.schemaVersion".to_string(),
            message: "layeredAccess.schemaVersion must not be empty".to_string(),
        }),
        Some(version) => failures.push(ProfileValidationFailure {
            code: "unsupported_schema_version".to_string(),
            field: "layeredAccess.schemaVersion".to_string(),
            message: format!(
                "layeredAccess.schemaVersion must be {PROFILE_SCHEMA_VERSION}, got {version}"
            ),
        }),
        None => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "layeredAccess.schemaVersion".to_string(),
            message: "layeredAccess.schemaVersion must not be empty".to_string(),
        }),
    }
    let Some(surfaces) = layered_access.get("surfaces").and_then(Value::as_array) else {
        failures.push(ProfileValidationFailure {
            code: "missing_layered_access_surfaces".to_string(),
            field: "layeredAccess.surfaces".to_string(),
            message: "layeredAccess.surfaces must list per-surface access paths".to_string(),
        });
        return;
    };
    if surfaces.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_layered_access_surfaces".to_string(),
            field: "layeredAccess.surfaces".to_string(),
            message: "layeredAccess.surfaces must list per-surface access paths".to_string(),
        });
    }
    let key_requirement_ids = key_requirements
        .iter()
        .map(|requirement| requirement.requirement_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut seen_surface_ids = std::collections::BTreeSet::new();
    for (index, surface) in surfaces.iter().enumerate() {
        let field = format!("layeredAccess.surfaces.{index}");
        if !surface.is_object() {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "layered access surface must be a JSON object".to_string(),
            });
            continue;
        }
        if let Some(surface_id) =
            required_string_value(failures, surface, &format!("{field}.surfaceId"))
            && !seen_surface_ids.insert(surface_id.clone())
        {
            failures.push(ProfileValidationFailure {
                code: "duplicate_layered_access_surface".to_string(),
                field: format!("{field}.surfaceId"),
                message: format!("layered access surfaceId {surface_id} is duplicated"),
            });
        }
        if let Some(asset_id) =
            required_string_value(failures, surface, &format!("{field}.assetId"))
            && !asset_ids.contains(&asset_id)
        {
            failures.push(ProfileValidationFailure {
                code: "unknown_layered_access_asset".to_string(),
                field: format!("{field}.assetId"),
                message: format!(
                    "layered access assetId {asset_id} does not reference profile assets"
                ),
            });
        }
        if let Some(path) = required_string_value(failures, surface, &format!("{field}.path")) {
            validate_profile_relative_path(failures, &format!("{field}.path"), &path);
        }
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.textSurface"),
            &[
                "dialogue",
                "narration",
                "speaker_name",
                "choice_label",
                "ui_label",
                "tutorial_text",
                "database_entry",
                "song_title",
                "image_text",
                "metadata_text",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.surfaceTransform"),
            &[
                "identity",
                "json_pointer",
                "archive_entry",
                "binary_offset",
                "table_record",
                "runtime_trace",
                "ocr_region",
                "unknown",
            ],
        );
        required_string_value(failures, surface, &format!("{field}.surfaceSelector"));
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.container"),
            &[
                "identity",
                "directory",
                "loose_file",
                "archive",
                "xp3",
                "siglus_pck",
                "rgssad",
                "wolf_archive",
                "asset_bundle",
                "unknown",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.crypto"),
            &[
                "null_key",
                "xor",
                "fixed_key",
                "key_profile",
                "rpg_maker_asset_key",
                "helper_gated",
                "unknown",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.codec"),
            &[
                "identity",
                "utf8_text",
                "utf16_text",
                "shift_jis_text",
                "json_text",
                "rpg_maker_mv_mz_json",
                "ruby_marshal",
                "bytecode_decompile",
                "binary_table",
                "unknown",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.patchBack"),
            &[
                "identity",
                "replace_file",
                "rewrite_json",
                "repack_archive",
                "recompile_bytecode",
                "replace_asset",
                "unsupported",
                "unknown",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.keyMaterialStatus"),
            &["not_required", "resolved", "missing", "helper_gated"],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.helperStatus"),
            &["not_required", "available", "unavailable"],
        );
        validate_layered_access_key_refs(failures, surface, &field, &key_requirement_ids);
    }
}

fn validate_layered_access_key_refs(
    failures: &mut Vec<ProfileValidationFailure>,
    surface: &Value,
    field: &str,
    key_requirement_ids: &std::collections::BTreeSet<&str>,
) {
    let Some(refs) = surface.get("keyRequirementRefs") else {
        return;
    };
    let Some(refs) = refs.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: format!("{field}.keyRequirementRefs"),
            message: "keyRequirementRefs must be an array".to_string(),
        });
        return;
    };
    let mut seen = std::collections::BTreeSet::new();
    for (index, requirement_ref) in refs.iter().enumerate() {
        let requirement_field = format!("{field}.keyRequirementRefs.{index}");
        let Some(requirement_ref) = requirement_ref.as_str() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_key_requirement_ref".to_string(),
                field: requirement_field.clone(),
                message: "keyRequirementRefs entries must be strings".to_string(),
            });
            continue;
        };
        if requirement_ref.trim().is_empty() {
            failures.push(ProfileValidationFailure {
                code: "invalid_key_requirement_ref".to_string(),
                field: requirement_field.clone(),
                message: "keyRequirementRefs entries must not be empty".to_string(),
            });
        }
        if !key_requirement_ids.contains(requirement_ref) {
            failures.push(ProfileValidationFailure {
                code: "unknown_key_requirement_ref".to_string(),
                field: requirement_field.clone(),
                message: format!("key requirement ref {requirement_ref} does not reference profile keyRequirements"),
            });
        }
        if !seen.insert(requirement_ref.to_string()) {
            failures.push(ProfileValidationFailure {
                code: "duplicate_key_requirement_ref".to_string(),
                field: requirement_field,
                message: format!("key requirement ref {requirement_ref} is duplicated"),
            });
        }
    }
}
