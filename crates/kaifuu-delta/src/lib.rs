use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use kaifuu_core::{
    KaifuuResult, deterministic_id, promote_staged_directory_no_clobber, read_json,
    safe_join_relative,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod content_codec;
use content_codec::{
    decode_entry_content, encode_content, require_absent, require_present, sha256_hex,
};

mod snapshot;
use snapshot::{
    file_records, root_hash, snapshot_directory, snapshot_from_records,
    validate_materializable_file_paths, validate_relative_package_path,
};

/// Resolve this crate's manifest directory for locating tracked test fixtures.
/// `env!("CARGO_MANIFEST_DIR")` is baked into the binary at COMPILE time, so a
/// test binary reused from a different (since-removed) worktree points fixture
/// reads at a dead path and fails with an opaque `Os { code: 2, NotFound }`.
/// `cargo test` sets `CARGO_MANIFEST_DIR` in the test binary's RUNTIME
/// environment to the LIVE crate directory of the current invocation; prefer
/// that, falling back to the compile-time constant only when run outside cargo.
/// Lookup only — never writes, so tracked fixtures stay strictly read-only.
#[cfg(test)]
pub(crate) fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

// end-to-end encrypted-XP3 contract scaffolding harness. Lives in
// this crate because it is the only one that can reach both the kaifuu-core
// XP3 contract functions and the delta apply contract.
pub mod contract_scaffold;
pub use contract_scaffold::{
    CONTRACT_SCAFFOLD_STAGES, ContractStage, ContractStageOutcome, ContractStageStatus,
    ENCRYPTED_XP3_CONTRACT_SCAFFOLD_DISCLAIMER, EncryptedXp3ContractScaffoldReport,
    SEMANTIC_CONTRACT_SCAFFOLD_STAGE_DRIFT, run_encrypted_xp3_contract_scaffold,
};

// schema bumped to 0.3.0 to add the required `sourceProvenance`
// envelope that carries the `partial: true` bit forward from the
// originating extract envelope. Apply refuses any package whose
// `sourceProvenance.partial` is true. The 0.2.0 loader is deleted in the
// same change — there is no compatibility shim for packages without
// `sourceProvenance`.
const DELTA_SCHEMA_VERSION: &str = "0.3.0";
const DELTA_FORMAT: &str = "kaifuu-delta-package";
const DELTA_HASH_VERSION: &str = "kaifuu-delta-root-v0.2";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// reason: `delta_package_id` mirrors its `deltaPackageId` serialized key and
// stays name-aligned with the `PartialSourceRefused.delta_package_id` error
// field that carries the same id; renaming to `package_id` would desync the
// wire contract and the mirrored id field.
#[allow(clippy::struct_field_names)]
struct DeltaPackage {
    schema_version: String,
    delta_package_id: String,
    format: String,
    metadata: DeltaMetadata,
    source_provenance: SourceProvenance,
    source_compatibility: SourceCompatibility,
    target: TargetManifest,
    changed_entries: Vec<ChangedEntry>,
}

/// carries the partial provenance bit forward from the source
/// extract envelope through diff into apply. `partial` is required — there
/// is no schema-level fallback to "assume complete" because forgetting the
/// field is exactly the audit P1 failure mode. Apply refuses any
/// package with `partial == true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProvenance {
    pub partial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_report_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_diagnostic_count: Option<u32>,
}

impl SourceProvenance {
    /// A package whose source extract was a fully-detected (complete)
    /// envelope. This is the path taken by `kaifuu diff` without
    /// `--source-extract`, and by `kaifuu diff --source-extract <path>`
    /// where the envelope is a regular bridge (PatchExport) with no
    /// `partial` field.
    pub fn complete() -> Self {
        Self {
            partial: false,
            adapter_id: None,
            partial_report_id: None,
            blocking_diagnostic_count: None,
        }
    }

    /// Read an extract envelope JSON file and derive the provenance. If the
    /// envelope carries `partial: true` (the PartialAdapterReport
    /// shape) the resulting provenance is marked partial and carries the
    /// adapter id / report id / blocking diagnostic count forward for
    /// debugging. A *missing* `partial` field (e.g. a regular bridge
    /// envelope) is treated as complete. A *present-but-non-bool* `partial`
    /// field is a malformed envelope and surfaces a typed
    /// [`MalformedPartialFlag`] error — it must never silently default to
    /// complete, as that would defeat the "apply MUST refuse any
    /// envelope whose `partial` field is true" gate (see `apply_delta`).
    pub fn from_extract_envelope_file(path: &Path) -> KaifuuResult<Self> {
        let envelope: Value = read_json(path)?;
        Self::from_extract_envelope_value(&envelope)
    }

    pub fn from_extract_envelope_value(envelope: &Value) -> KaifuuResult<Self> {
        let partial = match envelope.get("partial") {
            // Absent `partial` field — a regular complete bridge envelope.
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            // Present-but-non-bool (string "true", number 1, etc.): fail
            // closed with a typed error rather than defaulting to complete.
            Some(other) => {
                return Err(Box::new(MalformedPartialFlag {
                    found: other.clone(),
                }));
            }
        };
        if !partial {
            return Ok(Self::complete());
        }
        let adapter_id = envelope
            .get("adapterId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let partial_report_id = envelope
            .get("reportId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let blocking_diagnostic_count = envelope.get("severityCounts").map(|counts| {
            let p0 = counts.get("p0").and_then(Value::as_u64).unwrap_or(0);
            let p1 = counts.get("p1").and_then(Value::as_u64).unwrap_or(0);
            u32::try_from(p0 + p1).unwrap_or(u32::MAX)
        });
        Ok(Self {
            partial: true,
            adapter_id,
            partial_report_id,
            blocking_diagnostic_count,
        })
    }
}

/// Typed error returned when an extract envelope carries a `partial` field
/// that is present but not a JSON boolean (e.g. the string `"true"` or the
/// number `1`). Such an envelope is malformed: silently coercing it to
/// `complete` would let a hand-edited or foreign envelope slip past the
/// partial-source refusal gate, so it fails closed here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedPartialFlag {
    /// The non-boolean value found at the envelope's `partial` key.
    pub found: Value,
}

impl fmt::Display for MalformedPartialFlag {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "kaifuu.delta.malformed_partial_flag: extract envelope `partial` field must be a JSON boolean, found {}",
            self.found,
        )
    }
}

impl std::error::Error for MalformedPartialFlag {}

/// typed error returned by `apply_delta` when a package's source
/// extract carried `partial: true`. Apply must refuse — the documented
/// contract is "apply MUST refuse any envelope whose `partial`
/// field is true" and the delta is the carrier through which that
/// provenance reaches apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialSourceRefused {
    pub delta_package_id: String,
    pub adapter_id: Option<String>,
    pub partial_report_id: Option<String>,
    pub blocking_diagnostic_count: Option<u32>,
}

impl fmt::Display for PartialSourceRefused {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "kaifuu.delta.partial_source_refused: delta package {} carries sourceProvenance.partial=true",
            self.delta_package_id,
        )?;
        if let Some(adapter_id) = &self.adapter_id {
            write!(formatter, "; adapterId={adapter_id}")?;
        }
        if let Some(report_id) = &self.partial_report_id {
            write!(formatter, "; partialReportId={report_id}")?;
        }
        if let Some(blocking) = self.blocking_diagnostic_count {
            write!(formatter, "; blockingDiagnosticCount={blocking}")?;
        }
        Ok(())
    }
}

impl std::error::Error for PartialSourceRefused {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeltaMetadata {
    generator: String,
    hash_algorithm: String,
    path_encoding: String,
    content_encodings: Vec<String>,
    ignored_artifacts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceCompatibility {
    root_hash: String,
    file_count: u64,
    byte_count: u64,
    files: Vec<FileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetManifest {
    root_hash: String,
    file_count: u64,
    byte_count: u64,
    files: Vec<FileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRecord {
    path: String,
    hash: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangedEntry {
    path: String,
    operation: DeltaOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_encoding: Option<ContentEncoding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DeltaOperation {
    Add,
    Replace,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ContentEncoding {
    Utf8,
    Hex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileSnapshot {
    path: String,
    hash: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectorySnapshot {
    root_hash: String,
    byte_count: u64,
    files: BTreeMap<String, FileSnapshot>,
}

#[path = "lib/apply.rs"]
mod apply;
#[path = "lib/create.rs"]
mod create;

pub use apply::apply_delta;
pub use create::{Replacement, create_delta, create_replacement_delta};

fn validate_package_shape(package: &DeltaPackage) -> KaifuuResult<()> {
    if package.schema_version != DELTA_SCHEMA_VERSION {
        return Err(format!(
            "unsupported delta schema version {}",
            package.schema_version
        )
        .into());
    }
    if package.format != DELTA_FORMAT {
        return Err(format!("unsupported delta format {}", package.format).into());
    }
    if package.metadata.hash_algorithm != "sha256" {
        return Err("delta package hash algorithm must be sha256".into());
    }
    let mut paths = BTreeSet::new();
    for entry in &package.changed_entries {
        validate_relative_package_path(&entry.path)?;
        if !paths.insert(entry.path.as_str()) {
            return Err(format!(
                "delta package has duplicate changed entry path {}",
                entry.path
            )
            .into());
        }
        match entry.operation {
            DeltaOperation::Add => {
                require_absent(&entry.source_hash, "add entry sourceHash")?;
                require_absent(&entry.source_size_bytes, "add entry sourceSizeBytes")?;
                require_present(&entry.target_hash, "add entry targetHash")?;
                require_present(&entry.target_size_bytes, "add entry targetSizeBytes")?;
                require_present(&entry.content_encoding, "add entry contentEncoding")?;
                require_present(&entry.content, "add entry content")?;
            }
            DeltaOperation::Replace => {
                require_present(&entry.source_hash, "replace entry sourceHash")?;
                require_present(&entry.source_size_bytes, "replace entry sourceSizeBytes")?;
                require_present(&entry.target_hash, "replace entry targetHash")?;
                require_present(&entry.target_size_bytes, "replace entry targetSizeBytes")?;
                require_present(&entry.content_encoding, "replace entry contentEncoding")?;
                require_present(&entry.content, "replace entry content")?;
            }
            DeltaOperation::Delete => {
                require_present(&entry.source_hash, "delete entry sourceHash")?;
                require_present(&entry.source_size_bytes, "delete entry sourceSizeBytes")?;
                require_absent(&entry.target_hash, "delete entry targetHash")?;
                require_absent(&entry.target_size_bytes, "delete entry targetSizeBytes")?;
                require_absent(&entry.content_encoding, "delete entry contentEncoding")?;
                require_absent(&entry.content, "delete entry content")?;
            }
        }
    }
    Ok(())
}

fn allocate_staging_dir(output_dir: &Path) -> KaifuuResult<PathBuf> {
    let parent = output_dir.parent().unwrap_or_else(|| Path::new("."));
    let file_name = output_dir
        .file_name()
        .ok_or("delta output directory must include a final path component")?
        .to_string_lossy();
    fs::create_dir_all(parent)?;
    for attempt in 0_u32..1000 {
        let candidate = parent.join(format!(".{file_name}.tmp-{}-{attempt}", std::process::id()));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err("could not allocate delta staging directory".into())
}

#[cfg(test)]
// reason: same-module test shards each carry the required sibling glob import.
#[allow(unused_imports)]
#[path = "lib/tests.rs"]
mod tests;
