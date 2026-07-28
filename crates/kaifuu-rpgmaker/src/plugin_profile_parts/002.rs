// reason: cohesive per-plugin extractor over distinct positional inputs.
#[allow(clippy::too_many_arguments)]
fn extract_profiled_plugin(
    acc: &mut PluginExtraction,
    source_file: &str,
    plugin_index: usize,
    plugin_name: &str,
    entry: &Value,
    parameters: Option<&Value>,
    profile: &PluginProfile,
) {
    let mut extracted_pointers: Vec<String> = Vec::new();

    for spec in &profile.params {
        let mut full_pointer = vec![plugin_index.to_string(), "parameters".to_string()];
        full_pointer.extend(spec.pointer.iter().cloned());

        // Resolve the declared pointer within the plugin's parameters object.
        let resolved = parameters.and_then(|params| resolve_pointer(params, &spec.pointer));
        match resolved {
            Some(Value::String(text)) if !text.is_empty() => {
                acc.units.push(StablePluginTextUnit {
                    source_file: source_file.to_string(),
                    plugin_name: plugin_name.to_string(),
                    plugin_id: profile.plugin_id.clone(),
                    plugin_index,
                    param_pointer: spec.pointer.clone(),
                    text_role: spec.text_role,
                    patchability: spec.patchability,
                    fixture_profile_id: FIXTURE_PROFILE_ID,
                    pointer: full_pointer,
                    source_text: text.clone(),
                });
                extracted_pointers.push(pointer_string_within_params(&spec.pointer));
            }
            // Empty declared string: not a translatable surface, not a
            // diagnostic (matches the empty-string handling).
            Some(Value::String(_)) => {}
            // Present but non-text (a numeric/switch string mistake), or the
            // pointer did not resolve at all → rejected, never extracted.
            _ => acc.diagnostics.push(PluginDiagnostic {
                kind: PluginDiagnosticKind::UnsupportedDeclaredPointer,
                source_file: source_file.to_string(),
                plugin_name: Some(plugin_name.to_string()),
                pointer: full_pointer,
                detail: if resolved.is_none() {
                    "declared parameter pointer did not resolve to a value; not extracted"
                        .to_string()
                } else {
                    "declared parameter pointer is present but not a JSON string \
                     (numeric/switch/structure); not extracted"
                        .to_string()
                },
            }),
        }
    }

    acc.profiled.push(ProfiledPlugin {
        plugin_id: profile.plugin_id.clone(),
        plugin_name: plugin_name.to_string(),
        plugin_index,
        declared_version: profile.plugin_version.clone(),
        fixture_hash: fixture_hash_of(entry),
        extracted_pointers,
        fixture_profile_id: FIXTURE_PROFILE_ID,
    });
}

/// RFC6901 pointer string for a pointer *within* the parameters object.
fn pointer_string_within_params(pointer: &[String]) -> String {
    let mut out = String::new();
    for token in pointer {
        out.push('/');
        out.push_str(&token.replace('~', "~0").replace('/', "~1"));
    }
    out
}

/// Content hash over a plugin entry's canonical JSON serialization. serde_json
/// (no `preserve_order`) sorts object keys, so this is deterministic and pins
/// exactly which plugin fixture was extracted.
fn fixture_hash_of(entry: &Value) -> String {
    let canonical = serde_json::to_vec(entry).unwrap_or_default();
    sha256_hash_bytes(&canonical)
}

// File-level extraction

/// Read `js/plugins.js`, split off its `$plugins` array, parse it, and extract
/// the declared plugin-profile text units. `MissingFile` / `MalformedJson` /
/// `MalformedPluginsJs` are typed semantic errors surfaced before any write.
pub fn extract_plugins_file(
    path: &Path,
    profiles: &[PluginProfile],
) -> Result<PluginExtraction, PluginExtractError> {
    let file = file_name(path);
    let bytes = read_bytes(path, &file)?;
    let split = split_plugins_js(&file, &bytes).map_err(|reason| {
        PluginExtractError::MalformedPluginsJs {
            file: file.clone(),
            reason,
        }
    })?;
    let array_bytes = &bytes[split.array_start..=split.array_end];
    let value: Value = serde_json::from_slice(array_bytes).map_err(|source| {
        PluginExtractError::MalformedJson {
            file: file.clone(),
            source,
        }
    })?;
    Ok(extract_plugins(&file, &value, profiles))
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

fn read_bytes(path: &Path, file: &str) -> Result<Vec<u8>, PluginExtractError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            Err(PluginExtractError::MissingFile {
                file: file.to_string(),
            })
        }
        Err(source) => Err(PluginExtractError::Io {
            file: file.to_string(),
            source,
        }),
    }
}

// Byte-preserving patch

/// One reviewed translation: the stable unit + its target text.
#[derive(Debug, Clone)]
pub struct PluginTranslation<'a> {
    pub unit: &'a StablePluginTextUnit,
    pub target_text: String,
}

/// Patch a whole `plugins.js` file's raw bytes with reviewed translations for
/// its declared plugin-parameter units, preserving every other byte.
/// The file is split into `(prefix, $plugins array, suffix)`; only the array
/// bytes are spliced (reusing [`crate::patchback::patch_file_bytes`] — the
/// same byte-surgical splice + stale-source gate as the
/// slices), then reassembled. The `var $plugins =` prefix and the trailing
/// `;` suffix are preserved verbatim, so an untranslated patch is a
/// byte-identical no-op and a translated patch changes only the declared
/// parameter literals. A translation targeting a [`Patchability::ReadOnly`]
/// unit is rejected.
pub fn patch_file(
    source_file: &str,
    original: &[u8],
    translations: &[PluginTranslation<'_>],
) -> Result<Vec<u8>, PluginPatchError> {
    for t in translations {
        if t.unit.patchability == Patchability::ReadOnly {
            return Err(PluginPatchError::NonPatchablePointer {
                source_unit_key: t.unit.source_unit_key(),
            });
        }
    }

    let split = split_plugins_js(source_file, original).map_err(|reason| {
        PluginPatchError::MalformedPluginsJs {
            file: source_file.to_string(),
            reason,
        }
    })?;
    let prefix = &original[..split.array_start];
    let array_bytes = &original[split.array_start..=split.array_end];
    let suffix = &original[split.array_end + 1..];

    let edits: Vec<FileEdit> = translations
        .iter()
        .map(|t| FileEdit {
            source_unit_key: t.unit.source_unit_key(),
            tokens: t.unit.pointer.clone(),
            target_text: t.target_text.clone(),
            expected_source_hash: sha256_hash_bytes(t.unit.source_text.as_bytes()),
        })
        .collect();

    let patched_array = patch_file_bytes(source_file, array_bytes, &edits)?;

    let mut out = Vec::with_capacity(prefix.len() + patched_array.len() + suffix.len());
    out.extend_from_slice(prefix);
    out.extend_from_slice(&patched_array);
    out.extend_from_slice(suffix);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message_box_profile() -> PluginProfile {
        PluginProfile {
            plugin_name: "MessageBox".to_string(),
            plugin_id: "com.example.MessageBox".to_string(),
            plugin_version: Some("1.2.0".to_string()),
            params: vec![
                PluginParamPointer {
                    pointer: vec!["windowTitle".to_string()],
                    text_role: PluginTextRole::UiLabel,
                    patchability: Patchability::Patchable,
                },
                PluginParamPointer {
                    pointer: vec!["okButton".to_string()],
                    text_role: PluginTextRole::UiLabel,
                    patchability: Patchability::Patchable,
                },
            ],
        }
    }

    #[test]
    fn declared_pointers_extract_only_and_config_params_do_not() {
        let plugins = json!([
            {
                "name": "MessageBox",
                "status": true,
                "description": "A message box plugin.",
                "parameters": {
                    "windowTitle": "Dialogue",
                    "okButton": "Confirm",
                    "maxWidth": "800",
                    "switchId": "12"
                }
            }
        ]);
        let out = extract_plugins("plugins.js", &plugins, &[message_box_profile()]);
        // Only the two DECLARED pointers extract; maxWidth/switchId do not.
        let keys: Vec<String> = out
            .units
            .iter()
            .map(StablePluginTextUnit::source_unit_key)
            .collect();
        assert_eq!(
            keys,
            vec![
                "rpgmaker:plugins.js#/0/parameters/windowTitle",
                "rpgmaker:plugins.js#/0/parameters/okButton",
            ]
        );
        assert!(
            out.diagnostics.is_empty(),
            "clean profiled plugin: no diags"
        );
        // Profile output records id + declared version + fixture hash + pointers.
        assert_eq!(out.profiled.len(), 1);
        let p = &out.profiled[0];
        assert_eq!(p.plugin_id, "com.example.MessageBox");
        assert_eq!(p.declared_version.as_deref(), Some("1.2.0"));
        assert!(p.fixture_hash.starts_with("sha256:"));
        assert_eq!(p.extracted_pointers, vec!["/windowTitle", "/okButton"]);
        for u in &out.units {
            assert_eq!(u.fixture_profile_id, "synthetic-fixture");
            assert_eq!(u.plugin_id, "com.example.MessageBox");
        }
    }

    #[test]
    fn unprofiled_plugin_with_string_params_is_a_diagnostic() {
        let plugins = json!([
            {
                "name": "MysteryPlugin",
                "status": true,
                "description": "",
                "parameters": {"greeting": "Hello there"}
            }
        ]);
        let out = extract_plugins("plugins.js", &plugins, &[]);
        assert!(out.units.is_empty(), "no profile -> no extraction");
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(
            out.diagnostics[0].kind,
            PluginDiagnosticKind::UnsupportedPluginProfile
        );
        assert_eq!(
            out.diagnostics[0].plugin_name.as_deref(),
            Some("MysteryPlugin")
        );
    }

    #[test]
    fn unprofiled_plugin_with_no_string_params_is_silent() {
        // A config-only plugin (numeric strings only would still count as text;
        // here we use a params object with only an empty string) does not warn.
        let plugins = json!([
            {"name": "PurelyNumeric", "status": true, "parameters": {"opacity": ""}}
        ]);
        let out = extract_plugins("plugins.js", &plugins, &[]);
        assert!(out.units.is_empty());
        assert!(
            out.diagnostics.is_empty(),
            "no non-empty string params -> no unsupported-profile noise"
        );
    }

    #[test]
    fn declared_pointer_to_missing_or_nontext_is_rejected() {
        let profile = PluginProfile {
            plugin_name: "Broken".to_string(),
            plugin_id: "broken".to_string(),
            plugin_version: None,
            params: vec![
                // Declares a pointer at a NUMERIC (non-text) value: a mistake.
                PluginParamPointer {
                    pointer: vec!["count".to_string()],
                    text_role: PluginTextRole::Caption,
                    patchability: Patchability::Patchable,
                },
                // Declares a pointer that does not resolve.
                PluginParamPointer {
                    pointer: vec!["ghost".to_string()],
                    text_role: PluginTextRole::Caption,
                    patchability: Patchability::Patchable,
                },
            ],
        };
        let plugins = json!([
            {"name": "Broken", "status": true, "parameters": {"count": 42}}
        ]);
        let out = extract_plugins("plugins.js", &plugins, &[profile]);
        assert!(
            out.units.is_empty(),
            "non-text/missing pointers not extracted"
        );
        assert_eq!(out.diagnostics.len(), 2);
        for d in &out.diagnostics {
            assert_eq!(d.kind, PluginDiagnosticKind::UnsupportedDeclaredPointer);
        }
        // The plugin is still recorded (with no extracted pointers).
        assert_eq!(out.profiled.len(), 1);
        assert!(out.profiled[0].extracted_pointers.is_empty());
    }

    #[test]
    fn split_plugins_js_isolates_the_array() {
        let src = b"// header\nvar $plugins =\n[\n{\"name\":\"A\"}\n];\n";
        let split = split_plugins_js("plugins.js", src).unwrap();
        let array = &src[split.array_start..=split.array_end];
        let value: Value = serde_json::from_slice(array).unwrap();
        assert_eq!(value.as_array().unwrap().len(), 1);
        assert_eq!(&src[..split.array_start], b"// header\nvar $plugins =\n");
        assert_eq!(&src[split.array_end + 1..], b";\n");
    }

    #[test]
    fn match_bracket_respects_strings_and_nesting() {
        let src = br#"[{"a":"]}"},{"b":[1,2]}]TAIL"#;
        let close = match_bracket(src, 0).unwrap();
        assert_eq!(src[close], b']');
        assert_eq!(&src[close + 1..], b"TAIL");
    }

    #[test]
    fn malformed_container_is_a_diagnostic() {
        let out = extract_plugins("plugins.js", &json!({"not": "array"}), &[]);
        assert!(out.units.is_empty());
        assert_eq!(
            out.diagnostics[0].kind,
            PluginDiagnosticKind::MalformedContainer
        );
    }

    #[test]
    fn deterministic_reextraction_and_bridge_ids() {
        let plugins = json!([
            {"name": "MessageBox", "parameters": {"windowTitle": "T", "okButton": "OK"}}
        ]);
        let first = extract_plugins("plugins.js", &plugins, &[message_box_profile()]);
        let second = extract_plugins("plugins.js", &plugins, &[message_box_profile()]);
        assert_eq!(first, second);
        assert_eq!(
            first.units[0].bridge_unit_id(),
            second.units[0].bridge_unit_id()
        );
    }

    #[test]
    fn read_only_pointer_translation_is_rejected() {
        let profile = PluginProfile {
            plugin_name: "RO".to_string(),
            plugin_id: "ro".to_string(),
            plugin_version: None,
            params: vec![PluginParamPointer {
                pointer: vec!["label".to_string()],
                text_role: PluginTextRole::UiLabel,
                patchability: Patchability::ReadOnly,
            }],
        };
        let plugins = json!([{"name": "RO", "parameters": {"label": "Fixed"}}]);
        let out = extract_plugins("plugins.js", &plugins, &[profile]);
        assert_eq!(out.units.len(), 1);
        let src = b"var $plugins =\n[{\"name\":\"RO\",\"parameters\":{\"label\":\"Fixed\"}}];\n";
        let err = patch_file(
            "plugins.js",
            src,
            &[PluginTranslation {
                unit: &out.units[0],
                target_text: "Changed".to_string(),
            }],
        )
        .expect_err("read-only pointer must be rejected");
        assert!(matches!(err, PluginPatchError::NonPatchablePointer { .. }));
    }
}

