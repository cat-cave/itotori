use std::collections::BTreeSet;
use std::path::Path;

use thiserror::Error;

use crate::model::{
    CapabilityClaim, Catalog, Check, Corpus, Inventory, Lane, Plan, PlanProof, PlanRequirement,
    Proof, Receipt, ReceiptDocument, ReceiptProof, ReceiptProofState,
};

const CATALOG_SCHEMA: &str = "engine/v1";
const INVENTORY_SCHEMA: &str = "inventory/v1";
const LANE_SCHEMA: &str = "lane/v1";
const PLAN_SCHEMA: &str = "plan/v1";
const RECEIPT_SCHEMA: &str = "receipt/v1";

/// Typed failures while decoding an inactive contract document.
#[derive(Debug, Error)]
pub enum ContractParseError {
    /// A TOML document was syntactically malformed or had the wrong shape.
    #[error("TOML contract parse failed: {0}")]
    Toml(#[from] toml::de::Error),
    /// A JSON document was syntactically malformed or had the wrong shape.
    #[error("JSON contract parse failed: {0}")]
    Json(#[from] serde_json::Error),
    /// A document named an unsupported schema version.
    #[error("expected schema `{expected}`, found `{actual}")]
    SchemaVersion {
        /// Expected version marker.
        expected: &'static str,
        /// Version marker supplied by the document.
        actual: String,
    },
    /// An opaque identifier did not have the required role-shaped form.
    #[error("invalid {role} id `{id}")]
    Identifier {
        /// Role-specific required prefix.
        role: &'static str,
        /// Invalid supplied identifier.
        id: String,
    },
    /// A declared capability lacked a proof or check that covers it.
    #[error("claimed capability `{capability}` has no covered proof or check")]
    UncoveredCapability {
        /// Claimed capability without coverage.
        capability: String,
    },
    /// A plugin path could escape the installed plugin directory.
    #[error("plugin path must be installed-relative: `{0}")]
    PluginPath(String),
    /// A corpus path escaped the operator-owned media mount.
    #[error(
        "corpus relative_path must be a non-empty mount-relative path without parent traversal: `{0}"
    )]
    CorpusRelativePath(String),
    /// A content address omitted the required digest namespace.
    #[error("content address must start with `sha256:`: `{0}")]
    ContentAddress(String),
    /// A receipt omitted the assertion count for an executed proof state.
    #[error("receipt proof `{0}` reached execution without assertion_count")]
    AssertionCount(String),
}

/// Parse and validate a committed engine descriptor TOML document.
pub fn parse_catalog(input: &str) -> Result<Catalog, ContractParseError> {
    let catalog: Catalog = toml::from_str(input)?;
    require_schema(&catalog.schema, CATALOG_SCHEMA)?;
    require_id("engine", &catalog.id)?;
    validate_plugin_path(&catalog.plugin)?;
    validate_catalog_entries(&catalog)?;
    Ok(catalog)
}

/// Parse and validate a private inventory TOML document.
pub fn parse_inventory(input: &str) -> Result<Inventory, ContractParseError> {
    let inventory: Inventory = toml::from_str(input)?;
    require_schema(&inventory.schema, INVENTORY_SCHEMA)?;
    for corpus in &inventory.corpus {
        validate_corpus(corpus)?;
    }
    Ok(inventory)
}

/// Parse and validate a lane TOML document.
pub fn parse_lane(input: &str) -> Result<Lane, ContractParseError> {
    let lane: Lane = toml::from_str(input)?;
    require_schema(&lane.schema, LANE_SCHEMA)?;
    require_id("lane", &lane.id)?;
    Ok(lane)
}

/// Parse and validate a content-free plan JSON document.
pub fn parse_plan(input: &str) -> Result<Plan, ContractParseError> {
    let plan: Plan = serde_json::from_str(input)?;
    require_schema(&plan.schema, PLAN_SCHEMA)?;
    require_id("plan", &plan.id)?;
    require_id("lane", &plan.lane)?;
    for requirement in &plan.requirements {
        validate_plan_requirement(requirement)?;
    }
    for proof in &plan.proofs {
        validate_plan_proof(proof)?;
    }
    Ok(plan)
}

/// Parse a receipt JSON document, or explicitly preserve its absence.
pub fn parse_receipt(input: Option<&str>) -> Result<ReceiptDocument, ContractParseError> {
    let Some(input) = input else {
        return Ok(ReceiptDocument::Missing);
    };
    let receipt: Receipt = serde_json::from_str(input)?;
    require_schema(&receipt.schema, RECEIPT_SCHEMA)?;
    require_id("plan", &receipt.plan_id)?;
    require_id("run", &receipt.run_id)?;
    for proof in &receipt.proofs {
        validate_receipt_proof(proof)?;
    }
    Ok(ReceiptDocument::Present(receipt))
}

fn require_schema(actual: &str, expected: &'static str) -> Result<(), ContractParseError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ContractParseError::SchemaVersion {
            expected,
            actual: actual.to_owned(),
        })
    }
}

fn require_id(role: &'static str, id: &str) -> Result<(), ContractParseError> {
    let required_prefix = format!("{role}-");
    let valid_tail = id
        .strip_prefix(required_prefix.as_str())
        .is_some_and(|tail| !tail.is_empty() && tail.bytes().all(is_id_byte));
    if valid_tail {
        Ok(())
    } else {
        Err(ContractParseError::Identifier {
            role,
            id: id.to_owned(),
        })
    }
}

fn is_id_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
}

fn validate_plugin_path(path: &str) -> Result<(), ContractParseError> {
    let plugin_path = Path::new(path);
    if plugin_path.is_absolute() || path.split('/').any(|segment| segment == "..") {
        Err(ContractParseError::PluginPath(path.to_owned()))
    } else {
        Ok(())
    }
}

fn validate_catalog_entries(catalog: &Catalog) -> Result<(), ContractParseError> {
    let mut coverage = BTreeSet::new();
    for proof in &catalog.proof {
        validate_proof(proof)?;
        coverage.extend(proof.covers.iter().cloned());
    }
    for check in &catalog.check {
        validate_check(check)?;
        coverage.extend(check.covers.iter().cloned());
    }
    for (capability, claim) in &catalog.capabilities {
        if *claim != CapabilityClaim::NotClaimed && !coverage.contains(capability) {
            return Err(ContractParseError::UncoveredCapability {
                capability: capability.clone(),
            });
        }
    }
    Ok(())
}

fn validate_proof(proof: &Proof) -> Result<(), ContractParseError> {
    require_id("proof", &proof.id)?;
    require_id("lane", &proof.lane)?;
    Ok(())
}

fn validate_check(check: &Check) -> Result<(), ContractParseError> {
    require_id("check", &check.id)?;
    require_id("lane", &check.lane)?;
    Ok(())
}

fn validate_corpus(corpus: &Corpus) -> Result<(), ContractParseError> {
    require_id("corpus", &corpus.id)?;
    require_id("engine", &corpus.engine)?;
    require_id("variant", &corpus.variant)?;
    let relative = Path::new(&corpus.relative_path);
    if corpus.relative_path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ContractParseError::CorpusRelativePath(
            corpus.relative_path.clone(),
        ));
    }
    if corpus.content_address.starts_with("sha256:") {
        Ok(())
    } else {
        Err(ContractParseError::ContentAddress(
            corpus.content_address.clone(),
        ))
    }
}

fn validate_plan_requirement(requirement: &PlanRequirement) -> Result<(), ContractParseError> {
    require_id("requirement", &requirement.id)
}

fn validate_plan_proof(proof: &PlanProof) -> Result<(), ContractParseError> {
    require_id("proof", &proof.id)?;
    require_id("engine", &proof.engine)?;
    for corpus in &proof.corpora {
        require_id("corpus", corpus)?;
    }
    Ok(())
}

fn validate_receipt_proof(proof: &ReceiptProof) -> Result<(), ContractParseError> {
    require_id("proof", &proof.id)?;
    if matches!(
        proof.state,
        ReceiptProofState::Executed | ReceiptProofState::Passed | ReceiptProofState::Failed
    ) && proof.assertion_count.is_none()
    {
        return Err(ContractParseError::AssertionCount(proof.id.clone()));
    }
    Ok(())
}
