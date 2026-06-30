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
use crate::findings::CrossCheckFinding;
use crate::metadata::{CrossCheckTolerance, EmbeddedMetadata, cross_check, read_embedded_metadata};
use crate::paths::{GameIdContext, derive_game_id};
use crate::resolution::{ArtifactSelection, ResolvedArtifact, resolve_release};
use crate::retention::{
    RunOutcome, apply_retention, read_last_canonical_id, write_last_canonical_id,
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
    /// `<scratch>/<game-id>/<run-id>/extracted/` — the raw extraction root.
    pub extracted_root: PathBuf,
    /// `<extracted_root>/<canonical_id>/` — the game tree root. The by-id
    /// archive wraps the game tree (and `_vault/metadata.json`) under a
    /// top-level `<canonical_id>/` directory; this points at it. Downstream
    /// engine adapters point here.
    pub tree_root: PathBuf,
    /// `<tree_root>/<subpath>` when applicable.
    pub subpath_root: Option<PathBuf>,
    /// Parsed embedded by-id metadata.
    pub embedded: EmbeddedMetadata,
    /// Cross-check findings (may be empty).
    pub findings: Vec<CrossCheckFinding>,
    /// The stable `canonical_id` that was resolved and extracted.
    pub artifact_canonical_id: String,
    /// `releases.id`.
    pub release_id: i64,
    /// All resolved artifacts (the first is the primary).
    pub artifacts: Vec<ResolvedArtifact>,
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

/// The vault-source adapter. Holds resolved vault/scratch roots and the
/// observed catalog schema version.
pub struct VaultSource {
    vault_root: PathBuf,
    scratch_root: PathBuf,
    schema_version: u32,
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
    /// Validates the vault root (`catalog.db` + `artifacts/by-id/`) and probes
    /// the catalog schema version. No embedded-metadata JSON-Schema is
    /// compiled: the by-id era embeds the canonical metadata document (not the
    /// legacy v1.0 `releases[]` shape), and identity is cross-checked
    /// field-by-field at materialize time.
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

        Ok(Self {
            vault_root,
            scratch_root,
            schema_version,
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

    /// Internal materialize for a catalog-resolved candidate.
    fn materialize_inner(
        &self,
        candidate: &ReleaseCandidate,
        opts: MaterializeOptions,
    ) -> Result<MaterializeResult, VaultSourceError> {
        let conn = self.open_conn()?;
        let _ = crate::catalog::probe_schema_version(&conn)?;

        let resolved_artifacts = resolve_release(
            &conn,
            &self.vault_root,
            candidate.release_id,
            &opts.selection,
        )?;
        let work_ids = load_work_identifiers(&conn, candidate.work_id)?;
        let canonical_title = load_canonical_title(&conn, candidate.work_id)?;

        if resolved_artifacts.is_empty() {
            return Err(VaultSourceError::ReleaseNotResolved {
                claim_summary: format!("release-id({})", candidate.release_id),
            });
        }

        let primary = &resolved_artifacts[0];
        let canonical_id = primary.canonical_id.clone();

        let game_id = derive_game_id(&GameIdContext {
            identifiers: &work_ids,
            release_id: candidate.release_id,
            canonical_title: &canonical_title,
        });
        let run_id = opts.run_id.clone().unwrap_or_else(Self::fresh_run_id);
        let paths = self.build_paths(&game_id.id, &run_id);

        // Decide whether to reuse a cached extraction. The by-id archive wraps
        // its tree under `<canonical_id>/`, so the cached tree root is
        // `<game-id>/extracted/<canonical_id>`.
        let reuse = matches!(opts.retention, RetentionPolicy::KeepExtractedForGame) && {
            let last = read_last_canonical_id(&paths.last_canonical_id_marker);
            let canonical_extracted = paths.game_root.join("extracted");
            last.as_deref() == Some(canonical_id.as_str())
                && canonical_extracted
                    .join(&canonical_id)
                    .join("_vault/metadata.json")
                    .exists()
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
                    write_last_canonical_id(&paths.last_canonical_id_marker, &canonical_id)
            {
                return Err(VaultSourceError::ScratchUnwritable {
                    path: paths.last_canonical_id_marker.clone(),
                    source: e,
                });
            }
            paths.extracted_root.clone()
        };

        // The game tree (and `_vault/metadata.json`) live under the
        // `<canonical_id>/` wrapper the by-id repack adds.
        let tree_root = extracted_root.join(&canonical_id);

        // Read the embedded by-id metadata (FIRST file post-extraction).
        let embedded = read_embedded_metadata(&tree_root, &canonical_id)?;

        // Identity cross-check (canonical_id + work identifiers).
        let outcome = cross_check(
            &embedded,
            candidate,
            &work_ids,
            &canonical_id,
            &opts.tolerance,
        )?;
        let findings = outcome.findings;

        let subpath_root = primary.subpath.as_ref().map(|sp| tree_root.join(sp));

        Ok(MaterializeResult {
            game_id: game_id.id,
            run_id,
            extracted_root,
            tree_root,
            subpath_root,
            embedded,
            findings,
            artifact_canonical_id: canonical_id,
            release_id: candidate.release_id,
            artifacts: resolved_artifacts,
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
        self.materialize_inner(candidate, opts)
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
