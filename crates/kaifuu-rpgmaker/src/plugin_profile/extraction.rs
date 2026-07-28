use super::*;

/// Extract declared plugin-parameter text units from a parsed `$plugins`
/// array, using the DECLARED profiles. A plugin with no profile that carries
/// string params yields an [`PluginDiagnosticKind::UnsupportedPluginProfile`]
/// diagnostic; a declared pointer that is missing or non-text yields an
/// [`PluginDiagnosticKind::UnsupportedDeclaredPointer`] diagnostic.
#[must_use]
pub fn extract_plugins(
    source_file: &str,
    plugins: &Value,
    profiles: &[PluginProfile],
) -> PluginExtraction {
    let mut acc = PluginExtraction::default();
    let Some(array) = plugins.as_array() else {
        acc.diagnostics.push(PluginDiagnostic {
            kind: PluginDiagnosticKind::MalformedContainer,
            source_file: source_file.to_string(),
            plugin_name: None,
            pointer: Vec::new(),
            detail: "$plugins top level is not a JSON array".to_string(),
        });
        return acc;
    };

    for (plugin_index, entry) in array.iter().enumerate() {
        let Some(object) = entry.as_object() else {
            acc.diagnostics.push(PluginDiagnostic {
                kind: PluginDiagnosticKind::MalformedContainer,
                source_file: source_file.to_string(),
                plugin_name: None,
                pointer: vec![plugin_index.to_string()],
                detail: "$plugins entry is not a plugin object".to_string(),
            });
            continue;
        };
        let plugin_name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let parameters = object.get("parameters");

        let Some(profile) = profile_for(profiles, &plugin_name) else {
            // No declared profile: DO NOT sweep the params. If the plugin
            // carries string params it may own text — one typed diagnostic.
            if plugin_carries_string_params(parameters) {
                acc.diagnostics.push(PluginDiagnostic {
                    kind: PluginDiagnosticKind::UnsupportedPluginProfile,
                    source_file: source_file.to_string(),
                    plugin_name: Some(plugin_name.clone()),
                    pointer: vec![plugin_index.to_string(), "parameters".to_string()],
                    detail:
                        "plugin has string parameters but no declared profile; its parameter text \
                         is not represented (declare a profile to extract it)"
                            .to_string(),
                });
            }
            continue;
        };

        extract_profiled_plugin(
            &mut acc,
            source_file,
            plugin_index,
            &plugin_name,
            entry,
            parameters,
            profile,
        );
    }

    acc
}

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
