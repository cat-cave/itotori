use super::*;

// Capability tuple — honest scope

/// One in-scope capability scope: a named boundary the adapter really
/// supports, its capability rung, and the surface roles it covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityScope {
    /// Stable scope id (`mv_mz/json_text` | `mv_mz/plugin_profile`).
    pub scope_id: String,
    /// Structural description (no retail text).
    pub description: String,
    /// The honest capability rung for this scope.
    pub capability: CapabilityLevel,
    /// The surface roles this scope covers.
    pub roles: Vec<MvMzSurfaceRole>,
}

/// One explicitly-declined scope: something the adapter does NOT claim, so a
/// consumer never mistakes silence for support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutOfScope {
    /// Stable scope id (`mv_mz/encrypted_media` | `mv_mz/plugin_js_logic`).
    pub scope_id: String,
    /// Structural reason the scope is declined.
    pub reason: String,
}

/// The honest MV/MZ capability tuple emitted by the full-surface integration.
/// Limited to MV/MZ JSON text + plugin-profile diagnostics — it never claims
/// encrypted-media or plugin-JS support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzCapabilityTuple {
    pub engine_family: String,
    pub variant: String,
    pub in_scope: Vec<CapabilityScope>,
    pub out_of_scope: Vec<OutOfScope>,
    /// Every surface role the tuple covers (canonical order, all six).
    pub covered_roles: Vec<MvMzSurfaceRole>,
    /// The honest ceiling capability across all in-scope surfaces.
    pub capability: CapabilityLevel,
}

/// Canonical scope id for the five JSON-text roles.
pub const SCOPE_JSON_TEXT: &str = "mv_mz/json_text";
/// Canonical scope id for the plugin-profile role.
pub const SCOPE_PLUGIN_PROFILE: &str = "mv_mz/plugin_profile";
/// Canonical out-of-scope id for encrypted media.
pub const SCOPE_ENCRYPTED_MEDIA: &str = "mv_mz/encrypted_media";
/// Canonical out-of-scope id for plugin JS logic (never executed).
pub const SCOPE_PLUGIN_JS_LOGIC: &str = "mv_mz/plugin_js_logic";

impl MvMzCapabilityTuple {
    /// The canonical honest tuple: JSON text (extract+patch) + plugin-profile
    /// (extract declared text, diagnose undeclared); encrypted media + plugin
    /// JS logic declined.
    pub fn honest() -> Self {
        use MvMzSurfaceRole::{CommonEvents, Database, Maps, System, Terms};
        let json_text_roles = vec![Maps, CommonEvents, Database, System, Terms];
        Self {
            engine_family: MV_MZ_ENGINE_FAMILY.to_string(),
            variant: MV_MZ_VARIANT.to_string(),
            in_scope: vec![
                CapabilityScope {
                    scope_id: SCOPE_JSON_TEXT.to_string(),
                    description: "www/data/*.json event-command + database + system + terms text: \
                                  extract and byte-surgical patch-back."
                        .to_string(),
                    capability: CapabilityLevel::Patch,
                    roles: json_text_roles,
                },
                CapabilityScope {
                    scope_id: SCOPE_PLUGIN_PROFILE.to_string(),
                    description: "www/js/plugins.js DECLARED plugin-parameter text: extract and \
                                  byte-surgical patch-back; undeclared plugin text is diagnosed, \
                                  never swept."
                        .to_string(),
                    capability: CapabilityLevel::Patch,
                    roles: vec![MvMzSurfaceRole::PluginProfileDiagnostics],
                },
            ],
            out_of_scope: vec![
                OutOfScope {
                    scope_id: SCOPE_ENCRYPTED_MEDIA.to_string(),
                    reason: "Encrypted *.rpgmvp/*.rpgmvm/*.rpgmvo media is neither extracted nor \
                             patched by this node; it is left byte-identical."
                        .to_string(),
                },
                OutOfScope {
                    scope_id: SCOPE_PLUGIN_JS_LOGIC.to_string(),
                    reason: "Plugin JavaScript is never executed or rewritten; only DECLARED \
                             plugin-parameter text literals are touched."
                        .to_string(),
                },
            ],
            covered_roles: MvMzSurfaceRole::all().to_vec(),
            capability: CapabilityLevel::Patch,
        }
    }

    /// Media globs this tuple explicitly declines. Used by the patch manifest
    /// to name what is guaranteed byte-identical.
    pub fn declined_media_globs(&self) -> Vec<String> {
        vec![
            "www/img/**/*.rpgmvp".to_string(),
            "www/audio/**/*.rpgmvm".to_string(),
            "www/audio/**/*.rpgmvo".to_string(),
        ]
    }

    /// Mechanically enforce the honest boundary. Returns one structured string
    /// per drift; empty iff the tuple is a faithful, non-overclaiming
    /// declaration limited to JSON text + plugin-profile diagnostics.
    pub fn violations(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.engine_family != MV_MZ_ENGINE_FAMILY {
            out.push(format!("wrong engine_family: {}", self.engine_family));
        }
        if self.variant != MV_MZ_VARIANT {
            out.push(format!("wrong variant: {}", self.variant));
        }

        // In-scope ids limited to the two allowed text scopes.
        let allowed_in: BTreeSet<&str> = [SCOPE_JSON_TEXT, SCOPE_PLUGIN_PROFILE].into();
        for scope in &self.in_scope {
            if !allowed_in.contains(scope.scope_id.as_str()) {
                out.push(format!("in-scope id not a text scope: {}", scope.scope_id));
            }
        }
        // Both text scopes present exactly once.
        for required in [SCOPE_JSON_TEXT, SCOPE_PLUGIN_PROFILE] {
            let count = self
                .in_scope
                .iter()
                .filter(|s| s.scope_id == required)
                .count();
            if count != 1 {
                out.push(format!(
                    "in-scope {required} present {count} times (want 1)"
                ));
            }
        }

        // Encrypted media + plugin-JS logic must be explicitly declined.
        let declined: BTreeSet<&str> = self
            .out_of_scope
            .iter()
            .map(|s| s.scope_id.as_str())
            .collect();
        for required in [SCOPE_ENCRYPTED_MEDIA, SCOPE_PLUGIN_JS_LOGIC] {
            if !declined.contains(required) {
                out.push(format!("missing out-of-scope declaration: {required}"));
            }
        }
        // No scope is both claimed and declined.
        for scope in &self.in_scope {
            if declined.contains(scope.scope_id.as_str()) {
                out.push(format!(
                    "scope {} both claimed and declined",
                    scope.scope_id
                ));
            }
        }

        // The union of in-scope roles must be exactly the six declared roles.
        let covered: BTreeSet<MvMzSurfaceRole> = self
            .in_scope
            .iter()
            .flat_map(|s| s.roles.iter().copied())
            .collect();
        let expected: BTreeSet<MvMzSurfaceRole> = MvMzSurfaceRole::all().into_iter().collect();
        if covered != expected {
            out.push("in-scope roles are not exactly the six declared roles".to_string());
        }
        let covered_roles: BTreeSet<MvMzSurfaceRole> = self.covered_roles.iter().copied().collect();
        if covered_roles != expected {
            out.push("covered_roles are not exactly the six declared roles".to_string());
        }

        // The ceiling cannot exceed patch (the honest maximum of this node).
        if self.capability > CapabilityLevel::Patch {
            out.push(format!("capability above patch: {:?}", self.capability));
        }
        out
    }

    /// Deterministic stable JSON.
    pub fn stable_json(&self) -> Result<String, FullSurfaceError> {
        kaifuu_core::stable_json(self).map_err(|err| FullSurfaceError::Serialize {
            message: err.to_string(),
        })
    }
}
