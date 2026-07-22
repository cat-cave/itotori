use super::*;

// Per-surface coverage

/// Per-role coverage: how many units the integration surfaced for a role,
/// which files fed it, and a bounded sample of the STRUCTURAL surface keys
/// (JSON-pointer ids — never retail text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCoverage {
    pub role: MvMzSurfaceRole,
    pub surface_id: String,
    pub unit_count: usize,
    pub files: Vec<String>,
    /// Up to four surface keys (structural JSON-pointer ids), sorted.
    pub sample_surface_keys: Vec<String>,
}

/// Maximum number of sample surface keys recorded per role.
const SAMPLE_KEY_LIMIT: usize = 4;

/// Assign a `www/data/*.json` surface key to its declared role.
/// `System.json` splits by pointer: `gameTitle`/`currencyUnit` are the
/// `System` role, everything else (`terms.*`, the type lists) is `Terms`.
pub fn role_for_data_key(source_unit_key: &str) -> Option<MvMzSurfaceRole> {
    let rest = source_unit_key.strip_prefix("rpgmaker:")?;
    let (file, pointer) = rest.split_once('#')?;
    if is_map_file(file) {
        Some(MvMzSurfaceRole::Maps)
    } else if file == "CommonEvents.json" {
        Some(MvMzSurfaceRole::CommonEvents)
    } else if file == "System.json" {
        if pointer.starts_with("/gameTitle") || pointer.starts_with("/currencyUnit") {
            Some(MvMzSurfaceRole::System)
        } else {
            Some(MvMzSurfaceRole::Terms)
        }
    } else if crate::is_database_file(file) {
        Some(MvMzSurfaceRole::Database)
    } else {
        None
    }
}

/// `MapNNN.json` (digits only) — excludes `MapInfos.json`. Mirrors the
/// private matcher in `crate::lib`.
fn is_map_file(file: &str) -> bool {
    let Some(stem) = file.strip_suffix(".json") else {
        return false;
    };
    let Some(digits) = stem.strip_prefix("Map") else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

// Structural (retail-text-free) diagnostic + finding records

/// A structural summary of a [`Finding`] (unknown / script / plugin-command
/// event code). Carries only structural description — never retail text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingRecord {
    pub kind: String,
    pub file: String,
    pub pointer: String,
    pub command_code: Option<i64>,
    pub detail: String,
}

impl FindingRecord {
    fn from_finding(finding: &Finding) -> Self {
        Self {
            kind: format!("{:?}", finding.kind),
            file: finding.file.clone(),
            pointer: finding.pointer_string(),
            command_code: finding.command_code,
            detail: finding.detail.clone(),
        }
    }
}

/// A structural summary of a [`PluginDiagnostic`] (unsupported plugin profile
/// mis-declared pointer). Structural only — never retail text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnosticRecord {
    pub kind: String,
    pub source_file: String,
    pub plugin_name: Option<String>,
    pub pointer: String,
    pub detail: String,
}

impl PluginDiagnosticRecord {
    fn from_diagnostic(diagnostic: &PluginDiagnostic) -> Self {
        let pointer = if diagnostic.pointer.is_empty() {
            String::new()
        } else {
            let mut out = String::new();
            for token in &diagnostic.pointer {
                out.push('/');
                out.push_str(&token.replace('~', "~0").replace('/', "~1"));
            }
            out
        };
        Self {
            kind: format!("{:?}", diagnostic.kind),
            source_file: diagnostic.source_file.clone(),
            plugin_name: diagnostic.plugin_name.clone(),
            pointer,
            detail: diagnostic.detail.clone(),
        }
    }
}

// Full-surface extraction

/// The combined full-surface extraction: the `www/data` bridge bundle, the
/// `plugins.js` plugin-profile extraction, the per-role coverage census, and
/// the honest capability tuple.
#[derive(Debug, Clone)]
pub struct FullSurfaceExtraction {
    /// The five JSON-text surfaces (maps/common-events/database/system/terms).
    pub data: RpgMakerExtraction,
    /// The plugin-profile surface (declared text + diagnostics).
    pub plugins: PluginExtraction,
    /// Per-role coverage across all six declared surfaces (canonical order).
    pub coverage: Vec<SurfaceCoverage>,
    /// The honest, non-overclaiming capability tuple.
    pub capability: MvMzCapabilityTuple,
}

/// Fatal errors raised by the full-surface integration.
#[derive(Debug, thiserror::Error)]
pub enum FullSurfaceError {
    #[error(transparent)]
    Data(#[from] ExtractError),
    #[error(transparent)]
    Plugins(#[from] PluginExtractError),
    #[error(transparent)]
    Patchback(#[from] PatchbackError),
    #[error(transparent)]
    PluginPatch(#[from] PluginPatchError),
    #[error("kaifuu.rpgmaker.k112.plugins_missing: {path} has no js/plugins.js")]
    PluginsMissing { path: String },
    #[error("kaifuu.rpgmaker.k112.io: {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("kaifuu.rpgmaker.k112.serialize: {message}")]
    Serialize { message: String },
}

/// Walk a game's `www` tree across all six declared surfaces.
/// Runs [`extract_game_dir`] for the five `www/data/*.json` surfaces and
/// [`extract_plugins_file`] on `www/js/plugins.js` (which must exist) with the
/// caller-declared plugin `profiles`. Deterministic: identical input yields an
/// identical [`FullSurfaceExtraction`].
pub fn extract_full_surface(
    www_dir: &Path,
    profiles: &[PluginProfile],
    opts: &BridgeOpts<'_>,
) -> Result<FullSurfaceExtraction, FullSurfaceError> {
    let data = extract_game_dir(www_dir, opts)?;

    let plugins_path = www_dir.join(PLUGINS_JS_REL);
    if !plugins_path.is_file() {
        return Err(FullSurfaceError::PluginsMissing {
            path: www_dir.display().to_string(),
        });
    }
    let plugins = extract_plugins_file(&plugins_path, profiles)?;

    let coverage = build_coverage(&data, &plugins);
    let capability = MvMzCapabilityTuple::honest();
    Ok(FullSurfaceExtraction {
        data,
        plugins,
        coverage,
        capability,
    })
}

/// Build the per-role coverage census across all six surfaces.
fn build_coverage(data: &RpgMakerExtraction, plugins: &PluginExtraction) -> Vec<SurfaceCoverage> {
    // role -> (count, files, keys)
    let mut counts: BTreeMap<MvMzSurfaceRole, usize> = BTreeMap::new();
    let mut files: BTreeMap<MvMzSurfaceRole, BTreeSet<String>> = BTreeMap::new();
    let mut keys: BTreeMap<MvMzSurfaceRole, BTreeSet<String>> = BTreeMap::new();

    for unit in &data.bundle.bundle.units {
        if let Some(role) = role_for_data_key(&unit.source_unit_key) {
            *counts.entry(role).or_default() += 1;
            if let Some(file) = source_file_of(&unit.source_unit_key) {
                files.entry(role).or_default().insert(file);
            }
            keys.entry(role)
                .or_default()
                .insert(unit.source_unit_key.clone());
        }
    }
    let role = MvMzSurfaceRole::PluginProfileDiagnostics;
    for unit in &plugins.units {
        let key = unit.source_unit_key();
        *counts.entry(role).or_default() += 1;
        files
            .entry(role)
            .or_default()
            .insert(PLUGINS_JS_FILE.to_string());
        keys.entry(role).or_default().insert(key);
    }

    MvMzSurfaceRole::all()
        .into_iter()
        .map(|role| {
            let file_list: Vec<String> = files
                .get(&role)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect();
            let sample: Vec<String> = keys
                .get(&role)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(SAMPLE_KEY_LIMIT)
                .collect();
            SurfaceCoverage {
                role,
                surface_id: role.surface_id(),
                unit_count: counts.get(&role).copied().unwrap_or(0),
                files: file_list,
                sample_surface_keys: sample,
            }
        })
        .collect()
}

/// Extract the `<file>` component of a `rpgmaker:<file>#<pointer>` key.
pub(super) fn source_file_of(source_unit_key: &str) -> Option<String> {
    let rest = source_unit_key.strip_prefix("rpgmaker:")?;
    let (file, _) = rest.split_once('#')?;
    Some(file.to_string())
}

impl FullSurfaceExtraction {
    /// True iff every one of the six declared surfaces yielded at least one
    /// translatable unit — the golden-fixture full-coverage acceptance.
    pub fn covers_all_surfaces(&self) -> bool {
        self.coverage.len() == MvMzSurfaceRole::all().len()
            && self.coverage.iter().all(|c| c.unit_count > 0)
    }

    /// Total translatable units across all six surfaces.
    pub fn total_unit_count(&self) -> usize {
        self.coverage.iter().map(|c| c.unit_count).sum()
    }

    /// Build the deterministic, retail-text-free full-surface extraction
    /// manifest.
    pub fn extraction_manifest(&self) -> FullSurfaceExtractionManifest {
        FullSurfaceExtractionManifest {
            schema_version: K112_FULL_SURFACE_SCHEMA_VERSION.to_string(),
            fixture_profile_id: K112_FIXTURE_PROFILE_ID.to_string(),
            capability: self.capability.clone(),
            surfaces: self.coverage.clone(),
            data_unit_count: self.data.bundle.bundle.units.len(),
            plugin_unit_count: self.plugins.units.len(),
            plugin_diagnostics: self
                .plugins
                .diagnostics
                .iter()
                .map(PluginDiagnosticRecord::from_diagnostic)
                .collect(),
            findings: self
                .data
                .findings
                .iter()
                .map(FindingRecord::from_finding)
                .collect(),
        }
    }
}

/// The deterministic full-surface EXTRACTION manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSurfaceExtractionManifest {
    pub schema_version: String,
    pub fixture_profile_id: String,
    pub capability: MvMzCapabilityTuple,
    pub surfaces: Vec<SurfaceCoverage>,
    pub data_unit_count: usize,
    pub plugin_unit_count: usize,
    pub plugin_diagnostics: Vec<PluginDiagnosticRecord>,
    pub findings: Vec<FindingRecord>,
}

impl FullSurfaceExtractionManifest {
    /// True iff every declared surface has at least one unit.
    pub fn covers_all_surfaces(&self) -> bool {
        self.surfaces.len() == MvMzSurfaceRole::all().len()
            && self.surfaces.iter().all(|s| s.unit_count > 0)
    }

    /// Deterministic stable JSON.
    pub fn stable_json(&self) -> Result<String, FullSurfaceError> {
        kaifuu_core::stable_json(self).map_err(|err| FullSurfaceError::Serialize {
            message: err.to_string(),
        })
    }
}
