//! `_vault/metadata.json` parser and the by-id identity cross-checker.
//! The by-id content store embeds the vault-curation *canonical* metadata
//! document at `<canonical_id>/_vault/metadata.json` (top-level
//! `canonical_id`, `identifiers`, `engine`, `work`, `release`,...). This is
//! the by-id-era shape produced by vault-curation's stage-2 repack. It is
//! validated against `docs/itotori-vault-by-id-metadata.schema.json` before
//! any identity fields are consumed.
//! Identity is established by:
//! 1. **`canonical_id`** — the embedded `canonical_id` must equal the catalog
//!    `artifacts.canonical_id` the by-id path was resolved from. This is the
//!    load-bearing identity gate.
//! 2. **work identifiers** — the embedded `identifiers` must intersect the
//!    catalog's `identifiers` for the resolved work (at least one external id
//!    must agree).
//!    `engine` and `languages` disagreements are surfaced as non-fatal findings
//!    (the catalog is the integrated truth). Byte-fidelity is a per-game-file
//!    concern (e.g. the extracted `Seen.txt` sha256), never the archive sha.

use std::path::Path;
use std::sync::OnceLock;

use serde_json::Value;

use crate::discovery::ReleaseCandidate;
use crate::error::VaultSourceError;
use crate::findings::CrossCheckFinding;
use crate::paths::ExternalId;

/// Repository-relative location of the authoritative by-id sidecar schema.
pub const BY_ID_METADATA_SCHEMA_PATH: &str = "docs/itotori-vault-by-id-metadata.schema.json";

const BY_ID_METADATA_SCHEMA_JSON: &str =
    include_str!("../../../docs/itotori-vault-by-id-metadata.schema.json");

static BY_ID_METADATA_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();

/// Caller-facing tolerance for cross-check disagreements.
/// Contract default: reject mismatched identity (`canonical_id`, work
/// identifiers) always; accept everything else with a finding.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CrossCheckTolerance {
    /// When `true`, a languages-disjoint disagreement promotes to error.
    pub strict_languages: bool,
    /// When `true`, an engine disagreement promotes to error.
    pub strict_engine: bool,
}

impl CrossCheckTolerance {
    /// Strict mode: every catalog/embedded disagreement becomes an error.
    pub fn strict() -> Self {
        Self {
            strict_languages: true,
            strict_engine: true,
        }
    }
}

/// Outcome of a cross-check call.
#[derive(Debug, Clone)]
pub struct CrossCheckOutcome {
    /// Non-fatal disagreements; surfaced for the caller's findings sink.
    pub findings: Vec<CrossCheckFinding>,
}

/// Embedded by-id metadata after parsing and identity-field extraction.
#[derive(Debug, Clone)]
pub struct EmbeddedMetadata {
    /// Top-level `canonical_id` (the by-id identity).
    pub canonical_id: Option<String>,
    /// `engine` (e.g. `"reallive"`).
    pub engine: Option<String>,
    /// `work.canonical_title`.
    pub canonical_title: Option<String>,
    /// `identifiers` as `(source, kind, value)` tuples.
    pub identifiers: Vec<(String, String, String)>,
    /// `languages.language_code` values.
    pub languages: Vec<String>,
    /// Raw parsed JSON for downstream inspection.
    pub raw: Value,
}

/// Read and parse the `_vault/metadata.json` file at the root of the extracted
/// by-id tree (the `<canonical_id>/` wrapper directory).
/// This is the **first** file the adapter reads post-extraction. It must be
/// present, parse as JSON, and carry a non-empty top-level `canonical_id`.
pub fn read_embedded_metadata(
    tree_root: &Path,
    canonical_id: &str,
) -> Result<EmbeddedMetadata, VaultSourceError> {
    let path = tree_root.join("_vault").join("metadata.json");
    let raw =
        std::fs::read_to_string(&path).map_err(|_| VaultSourceError::EmbeddedMetadataMissing {
            tree_root: tree_root.to_path_buf(),
            canonical_id: canonical_id.to_string(),
        })?;
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| VaultSourceError::EmbeddedMetadataInvalid {
            tree_root: tree_root.to_path_buf(),
            canonical_id: canonical_id.to_string(),
            errors: vec![format!("json parse: {e}")],
        })?;

    let embedded_canonical_id = value
        .get("canonical_id")
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string);
    if embedded_canonical_id.as_deref().is_none_or(str::is_empty) {
        return Err(VaultSourceError::EmbeddedMetadataInvalid {
            tree_root: tree_root.to_path_buf(),
            canonical_id: canonical_id.to_string(),
            errors: vec!["_vault/metadata.json has no non-empty top-level canonical_id".into()],
        });
    }

    let identifiers =
        parse_identifiers(&value).map_err(|error| VaultSourceError::EmbeddedMetadataInvalid {
            tree_root: tree_root.to_path_buf(),
            canonical_id: canonical_id.to_string(),
            errors: vec![error],
        })?;

    let languages =
        parse_languages(&value).map_err(|error| VaultSourceError::EmbeddedMetadataInvalid {
            tree_root: tree_root.to_path_buf(),
            canonical_id: canonical_id.to_string(),
            errors: vec![error],
        })?;

    if let Err(errors) = validate_by_id_metadata(&value) {
        return Err(VaultSourceError::EmbeddedMetadataInvalid {
            tree_root: tree_root.to_path_buf(),
            canonical_id: canonical_id.to_string(),
            errors,
        });
    }

    let engine = value
        .get("engine")
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string);
    let canonical_title = value
        .get("work")
        .and_then(|w| w.get("canonical_title"))
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string);

    Ok(EmbeddedMetadata {
        canonical_id: embedded_canonical_id,
        engine,
        canonical_title,
        identifiers,
        languages,
        raw: value,
    })
}

/// Extract identifiers without allowing a malformed array member to bypass
/// identity gate 2 by being dropped. A missing array is tolerated because the
/// catalog may be the only side to declare this optional embedded fact.
fn parse_identifiers(value: &Value) -> Result<Vec<(String, String, String)>, String> {
    let Some(value) = value.get("identifiers") else {
        return Ok(Vec::new());
    };
    let Some(entries) = value.as_array() else {
        return Err("identifiers must be an array when present".into());
    };

    entries
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let object = item
                .as_object()
                .ok_or_else(|| format!("identifiers[{index}] must be an object"))?;
            let source = object
                .get("source")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("identifiers[{index}].source must be a string"))?;
            let kind = object
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("identifiers[{index}].kind must be a string"))?;
            let identifier_value = object
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("identifiers[{index}].value must be a string"))?;
            Ok((
                source.to_string(),
                kind.to_string(),
                identifier_value.to_string(),
            ))
        })
        .collect()
}

/// Extract language codes without silently dropping malformed entries. A
/// missing array is tolerated for consistency with absent identifiers.
fn parse_languages(value: &Value) -> Result<Vec<String>, String> {
    let Some(value) = value.get("languages") else {
        return Ok(Vec::new());
    };
    let Some(entries) = value.as_array() else {
        return Err("languages must be an array when present".into());
    };

    entries
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.as_object()
                .and_then(|object| object.get("language_code"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("languages[{index}].language_code must be a string"))
        })
        .collect()
}

fn validate_by_id_metadata(value: &Value) -> Result<(), Vec<String>> {
    let validator = match BY_ID_METADATA_VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(BY_ID_METADATA_SCHEMA_JSON)
            .map_err(|error| format!("parse {BY_ID_METADATA_SCHEMA_PATH}: {error}"))?;
        jsonschema::draft202012::new(&schema)
            .map_err(|error| format!("compile {BY_ID_METADATA_SCHEMA_PATH}: {error}"))
    }) {
        Ok(validator) => validator,
        Err(error) => return Err(vec![error.clone()]),
    };

    let errors: Vec<String> = validator
        .iter_errors(value)
        .map(|error| format!("{}: {error}", error.instance_path()))
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Cross-check the embedded by-id metadata's identity against the catalog.
/// Returns either an [`Ok`] outcome (with possibly nonempty `findings`) or an
/// [`Err`] when an identity gate fails (or a softer disagreement is promoted
/// to error by `tolerance`).
pub fn cross_check(
    embedded: &EmbeddedMetadata,
    catalog_candidate: &ReleaseCandidate,
    catalog_work_identifiers: &[ExternalId],
    resolved_canonical_id: &str,
    tolerance: &CrossCheckTolerance,
) -> Result<CrossCheckOutcome, VaultSourceError> {
    let mut findings = Vec::new();

    // Identity gate 1: canonical_id must match the catalog id the by-id path
    // was resolved from. This is the by-id replacement for archive-sha
    // identity.
    if let Some(emb_id) = embedded.canonical_id.as_deref()
        && emb_id != resolved_canonical_id
    {
        return Err(VaultSourceError::CatalogEmbeddedMismatch {
            entity_type: "artifact".into(),
            entity_id: catalog_candidate.release_id,
            field: "canonical_id".into(),
            catalog_value: Value::String(resolved_canonical_id.to_string()),
            embedded_value: Value::String(emb_id.to_string()),
        });
    }

    // Identity gate 2: work identifiers must intersect (at least one external
    // id must agree) when both sides declare identifiers.
    let catalog_set: std::collections::HashSet<(String, String, String)> = catalog_work_identifiers
        .iter()
        .map(|id| (id.source.clone(), id.kind.clone(), id.value.clone()))
        .collect();
    let embedded_set: std::collections::HashSet<(String, String, String)> =
        embedded.identifiers.iter().cloned().collect();
    let intersects = embedded_set.intersection(&catalog_set).next().is_some();
    if !embedded_set.is_empty() && !catalog_set.is_empty() && !intersects {
        return Err(VaultSourceError::CatalogEmbeddedMismatch {
            entity_type: "work".into(),
            entity_id: catalog_candidate.work_id,
            field: "identifiers".into(),
            catalog_value: serde_json::to_value(catalog_work_identifiers_json(
                catalog_work_identifiers,
            ))
            .unwrap_or(Value::Null),
            embedded_value: serde_json::to_value(embedded_identifiers_json(&embedded.identifiers))
                .unwrap_or(Value::Null),
        });
    }

    // Soft check: languages overlap.
    if !embedded.languages.is_empty()
        && !catalog_candidate.languages.is_empty()
        && !sets_overlap(&embedded.languages, &catalog_candidate.languages)
    {
        let finding = CrossCheckFinding {
            entity_type: "release".into(),
            entity_id: catalog_candidate.release_id,
            field: "languages".into(),
            catalog_value: serde_json::to_value(&catalog_candidate.languages)
                .unwrap_or(Value::Null),
            embedded_value: serde_json::to_value(&embedded.languages).unwrap_or(Value::Null),
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

    // Soft check: engine agreement (when the catalog knows an engine).
    if let (Some(emb_engine), Some(cat_engine)) = (
        embedded.engine.as_deref(),
        catalog_candidate.engine.as_deref(),
    ) && emb_engine != cat_engine
    {
        let finding = CrossCheckFinding {
            entity_type: "release".into(),
            entity_id: catalog_candidate.release_id,
            field: "engine".into(),
            catalog_value: Value::String(cat_engine.to_string()),
            embedded_value: Value::String(emb_engine.to_string()),
            source: "vault:embedded",
            evidence: "direct_observation",
        };
        if tolerance.strict_engine {
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

    Ok(CrossCheckOutcome { findings })
}

fn sets_overlap<A: AsRef<str>, B: AsRef<str>>(a: &[A], b: &[B]) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate_stub() -> ReleaseCandidate {
        ReleaseCandidate {
            release_id: 42,
            work_id: 7,
            edition_name: None,
            release_date: None,
            store: None,
            engine: None,
            engine_version: None,
            engine_needs_review: false,
            languages: vec!["ja".into()],
            platforms: vec!["windows".into()],
        }
    }

    fn embedded_with(canonical_id: &str, ids: &[(&str, &str, &str)]) -> EmbeddedMetadata {
        EmbeddedMetadata {
            canonical_id: Some(canonical_id.to_string()),
            engine: Some("reallive".into()),
            canonical_title: Some("X".into()),
            identifiers: ids
                .iter()
                .map(|(s, k, v)| (s.to_string(), k.to_string(), v.to_string()))
                .collect(),
            languages: vec!["ja".into()],
            raw: Value::Null,
        }
    }

    #[test]
    fn rejects_canonical_id_mismatch_as_identity_failure() {
        let embedded = embedded_with("wrong-id.v1.ja", &[("vndb", "v", "v1234")]);
        let err = cross_check(
            &embedded,
            &candidate_stub(),
            &[ExternalId {
                source: "vndb".into(),
                kind: "v".into(),
                value: "v1234".into(),
            }],
            "right-id.v1.ja",
            &CrossCheckTolerance::default(),
        )
        .expect_err("canonical_id mismatch must fail closed");
        match err {
            VaultSourceError::CatalogEmbeddedMismatch { field, .. } => {
                assert_eq!(field, "canonical_id");
            }
            other => panic!("expected canonical_id mismatch, got {other:?}"),
        }
    }

    #[test]
    fn rejects_disjoint_work_identifiers() {
        let embedded = embedded_with("right-id.v1.ja", &[("vndb", "v", "v9999")]);
        let err = cross_check(
            &embedded,
            &candidate_stub(),
            &[ExternalId {
                source: "vndb".into(),
                kind: "v".into(),
                value: "v1234".into(),
            }],
            "right-id.v1.ja",
            &CrossCheckTolerance::default(),
        )
        .expect_err("disjoint identifiers must fail closed");
        match err {
            VaultSourceError::CatalogEmbeddedMismatch {
                field, entity_type, ..
            } => {
                assert_eq!(entity_type, "work");
                assert_eq!(field, "identifiers");
            }
            other => panic!("expected identifiers mismatch, got {other:?}"),
        }
    }

    #[test]
    fn accepts_matching_identity_with_no_findings() {
        let embedded = embedded_with("right-id.v1.ja", &[("vndb", "v", "v1234")]);
        let outcome = cross_check(
            &embedded,
            &candidate_stub(),
            &[ExternalId {
                source: "vndb".into(),
                kind: "v".into(),
                value: "v1234".into(),
            }],
            "right-id.v1.ja",
            &CrossCheckTolerance::default(),
        )
        .unwrap();
        assert!(outcome.findings.is_empty());
    }
}
