//! `_vault/metadata.json` parser, JSON-Schema validator, and the
//! cross-checker against the catalog.

use std::path::{Path, PathBuf};

use jsonschema::Validator;
use serde::Deserialize;
use serde_json::Value;

use crate::discovery::ReleaseCandidate;
use crate::error::VaultSourceError;
use crate::findings::CrossCheckFinding;
use crate::paths::ExternalId;

/// Caller-facing tolerance for cross-check disagreements.
/// Contract default: reject mismatched work identity (always); accept
/// everything else with a finding.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CrossCheckTolerance {
    /// When `true`, platforms-disjoint promotes to error.
    pub strict_platforms: bool,
    /// When `true`, languages-disjoint promotes to error.
    pub strict_languages: bool,
    /// When `true`, role-mismatch promotes to error.
    pub strict_role: bool,
}

impl CrossCheckTolerance {
    /// Strict mode: every catalog/embedded disagreement becomes an error.
    pub fn strict() -> Self {
        Self {
            strict_platforms: true,
            strict_languages: true,
            strict_role: true,
        }
    }
}

/// Outcome of a cross-check call.
#[derive(Debug, Clone)]
pub struct CrossCheckOutcome {
    /// Non-fatal disagreements; surfaced for the caller's findings sink.
    pub findings: Vec<CrossCheckFinding>,
}

/// Embedded metadata after schema validation and structural parsing.
#[derive(Debug, Clone)]
pub struct EmbeddedMetadata {
    /// Schema version string from the embedded file (must be `"1.0"`).
    pub schema_version: String,
    /// Raw parsed JSON for downstream inspection.
    pub raw: Value,
}

/// Compiled JSON-Schema validator. Cache one per [`crate::source::VaultSource`].
pub struct EmbeddedSchema {
    validator: Validator,
}

impl std::fmt::Debug for EmbeddedSchema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmbeddedSchema").finish_non_exhaustive()
    }
}

impl EmbeddedSchema {
    /// Compile a schema file (the vault's `embedded-metadata.schema.json`).
    pub fn from_schema_path(path: &Path) -> Result<Self, VaultSourceError> {
        let raw =
            std::fs::read_to_string(path).map_err(|_| VaultSourceError::VaultRootIncomplete {
                path: path.to_path_buf(),
                missing: "embedded-metadata.schema.json",
            })?;
        Self::from_schema_str(&raw)
    }

    /// Compile a schema given its JSON source.
    pub fn from_schema_str(json: &str) -> Result<Self, VaultSourceError> {
        let schema_value: Value =
            serde_json::from_str(json).map_err(|e| VaultSourceError::EmbeddedMetadataInvalid {
                extracted_root: PathBuf::new(),
                schema_version: "unknown".into(),
                errors: vec![format!("schema parse: {e}")],
            })?;
        let validator = jsonschema::options().build(&schema_value).map_err(|e| {
            VaultSourceError::EmbeddedMetadataInvalid {
                extracted_root: PathBuf::new(),
                schema_version: "unknown".into(),
                errors: vec![format!("schema compile: {e}")],
            }
        })?;
        Ok(Self { validator })
    }

    /// Validate an instance JSON value against the schema.
    pub fn validate(
        &self,
        instance: &Value,
        extracted_root: &Path,
    ) -> Result<(), VaultSourceError> {
        let errors: Vec<String> = self
            .validator
            .iter_errors(instance)
            .map(|e| format!("{}: {}", e.instance_path(), e))
            .collect();
        if !errors.is_empty() {
            let schema_version = instance
                .get("schema_version")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            return Err(VaultSourceError::EmbeddedMetadataInvalid {
                extracted_root: extracted_root.to_path_buf(),
                schema_version,
                errors,
            });
        }
        Ok(())
    }
}

/// Read and validate the `_vault/metadata.json` file at the root of the
/// extracted tree.
///
/// This is the **first** file the adapter reads post-extraction *(Contract:
/// §Extraction → §Cross-checking via Embedded Metadata)*.
pub fn read_and_validate(
    extracted_root: &Path,
    schema: &EmbeddedSchema,
    artifact_sha256: &str,
) -> Result<EmbeddedMetadata, VaultSourceError> {
    let path = extracted_root.join("_vault").join("metadata.json");
    let raw =
        std::fs::read_to_string(&path).map_err(|_| VaultSourceError::EmbeddedMetadataMissing {
            extracted_root: extracted_root.to_path_buf(),
            artifact_sha256: artifact_sha256.to_string(),
        })?;
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| VaultSourceError::EmbeddedMetadataInvalid {
            extracted_root: extracted_root.to_path_buf(),
            schema_version: "unknown".into(),
            errors: vec![format!("json parse: {e}")],
        })?;
    schema.validate(&value, extracted_root)?;
    let schema_version = value
        .get("schema_version")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Ok(EmbeddedMetadata {
        schema_version,
        raw: value,
    })
}

/// Cross-check selected fields of [`EmbeddedMetadata`] against the catalog.
///
/// Returns either an [`Ok`] outcome (with possibly nonempty `findings`) or
/// an [`Err`] when the tolerance is exceeded.
pub fn cross_check(
    embedded: &EmbeddedMetadata,
    catalog_candidate: &ReleaseCandidate,
    catalog_work_identifiers: &[ExternalId],
    catalog_artifact_original_sha256: Option<&str>,
    resolved_role: &str,
    tolerance: &CrossCheckTolerance,
) -> Result<CrossCheckOutcome, VaultSourceError> {
    let mut findings = Vec::new();

    // Pick the embedded "release" entry that best matches the resolved
    // role. If a single embedded release exists, we use it directly; if
    // multiple, we prefer the one with matching role.
    let releases = embedded
        .raw
        .get("releases")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let embedded_release = if releases.len() == 1 {
        Some(releases[0].clone())
    } else {
        releases
            .iter()
            .find(|r| r.get("role").and_then(|v| v.as_str()) == Some(resolved_role))
            .cloned()
            .or_else(|| releases.first().cloned())
    };

    if let Some(release) = embedded_release.as_ref() {
        // Work identifiers: at least one must intersect the catalog.
        if let Some(work) = release.get("work") {
            let embedded_identifiers: Vec<(String, String, String)> = work
                .get("identifiers")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            let s = item.get("source").and_then(|v| v.as_str())?.to_string();
                            let k = item.get("kind").and_then(|v| v.as_str())?.to_string();
                            let v = item.get("value").and_then(|v| v.as_str())?.to_string();
                            Some((s, k, v))
                        })
                        .collect()
                })
                .unwrap_or_default();

            let catalog_set: std::collections::HashSet<(String, String, String)> =
                catalog_work_identifiers
                    .iter()
                    .map(|id| (id.source.clone(), id.kind.clone(), id.value.clone()))
                    .collect();
            let embedded_set: std::collections::HashSet<(String, String, String)> =
                embedded_identifiers.iter().cloned().collect();

            let intersection: Vec<_> = embedded_set.intersection(&catalog_set).cloned().collect();
            if !embedded_set.is_empty() && !catalog_set.is_empty() && intersection.is_empty() {
                return Err(VaultSourceError::CatalogEmbeddedMismatch {
                    entity_type: "work".into(),
                    entity_id: catalog_candidate.work_id,
                    field: "identifiers".into(),
                    catalog_value: serde_json::to_value(catalog_work_identifiers_json(
                        catalog_work_identifiers,
                    ))
                    .unwrap_or(Value::Null),
                    embedded_value: serde_json::to_value(embedded_identifiers_json(
                        &embedded_identifiers,
                    ))
                    .unwrap_or(Value::Null),
                });
            }
        }

        // Platforms.
        let embedded_platforms: Vec<String> = release
            .get("platforms")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        if !sets_overlap(&embedded_platforms, &catalog_candidate.platforms) {
            let finding = CrossCheckFinding {
                entity_type: "release".into(),
                entity_id: catalog_candidate.release_id,
                field: "platforms".into(),
                catalog_value: serde_json::to_value(&catalog_candidate.platforms)
                    .unwrap_or(Value::Null),
                embedded_value: serde_json::to_value(&embedded_platforms).unwrap_or(Value::Null),
                source: "vault:embedded",
                evidence: "direct_observation",
            };
            if tolerance.strict_platforms {
                return Err(VaultSourceError::CatalogEmbeddedMismatch {
                    entity_type: finding.entity_type.clone(),
                    entity_id: finding.entity_id,
                    field: finding.field.clone(),
                    catalog_value: finding.catalog_value.clone(),
                    embedded_value: finding.embedded_value.clone(),
                });
            }
            findings.push(finding);
        }

        // Languages.
        let embedded_languages: Vec<String> = release
            .get("languages")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        if !sets_overlap(&embedded_languages, &catalog_candidate.languages) {
            let finding = CrossCheckFinding {
                entity_type: "release".into(),
                entity_id: catalog_candidate.release_id,
                field: "languages".into(),
                catalog_value: serde_json::to_value(&catalog_candidate.languages)
                    .unwrap_or(Value::Null),
                embedded_value: serde_json::to_value(&embedded_languages).unwrap_or(Value::Null),
                source: "vault:embedded",
                evidence: "direct_observation",
            };
            if tolerance.strict_languages {
                return Err(VaultSourceError::CatalogEmbeddedMismatch {
                    entity_type: finding.entity_type.clone(),
                    entity_id: finding.entity_id,
                    field: finding.field.clone(),
                    catalog_value: finding.catalog_value.clone(),
                    embedded_value: finding.embedded_value.clone(),
                });
            }
            findings.push(finding);
        }

        // Role.
        let embedded_role = release.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if !embedded_role.is_empty() && embedded_role != resolved_role {
            let finding = CrossCheckFinding {
                entity_type: "artifact".into(),
                entity_id: catalog_candidate.release_id,
                field: "role".into(),
                catalog_value: Value::String(resolved_role.to_string()),
                embedded_value: Value::String(embedded_role.to_string()),
                source: "vault:embedded",
                evidence: "direct_observation",
            };
            if tolerance.strict_role {
                return Err(VaultSourceError::CatalogEmbeddedMismatch {
                    entity_type: finding.entity_type.clone(),
                    entity_id: finding.entity_id,
                    field: finding.field.clone(),
                    catalog_value: finding.catalog_value.clone(),
                    embedded_value: finding.embedded_value.clone(),
                });
            }
            findings.push(finding);
        }
    }

    // vault_artifact.original_sha256
    let embedded_orig_sha = embedded
        .raw
        .get("vault_artifact")
        .and_then(|v| v.get("original_sha256"))
        .and_then(|v| v.as_str());
    if let (Some(cat), Some(emb)) = (catalog_artifact_original_sha256, embedded_orig_sha)
        && cat != emb
    {
        findings.push(CrossCheckFinding {
            entity_type: "artifact".into(),
            entity_id: catalog_candidate.release_id,
            field: "original_sha256".into(),
            catalog_value: Value::String(cat.to_string()),
            embedded_value: Value::String(emb.to_string()),
            source: "vault:embedded",
            evidence: "direct_observation",
        });
    }

    Ok(CrossCheckOutcome { findings })
}

fn sets_overlap<A: AsRef<str>, B: AsRef<str>>(a: &[A], b: &[B]) -> bool {
    if a.is_empty() && b.is_empty() {
        return true;
    }
    if a.is_empty() || b.is_empty() {
        // The contract reads "catalog is the integrated truth", so an
        // empty embedded set against a non-empty catalog set is a finding
        // not a fatal mismatch. We treat as overlap-failure to allow the
        // finding to be emitted.
        return false;
    }
    for x in a {
        for y in b {
            if x.as_ref() == y.as_ref() {
                return true;
            }
        }
    }
    false
}

fn catalog_work_identifiers_json(ids: &[ExternalId]) -> Vec<serde_json::Value> {
    ids.iter()
        .map(|i| {
            serde_json::json!({
                "source": i.source,
                "kind": i.kind,
                "value": i.value,
            })
        })
        .collect()
}

fn embedded_identifiers_json(ids: &[(String, String, String)]) -> Vec<serde_json::Value> {
    ids.iter()
        .map(|(s, k, v)| {
            serde_json::json!({
                "source": s,
                "kind": k,
                "value": v,
            })
        })
        .collect()
}

/// Minimal serde-side shape for what the contract calls the "vault_artifact"
/// section. Used by call-sites that prefer struct access to JSON pointers.
#[derive(Debug, Clone, Deserialize)]
pub struct VaultArtifactSection {
    /// `artifacts.original_sha256`.
    pub original_sha256: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIVIAL_SCHEMA: &str = r#"{
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["schema_version"],
        "properties": {
            "schema_version": { "const": "1.0" }
        }
    }"#;

    #[test]
    fn compiles_a_draft_2020_12_schema() {
        let s = EmbeddedSchema::from_schema_str(TRIVIAL_SCHEMA).unwrap();
        let ok = serde_json::json!({"schema_version": "1.0"});
        s.validate(&ok, Path::new("/tmp")).unwrap();
    }

    #[test]
    fn rejects_instance_that_does_not_match_schema() {
        let s = EmbeddedSchema::from_schema_str(TRIVIAL_SCHEMA).unwrap();
        let bad = serde_json::json!({"schema_version": "2.0"});
        let err = s.validate(&bad, Path::new("/tmp")).unwrap_err();
        assert!(matches!(
            err,
            VaultSourceError::EmbeddedMetadataInvalid { .. }
        ));
    }
}
