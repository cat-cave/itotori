//! `LocalCorpusSource` trait + the [`VaultSource`] implementor that wires
//! every other module together.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use uuid::Uuid;

use crate::config::{
    RetentionPolicy, ScratchConfig, VaultConfig, resolve_scratch_root, resolve_vault_root,
    validate_vault_root,
};
use crate::discovery::{
    ClaimQuery, ReleaseCandidate, discover, load_canonical_title, load_work_identifiers,
};
use crate::error::VaultSourceError;
use crate::extraction::{ExtractedTree, ScratchPaths, extract_archive};
use crate::findings::{CrossCheckFinding, catalog_bypass_finding};
use crate::metadata::{
    CrossCheckTolerance, EmbeddedMetadata, EmbeddedSchema, cross_check, read_and_validate,
};
use crate::paths::{GameIdContext, derive_game_id};
use crate::resolution::{
    ArtifactSelection, ResolvedArtifact, by_sha_path, resolve_by_sha, resolve_release,
};
use crate::retention::{
    RunOutcome, apply_retention, read_last_artifact_sha, write_last_artifact_sha,
};

/// Capability report a caller can introspect before doing anything.
#[derive(Debug, Clone)]
pub struct LocalCorpusCapabilityReport {
    /// Stable source id; always `"vault"` for [`VaultSource`].
    pub source_id: &'static str,
    /// Canonicalised vault root in use.
    pub vault_root: PathBuf,
    /// Catalog schema version observed.
    pub schema_version: u32,
    /// Roles the resolver knows how to select.
    pub supported_artifact_roles: Vec<String>,
    /// The default retention policy the [`VaultSource`] applies when the
    /// caller does not override it.
    pub retention_policy_default: RetentionPolicy,
    /// Always `true` for the vault-source adapter.
    pub read_only: bool,
    /// Always `true` for the vault-source adapter — callers must wire a
    /// findings sink to surface cross-check disagreements.
    pub findings_sink_required: bool,
}

/// What the caller passes into [`LocalCorpusSource::materialize`].
#[derive(Debug, Clone, Default)]
pub struct MaterializeOptions {
    /// Retention policy for the per-run scratch dir.
    pub retention: RetentionPolicy,
    /// Artifact selection (primary, primary+extras, etc.).
    pub selection: ArtifactSelection,
    /// Cross-check tolerance struct.
    pub tolerance: CrossCheckTolerance,
    /// Caller-supplied run id (e.g. itotori's per-run uuid). When `None`,
    /// the adapter mints a fresh uuid v7.
    pub run_id: Option<String>,
}

/// The result of a successful materialize call.
#[derive(Debug, Clone)]
pub struct MaterializeResult {
    /// Resolved game id (deterministic across runs).
    pub game_id: String,
    /// Run id (per-call; uuid v7 when caller did not supply one).
    pub run_id: String,
    /// `<scratch>/<game-id>/<run-id>/extracted/`.
    pub extracted_root: PathBuf,
    /// `<extracted_root>/<subpath>` when applicable.
    pub subpath_root: Option<PathBuf>,
    /// Validated and parsed embedded metadata.
    pub embedded: EmbeddedMetadata,
    /// Cross-check findings (may be empty).
    pub findings: Vec<CrossCheckFinding>,
    /// The artifact sha256 that was extracted.
    pub artifact_sha256: String,
    /// `releases.id`.
    pub release_id: i64,
    /// All resolved artifacts (the first is the primary).
    pub artifacts: Vec<ResolvedArtifact>,
    /// `true` when the call went through catalog-bypass mode
    /// (`ByArtifactSha`).
    pub catalog_bypass: bool,
    /// Retention policy the materialize call ran under; used by `release`.
    pub retention_policy: RetentionPolicy,
}

/// The trait Kaifuu and Itotori callers depend on.
pub trait LocalCorpusSource: Send + Sync {
    /// Stable source identifier (e.g. `"vault"`).
    fn source_id(&self) -> &'static str;

    /// Discover candidate releases from a claim.
    fn discover(&self, claim: &ClaimQuery) -> Result<Vec<ReleaseCandidate>, VaultSourceError>;

    /// Materialize a candidate into scratch.
    fn materialize(
        &self,
        candidate: &ReleaseCandidate,
        opts: MaterializeOptions,
    ) -> Result<MaterializeResult, VaultSourceError>;

    /// Materialize directly from a sha256 (catalog-bypass mode). The
    /// `MaterializeResult` carries a bypass finding.
    fn materialize_by_sha(
        &self,
        sha256: &str,
        opts: MaterializeOptions,
    ) -> Result<MaterializeResult, VaultSourceError>;

    /// Apply the retention policy after a run. The caller passes the same
    /// result back in for cleanup; the implementation derives the scratch
    /// paths and applies the policy.
    fn release(
        &self,
        materialized: &MaterializeResult,
        outcome: RunOutcome,
    ) -> Result<(), VaultSourceError>;

    /// Capability report for introspection.
    fn capabilities(&self) -> LocalCorpusCapabilityReport;
}

/// In-process registry of local-corpus sources. Multiple sources may be
/// registered (in this slice the only implementor is [`VaultSource`], but
/// future adapters can plug in alongside).
#[derive(Default)]
pub struct LocalCorpusRegistry {
    sources: Vec<Arc<dyn LocalCorpusSource>>,
}

impl LocalCorpusRegistry {
    /// Construct an empty registry.
    pub fn new() -> Self {
        Self {
            sources: Vec::new(),
        }
    }

    /// Register a source. Sources are kept in insertion order.
    pub fn register(&mut self, source: Arc<dyn LocalCorpusSource>) {
        self.sources.push(source);
    }

    /// Resolve a source by id.
    pub fn by_id(&self, id: &str) -> Option<Arc<dyn LocalCorpusSource>> {
        self.sources.iter().find(|s| s.source_id() == id).cloned()
    }

    /// Iterate all registered sources.
    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn LocalCorpusSource>> {
        self.sources.iter()
    }
}

/// The vault-source adapter. Holds resolved vault/scratch roots and a
/// compiled JSON-Schema validator.
pub struct VaultSource {
    vault_root: PathBuf,
    scratch_root: PathBuf,
    schema_version: u32,
    embedded_schema: EmbeddedSchema,
}

impl std::fmt::Debug for VaultSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultSource")
            .field("vault_root", &self.vault_root)
            .field("scratch_root", &self.scratch_root)
            .field("schema_version", &self.schema_version)
            .finish_non_exhaustive()
    }
}

/// Reject a scratch root that is equal to, or nested under, the vault root.
///
/// The vault is read-only; routing writes into it (via a misconfigured
/// `ITOTORI_SCRATCH_ROOT`) is a policy violation, surfaced as a typed
/// [`VaultSourceError::ScratchUnwritable`] rather than silently honoured.
fn reject_scratch_inside_vault(
    vault_root: &Path,
    scratch_root: &Path,
) -> Result<(), VaultSourceError> {
    let vault_canonical = canonicalize_existing_prefix(vault_root);
    let scratch_canonical = canonicalize_existing_prefix(scratch_root);
    if scratch_canonical == vault_canonical || scratch_canonical.starts_with(&vault_canonical) {
        return Err(VaultSourceError::ScratchUnwritable {
            path: scratch_root.to_path_buf(),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "scratch root resolves inside the read-only vault root {}",
                    vault_root.display()
                ),
            ),
        });
    }
    Ok(())
}

/// Canonicalize `path`, tolerating a not-yet-created tail: canonicalize the
/// deepest existing ancestor and re-attach the remaining components. This lets
/// the disjointness check run before the scratch directory exists.
fn canonicalize_existing_prefix(path: &Path) -> PathBuf {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical;
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    loop {
        match cursor.parent() {
            Some(parent) => {
                if let Some(name) = cursor.file_name() {
                    suffix.push(name.to_os_string());
                }
                if let Ok(canonical) = std::fs::canonicalize(parent) {
                    let mut out = canonical;
                    for component in suffix.iter().rev() {
                        out.push(component);
                    }
                    return out;
                }
                cursor = parent;
            }
            None => return path.to_path_buf(),
        }
    }
}

impl VaultSource {
    /// Open a [`VaultSource`] against the resolved vault + scratch roots.
    ///
    /// Validates the vault root (`catalog.db` + `artifacts/by-sha/`),
    /// probes the catalog schema version, and compiles the embedded
    /// metadata schema.
    pub fn open(
        vault_cfg: &VaultConfig,
        scratch_cfg: &ScratchConfig,
    ) -> Result<Self, VaultSourceError> {
        let vault_root = resolve_vault_root(vault_cfg)?;
        validate_vault_root(&vault_root)?;
        let scratch_root = resolve_scratch_root(scratch_cfg)?;
        // Enforce the read-only-vault invariant against operator misconfig:
        // a scratch root equal to or nested under the vault root would route
        // extraction/marker writes into the read-only vault. Reject it before
        // `ensure_scratch_writable` creates any directory.
        reject_scratch_inside_vault(&vault_root, &scratch_root)?;
        Self::ensure_scratch_writable(&scratch_root)?;

        // Probe schema version (open & drop a connection just for the probe;
        // discovery opens its own).
        let conn = crate::catalog::open_catalog(&vault_root.join("catalog.db"))?;
        let schema_version = crate::catalog::probe_schema_version(&conn)?;
        drop(conn);

        // Compile the embedded-metadata schema.
        let schema_path = vault_root.join("embedded-metadata.schema.json");
        let embedded_schema = EmbeddedSchema::from_schema_path(&schema_path)?;

        Ok(Self {
            vault_root,
            scratch_root,
            schema_version,
            embedded_schema,
        })
    }

    /// Resolved vault root (read-only access).
    pub fn vault_root(&self) -> &Path {
        &self.vault_root
    }

    /// Resolved scratch root (read-only access).
    pub fn scratch_root(&self) -> &Path {
        &self.scratch_root
    }

    fn ensure_scratch_writable(scratch_root: &Path) -> Result<(), VaultSourceError> {
        if let Err(e) = std::fs::create_dir_all(scratch_root) {
            return Err(VaultSourceError::ScratchUnwritable {
                path: scratch_root.to_path_buf(),
                source: e,
            });
        }
        Ok(())
    }

    fn open_conn(&self) -> Result<rusqlite::Connection, VaultSourceError> {
        crate::catalog::open_catalog(&self.vault_root.join("catalog.db"))
    }

    fn fresh_run_id() -> String {
        Uuid::now_v7().to_string()
    }

    fn build_paths(&self, game_id: &str, run_id: &str) -> ScratchPaths {
        ScratchPaths::compose(&self.scratch_root, game_id, run_id)
    }

    /// Internal materialize, shared between catalog-resolved and
    /// catalog-bypass paths.
    fn materialize_inner(
        &self,
        candidate: Option<&ReleaseCandidate>,
        explicit_artifact: Option<ResolvedArtifact>,
        opts: MaterializeOptions,
    ) -> Result<MaterializeResult, VaultSourceError> {
        let conn = self.open_conn()?;
        let _ = crate::catalog::probe_schema_version(&conn)?;

        let (resolved_artifacts, candidate_owned, work_ids, canonical_title) = match candidate {
            Some(c) => {
                let resolved =
                    resolve_release(&conn, &self.vault_root, c.release_id, &opts.selection)?;
                let work_ids = load_work_identifiers(&conn, c.work_id)?;
                let title = load_canonical_title(&conn, c.work_id)?;
                (resolved, c.clone(), work_ids, title)
            }
            None => {
                let primary = explicit_artifact.expect("bypass path requires explicit artifact");
                let synthetic_candidate = ReleaseCandidate {
                    release_id: -1,
                    work_id: -1,
                    edition_name: None,
                    release_date: None,
                    store: None,
                    engine: None,
                    engine_version: None,
                    engine_needs_review: false,
                    languages: Vec::new(),
                    platforms: Vec::new(),
                };
                (
                    vec![primary],
                    synthetic_candidate,
                    Vec::new(),
                    "bypass".into(),
                )
            }
        };

        if resolved_artifacts.is_empty() {
            return Err(VaultSourceError::ReleaseNotResolved {
                claim_summary: format!("release-id({})", candidate_owned.release_id),
            });
        }

        let primary = &resolved_artifacts[0];

        let game_id = derive_game_id(&GameIdContext {
            identifiers: &work_ids,
            release_id: candidate_owned.release_id,
            canonical_title: &canonical_title,
        });
        let run_id = opts.run_id.clone().unwrap_or_else(Self::fresh_run_id);
        let paths = self.build_paths(&game_id.id, &run_id);

        // Decide whether to reuse a cached extraction.
        let reuse = matches!(opts.retention, RetentionPolicy::KeepExtractedForGame) && {
            let last = read_last_artifact_sha(&paths.last_artifact_sha_marker);
            let canonical_extracted = paths.game_root.join("extracted");
            last.as_deref() == Some(primary.sha256.as_str())
                && canonical_extracted.exists()
                && canonical_extracted.join("_vault/metadata.json").exists()
        };

        let extracted_root = if reuse {
            paths.game_root.join("extracted")
        } else {
            // Clean any prior run_root so we always extract fresh.
            let _ = std::fs::remove_dir_all(&paths.run_root);
            let _tree: ExtractedTree = extract_archive(&primary.on_disk_path, &paths)?;
            // For KeepExtractedForGame, write the marker eagerly so a later
            // failure that triggers `release()` still leaves the marker.
            if matches!(opts.retention, RetentionPolicy::KeepExtractedForGame)
                && let Err(e) =
                    write_last_artifact_sha(&paths.last_artifact_sha_marker, &primary.sha256)
            {
                return Err(VaultSourceError::ScratchUnwritable {
                    path: paths.last_artifact_sha_marker.clone(),
                    source: e,
                });
            }
            paths.extracted_root.clone()
        };

        // Read and validate _vault/metadata.json (FIRST file post-extraction).
        let embedded = read_and_validate(&extracted_root, &self.embedded_schema, &primary.sha256)?;

        // Cross-check.
        let mut findings = Vec::new();
        if candidate.is_some() {
            let outcome = cross_check(
                &embedded,
                &candidate_owned,
                &work_ids,
                primary.original_sha256.as_deref(),
                &primary.role,
                &opts.tolerance,
            )?;
            findings.extend(outcome.findings);
        } else {
            findings.push(catalog_bypass_finding(&primary.sha256));
        }

        let subpath_root = primary.subpath.as_ref().map(|sp| extracted_root.join(sp));

        Ok(MaterializeResult {
            game_id: game_id.id,
            run_id,
            extracted_root,
            subpath_root,
            embedded,
            findings,
            artifact_sha256: primary.sha256.clone(),
            release_id: candidate_owned.release_id,
            artifacts: resolved_artifacts,
            catalog_bypass: candidate.is_none(),
            retention_policy: opts.retention,
        })
    }
}

impl LocalCorpusSource for VaultSource {
    fn source_id(&self) -> &'static str {
        "vault"
    }

    fn discover(&self, claim: &ClaimQuery) -> Result<Vec<ReleaseCandidate>, VaultSourceError> {
        let conn = self.open_conn()?;
        let _ = crate::catalog::probe_schema_version(&conn)?;
        discover(&conn, claim)
    }

    fn materialize(
        &self,
        candidate: &ReleaseCandidate,
        opts: MaterializeOptions,
    ) -> Result<MaterializeResult, VaultSourceError> {
        self.materialize_inner(Some(candidate), None, opts)
    }

    fn materialize_by_sha(
        &self,
        sha256: &str,
        opts: MaterializeOptions,
    ) -> Result<MaterializeResult, VaultSourceError> {
        let conn = self.open_conn()?;
        let _ = crate::catalog::probe_schema_version(&conn)?;
        let resolved = resolve_by_sha(&conn, &self.vault_root, sha256)?;
        // Validate that the by-sha path actually points to a file under
        // by-sha/ — defence in depth: resolve_by_sha already does the
        // check, but we also confirm the path layout here.
        let expected_path = by_sha_path(&self.vault_root, sha256)?;
        if resolved.on_disk_path != expected_path {
            return Err(VaultSourceError::ArtifactMissing {
                path: expected_path,
                sha256: sha256.to_string(),
                release_id: -1,
                artifact_id: resolved.id,
            });
        }
        self.materialize_inner(None, Some(resolved), opts)
    }

    fn release(
        &self,
        materialized: &MaterializeResult,
        outcome: RunOutcome,
    ) -> Result<(), VaultSourceError> {
        let paths = self.build_paths(&materialized.game_id, &materialized.run_id);
        if let Err(e) = apply_retention(materialized.retention_policy, &paths, outcome) {
            return Err(VaultSourceError::ScratchUnwritable {
                path: paths.run_root,
                source: e,
            });
        }
        Ok(())
    }

    fn capabilities(&self) -> LocalCorpusCapabilityReport {
        LocalCorpusCapabilityReport {
            source_id: "vault",
            vault_root: self.vault_root.clone(),
            schema_version: self.schema_version,
            supported_artifact_roles: vec![
                "primary".into(),
                "bundle_member".into(),
                "volume_part".into(),
                "patch".into(),
                "translation".into(),
                "dlc".into(),
                "crack".into(),
                "docs".into(),
            ],
            retention_policy_default: RetentionPolicy::default(),
            read_only: true,
            findings_sink_required: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reject_scratch_inside_vault_rejects_nested_and_equal_roots() {
        let vault = tempdir().expect("vault tempdir");
        let scratch_outside = tempdir().expect("scratch tempdir");

        // Disjoint roots are accepted.
        assert!(reject_scratch_inside_vault(vault.path(), scratch_outside.path()).is_ok());

        // Scratch equal to the vault root is rejected.
        assert!(matches!(
            reject_scratch_inside_vault(vault.path(), vault.path()),
            Err(VaultSourceError::ScratchUnwritable { .. })
        ));

        // Scratch nested under the vault root is rejected even when the
        // nested directory does not exist yet.
        let nested = vault.path().join("extraction").join("scratch");
        assert!(matches!(
            reject_scratch_inside_vault(vault.path(), &nested),
            Err(VaultSourceError::ScratchUnwritable { .. })
        ));
    }
}
