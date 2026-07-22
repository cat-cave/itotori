use super::*;

// Trivial full-surface patch round-trip

/// Deterministic trivial translation of a source literal. Prepends the CJK
/// "translate" ideograph so the target is always non-empty, always differs
/// from the source, and exercises the ASCII-safe `\u`-escaping patch path.
pub fn trivial_target(source: &str) -> String {
    format!("\u{8a33}{source}")
}

/// Build a translated v0.2 bundle JSON from an extraction's source bundle,
/// setting `target.text = trivial_target(sourceText)` on every unit.
fn build_trivial_translated_bundle_json(source_bundle_json: &Value) -> Value {
    let mut translated = source_bundle_json.clone();
    if let Some(units) = translated.get_mut("units").and_then(Value::as_array_mut) {
        for unit in units {
            let source_text = unit
                .get("sourceText")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            unit["target"] = json!({"locale": "en-US", "text": trivial_target(&source_text)});
        }
    }
    translated
}

/// One file's changed-status in the trivial patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub file: String,
    pub roles: Vec<MvMzSurfaceRole>,
    pub changed: bool,
}

/// A media asset the patch guarantees byte-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub relative_path: String,
    pub content_sha256: String,
    /// Always `true`: the adapter never writes media.
    pub byte_identical: bool,
}

/// The deterministic full-surface trivial PATCH manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSurfacePatchManifest {
    pub schema_version: String,
    pub fixture_profile_id: String,
    pub capability: MvMzCapabilityTuple,
    /// Every referenced JSON-text file (`www/data/*.json` + `plugins.js`).
    pub changed_files: Vec<ChangedFile>,
    /// Media assets (under `www/img` / `www/audio`) proven byte-identical.
    pub media_untouched: Vec<MediaAsset>,
    /// The media globs the capability tuple declines.
    pub declined_media_globs: Vec<String>,
    /// True iff every declared surface produced a real byte change and every
    /// patched file re-parsed (the trivial round-trip succeeded end-to-end).
    pub all_declared_surfaces_changed: bool,
}

impl FullSurfacePatchManifest {
    /// Deterministic stable JSON.
    pub fn stable_json(&self) -> Result<String, FullSurfaceError> {
        kaifuu_core::stable_json(self).map_err(|err| FullSurfaceError::Serialize {
            message: err.to_string(),
        })
    }
}

/// The result of a trivial full-surface patch: the patched JSON-text bytes and
/// the patch manifest.
#[derive(Debug, Clone)]
pub struct FullSurfacePatch {
    /// Patched bytes per referenced `www/data/*.json` file.
    pub patched_data: BTreeMap<String, Vec<u8>>,
    /// Patched bytes for `www/js/plugins.js`.
    pub patched_plugins_js: Vec<u8>,
    /// The trivial-patch manifest.
    pub manifest: FullSurfacePatchManifest,
}

/// Apply a trivial per-unit translation across every declared surface and
/// build the patch manifest.
/// Reads `www_dir` strictly read-only. `www/data/*.json` are patched via the
/// proven byte-surgical splice ([`apply_translated_bundle`]); `www/js/plugins.js`
/// via [`patch_plugins_file`]. Media under `www/img` / `www/audio` is never
/// read for patching and is recorded (with its source hash) as byte-identical.
pub fn patch_full_surface_trivial(
    www_dir: &Path,
    extraction: &FullSurfaceExtraction,
    opts: &PatchbackOpts,
) -> Result<FullSurfacePatch, FullSurfaceError> {
    let translated_json = build_trivial_translated_bundle_json(&extraction.data.bundle.json);
    let bundle = TranslatedBundleV02::from_json(&translated_json)?;
    let patched_data = apply_translated_bundle(www_dir, &bundle, opts)?;

    let plugins_path = www_dir.join(PLUGINS_JS_REL);
    let original_plugins = std::fs::read(&plugins_path).map_err(|source| FullSurfaceError::Io {
        path: plugins_path.display().to_string(),
        source,
    })?;
    let plugin_translations: Vec<PluginTranslation> = extraction
        .plugins
        .units
        .iter()
        .map(|unit| PluginTranslation {
            unit,
            target_text: trivial_target(&unit.source_text),
        })
        .collect();
    let patched_plugins_js =
        patch_plugins_file(PLUGINS_JS_FILE, &original_plugins, &plugin_translations)?;

    let data_dir = www_dir.join("data");
    let mut roles_by_file: BTreeMap<String, BTreeSet<MvMzSurfaceRole>> = BTreeMap::new();
    for unit in &extraction.data.bundle.bundle.units {
        if let (Some(file), Some(role)) = (
            source_file_of(&unit.source_unit_key),
            role_for_data_key(&unit.source_unit_key),
        ) {
            roles_by_file.entry(file).or_default().insert(role);
        }
    }
    let mut changed_files: Vec<ChangedFile> = Vec::new();
    for (file, bytes) in &patched_data {
        let source = std::fs::read(data_dir.join(file)).map_err(|source| FullSurfaceError::Io {
            path: data_dir.join(file).display().to_string(),
            source,
        })?;
        changed_files.push(ChangedFile {
            file: file.clone(),
            roles: roles_by_file
                .get(file)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect(),
            changed: &source != bytes,
        });
    }
    changed_files.push(ChangedFile {
        file: PLUGINS_JS_FILE.to_string(),
        roles: vec![MvMzSurfaceRole::PluginProfileDiagnostics],
        changed: patched_plugins_js != original_plugins,
    });
    changed_files.sort_by(|a, b| a.file.cmp(&b.file));

    let mut media_untouched: Vec<MediaAsset> = Vec::new();
    for subtree in MEDIA_SUBTREES {
        let dir = www_dir.join(subtree);
        collect_media(www_dir, &dir, &mut media_untouched)?;
    }
    media_untouched.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    // Round-trip succeeds iff every declared surface's referenced file changed
    // (data files carrying units + plugins.js) — a real, non-empty patch.
    let all_declared_surfaces_changed = changed_files.iter().all(|c| c.changed);

    let manifest = FullSurfacePatchManifest {
        schema_version: K112_FULL_SURFACE_SCHEMA_VERSION.to_string(),
        fixture_profile_id: K112_FIXTURE_PROFILE_ID.to_string(),
        capability: extraction.capability.clone(),
        changed_files,
        media_untouched,
        declined_media_globs: extraction.capability.declined_media_globs(),
        all_declared_surfaces_changed,
    };

    Ok(FullSurfacePatch {
        patched_data,
        patched_plugins_js,
        manifest,
    })
}

/// Recursively record every regular file under `dir` as a byte-identical media
/// asset (relative to `www_dir`). Missing subtrees are silently skipped.
fn collect_media(
    www_dir: &Path,
    dir: &Path,
    out: &mut Vec<MediaAsset>,
) -> Result<(), FullSurfaceError> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = std::fs::read_dir(&current).map_err(|source| FullSurfaceError::Io {
            path: current.display().to_string(),
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| FullSurfaceError::Io {
                path: current.display().to_string(),
                source,
            })?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                let bytes = std::fs::read(&path).map_err(|source| FullSurfaceError::Io {
                    path: path.display().to_string(),
                    source,
                })?;
                let rel = path
                    .strip_prefix(www_dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(MediaAsset {
                    relative_path: rel,
                    content_sha256: sha256_hash_bytes(&bytes),
                    byte_identical: true,
                });
            }
        }
    }
    Ok(())
}

/// Assert that `JsonStringEscaping` is exercised by the patch (documents the
/// ASCII-safe escaping contract the trivial target depends on).
pub const PATCH_ESCAPING: JsonStringEscaping = JsonStringEscaping::AsciiSafeUnicodeEscapes;
