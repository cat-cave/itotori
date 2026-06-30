//! In-memory `v_facts_needs_review`-shaped finding records.
//!
//! The adapter never writes to `catalog.db`; findings are returned in
//! [`crate::source::MaterializeResult::findings`] for the caller (Kaifuu or
//! the itotori findings sink) to route to vault-curation.

use serde::Serialize;
use serde_json::Value;

/// A cross-check finding shaped like a `v_facts_needs_review` row
/// *(Contract: §Cross-checking via Embedded Metadata)*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CrossCheckFinding {
    /// `work` | `release` | `artifact`.
    pub entity_type: String,
    /// Catalog row id.
    pub entity_id: i64,
    /// Field that disagreed (e.g. `languages`, `platforms`, `role`,
    /// `original_sha256`).
    pub field: String,
    /// What the catalog said.
    pub catalog_value: Value,
    /// What the embedded metadata said.
    pub embedded_value: Value,
    /// Always `"vault:embedded"` for this adapter.
    pub source: &'static str,
    /// Always `"direct_observation"` for this adapter.
    pub evidence: &'static str,
}
