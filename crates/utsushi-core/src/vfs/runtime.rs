//! `RuntimeVfs` trait and concrete implementations.
//!
//! `MountedVfs` is a thin wrapper around a single internal
//! [`CompositeAssetPackage`] (substrate extension M.1, UTSUSHI-222). The
//! caller registers plaintext directories and sealed archive readers in
//! priority order via `mount_plaintext_dir` / `mount_archive`; every
//! resolve walks the composite's source list first-match-wins. This
//! replaces the route-by-package-id resolver that shipped with
//! UTSUSHI-020. No shim, no `#[deprecated]` alias, no `legacy_*` module —
//! the orchestration-operating-model "Legacy-path preservation" rule
//! refuses dual paths.
//!
//! [`PlaintextDirPackage`] is the straight-directory `AssetPackage` impl
//! backed by `std::fs`. It exposes a lazily-built case-folded directory
//! index that the composite consumes so resolution is O(1) per lookup
//! rather than O(directory) per call.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use super::archive::{AssetArchiveReader, CaseFoldedIndex};
use super::composite::CompositeAssetPackage;
use super::diagnostics::{IoSummary, TraversalKind, VfsError, VfsResult};
use super::id::AssetId;
use super::package::{
    AssetBytes, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, PackageDescriptor,
    PackageKind, PackageSource, validate_logical_path,
};

/// Engine-neutral, read-only runtime virtual filesystem.
///
/// The composite-based [`MountedVfs`] is the in-tree implementation; the
/// trait is kept abstract so engine ports can plug their own
/// composition strategy.
pub trait RuntimeVfs: Send + Sync {
    /// List packages mounted into this VFS. Order is deterministic
    /// per-implementation (typically registration order).
    fn packages(&self) -> Vec<PackageDescriptor>;

    /// Whether the asset exists and is openable for read. Returns `Ok(false)`
    /// for `asset_missing` and `asset_outside_package`; helper-gated and
    /// encrypted assets return `Ok(true)` because their existence is
    /// observable even when their bytes are not.
    fn exists(&self, id: &AssetId) -> VfsResult<bool>;

    /// Metadata-only lookup.
    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata>;

    /// Open an asset for read.
    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes>;

    /// List immediate children under a directory-shaped asset id.
    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>>;

    /// Resolve an engine-supplied logical path to an [`AssetId`]. The
    /// resolver walks the composite's source list first-match-wins.
    fn resolve(&self, logical: &str) -> VfsResult<AssetId>;
}

/// In-memory composition of one canonical [`AssetId`] package id over an
/// ordered list of plaintext directories and sealed archive readers.
#[derive(Debug)]
pub struct MountedVfs {
    composite: CompositeAssetPackage,
}

impl MountedVfs {
    /// Construct an empty composite-backed VFS under the canonical package
    /// id. `source` is the redacted public name surfaced via the
    /// descriptor.
    pub fn new(id: impl Into<String>, source: PackageSource) -> Self {
        Self {
            composite: CompositeAssetPackage::new(id, source),
        }
    }

    /// Attach a revision / content-hash provenance string. Forwarded to
    /// [`AssetMetadata::revision`].
    pub fn with_revision(mut self, revision: impl Into<String>) -> Self {
        self.composite = self.composite.with_revision(revision);
        self
    }

    /// Append a plaintext directory source. Earlier-registered sources
    /// take precedence (first-match-wins).
    pub fn mount_plaintext_dir(&mut self, dir: PlaintextDirPackage) {
        self.composite.push_plaintext_dir(Arc::new(dir));
    }

    /// Append a sealed archive-reader source. Earlier-registered sources
    /// take precedence (first-match-wins).
    pub fn mount_archive(&mut self, archive: Arc<dyn AssetArchiveReader>) {
        self.composite.push_archive(archive);
    }

    /// Borrow the internal composite. Exposed so callers that want to
    /// pass the composite directly to a downstream consumer don't need to
    /// re-build it. The composite implements [`AssetPackage`].
    pub fn composite(&self) -> &CompositeAssetPackage {
        &self.composite
    }
}

impl RuntimeVfs for MountedVfs {
    fn packages(&self) -> Vec<PackageDescriptor> {
        vec![self.composite.descriptor()]
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        self.composite.exists(id)
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        self.composite.stat(id)
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        self.composite.open(id)
    }

    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        self.composite.list(prefix)
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        self.composite.resolve(logical)
    }
}

/// Plaintext directory-tree `AssetPackage`. Reads via `std::fs`; never shells
/// out. Suitable for extracted Kaifuu trees and the synthetic-package fixture.
///
/// Exposes a [`CaseFoldedIndex`] built lazily on first request and cached
/// for the lifetime of the package. The composite uses that index to give
/// O(1) per-lookup resolution across mixed plaintext/archive sources.
pub struct PlaintextDirPackage {
    id: String,
    root: PathBuf,
    case_rule: CaseRule,
    source: PackageSource,
    revision: Option<String>,
    /// Lazily-built case-folded index of every file under `root`.
    /// `OnceLock` enforces a single build; the cached value is reused
    /// across every composite resolve, satisfying the audit-focus
    /// rebuild-per-call invariant.
    index: OnceLock<Result<CaseFoldedIndex, VfsError>>,
}

impl std::fmt::Debug for PlaintextDirPackage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PlaintextDirPackage")
            .field("id", &self.id)
            .field("case_rule", &self.case_rule)
            .field("source", &self.source)
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

impl PlaintextDirPackage {
    /// Construct a new plaintext package mounted at `root` under the public
    /// `id`. The `source` MUST be a redacted public name; it is the only
    /// identifying string surfaced in diagnostics.
    pub fn new(
        id: impl Into<String>,
        root: impl Into<PathBuf>,
        case_rule: CaseRule,
        source: PackageSource,
    ) -> Self {
        Self {
            id: id.into(),
            root: root.into(),
            case_rule,
            source,
            revision: None,
            index: OnceLock::new(),
        }
    }

    pub fn with_revision(mut self, revision: impl Into<String>) -> Self {
        self.revision = Some(revision.into());
        self
    }

    /// Borrow the lazily-built case-folded directory index. Walks the root
    /// the first time it's called and caches the result.
    pub fn case_folded_index(&self) -> VfsResult<&CaseFoldedIndex> {
        let cell = self
            .index
            .get_or_init(|| build_dir_index(&self.id, &self.root));
        match cell {
            Ok(index) => Ok(index),
            Err(error) => Err(error.clone()),
        }
    }

    fn join_under_root(&self, id: &AssetId) -> VfsResult<PathBuf> {
        let path = id.path();
        let stripped = path.strip_suffix('/').unwrap_or(path);
        let mut accumulator = self.root.clone();
        if stripped.is_empty() {
            return Ok(accumulator);
        }
        for segment in stripped.split('/') {
            // Belt-and-suspenders: id parsing rejects these, but never let a
            // traversal segment reach the host store.
            if segment == ".." || segment == "." || segment.is_empty() {
                return Err(VfsError::AssetPathUnsafe {
                    package: self.id.clone(),
                    logical: stripped.to_string(),
                    kind: TraversalKind::ParentEscape,
                });
            }
            accumulator.push(segment);
        }
        for component in accumulator.components() {
            if matches!(component, Component::ParentDir) {
                return Err(VfsError::AssetPathUnsafe {
                    package: self.id.clone(),
                    logical: stripped.to_string(),
                    kind: TraversalKind::ParentEscape,
                });
            }
        }
        Ok(accumulator)
    }

    /// Match a request against directory entries under `parent_host_path`,
    /// applying the package's case rule. Returns the matching entry name as
    /// it is stored on disk so we can build the canonical id from it.
    fn match_case(&self, parent_host_path: &Path, requested: &str) -> VfsResult<Option<String>> {
        match self.case_rule {
            CaseRule::Sensitive => {
                let candidate = parent_host_path.join(requested);
                match fs::symlink_metadata(&candidate) {
                    Ok(_) => Ok(Some(requested.to_string())),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                    Err(error) => Err(self.package_io(error, None)),
                }
            }
            CaseRule::InsensitiveAscii => {
                let entries = match fs::read_dir(parent_host_path) {
                    Ok(entries) => entries,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                    Err(error) => return Err(self.package_io(error, None)),
                };
                for entry in entries {
                    let entry = entry.map_err(|error| self.package_io(error, None))?;
                    let file_name = entry.file_name();
                    let Some(file_name_str) = file_name.to_str() else {
                        continue;
                    };
                    if file_name_str.eq_ignore_ascii_case(requested) {
                        return Ok(Some(file_name_str.to_string()));
                    }
                }
                Ok(None)
            }
        }
    }

    fn package_io(&self, error: io::Error, id: Option<AssetId>) -> VfsError {
        // Drop the raw error message; preserve only the IoSummary.
        let summary = IoSummary::from_io_error_kind(error.kind());
        let id = id.unwrap_or_else(|| {
            AssetId::from_parts(&self.id, "").expect("package id must be a valid asset id")
        });
        VfsError::PackageIo { id, summary }
    }
}

impl AssetPackage for PlaintextDirPackage {
    fn id(&self) -> &str {
        &self.id
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id.clone(),
            kind: PackageKind::Plaintext,
            case_rule: self.case_rule,
            source: self.source.clone(),
            revision: self.revision.clone(),
        }
    }

    fn case_rule(&self) -> CaseRule {
        self.case_rule
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        let canonical = validate_logical_path(&self.id, logical)?;
        // For case-insensitive packages, walk the host to recover the
        // stored case so the returned id is canonical.
        let resolved = match self.case_rule {
            CaseRule::Sensitive => canonical,
            CaseRule::InsensitiveAscii => {
                let (working, trailing) = match canonical.strip_suffix('/') {
                    Some(rest) => (rest, true),
                    None => (canonical.as_str(), false),
                };
                let mut accumulator = self.root.clone();
                let mut rebuilt = Vec::new();
                for segment in working.split('/') {
                    let matched = self.match_case(&accumulator, segment)?;
                    let stored = matched.unwrap_or_else(|| segment.to_string());
                    accumulator.push(&stored);
                    rebuilt.push(stored);
                }
                let joined = rebuilt.join("/");
                if trailing {
                    format!("{joined}/")
                } else {
                    joined
                }
            }
        };
        AssetId::from_parts(&self.id, &resolved)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        if id.package() != self.id {
            return Ok(false);
        }
        let host_path = self.join_under_root(id)?;
        match fs::symlink_metadata(&host_path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(self.package_io(error, Some(id.clone()))),
        }
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        if id.package() != self.id {
            return Err(VfsError::AssetOutsidePackage {
                id: id.clone(),
                package: self.id.clone(),
            });
        }
        let host_path = self.join_under_root(id)?;
        let metadata = match fs::symlink_metadata(&host_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(VfsError::AssetMissing { id: id.clone() });
            }
            Err(error) => return Err(self.package_io(error, Some(id.clone()))),
        };
        if metadata.is_dir() {
            Ok(AssetMetadata {
                id: id.clone(),
                kind: AssetKind::Directory,
                size: AssetSize::Unknown,
                revision: self.revision.clone(),
            })
        } else if metadata.is_file() {
            Ok(AssetMetadata {
                id: id.clone(),
                kind: AssetKind::File,
                size: AssetSize::Bytes(metadata.len()),
                revision: self.revision.clone(),
            })
        } else {
            // Symlinks, sockets, etc. are not supported as plaintext assets.
            Err(VfsError::PackageIo {
                id: id.clone(),
                summary: IoSummary::Other,
            })
        }
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        if id.package() != self.id {
            return Err(VfsError::AssetOutsidePackage {
                id: id.clone(),
                package: self.id.clone(),
            });
        }
        if id.is_directory() {
            return Err(VfsError::AssetNotFile { id: id.clone() });
        }
        let host_path = self.join_under_root(id)?;
        match fs::symlink_metadata(&host_path) {
            Ok(metadata) if metadata.is_dir() => {
                return Err(VfsError::AssetNotFile { id: id.clone() });
            }
            Ok(metadata) if !metadata.is_file() => {
                return Err(VfsError::PackageIo {
                    id: id.clone(),
                    summary: IoSummary::Other,
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(VfsError::AssetMissing { id: id.clone() });
            }
            Err(error) => return Err(self.package_io(error, Some(id.clone()))),
        }
        match fs::read(&host_path) {
            Ok(bytes) => Ok(AssetBytes::from(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Err(VfsError::AssetMissing { id: id.clone() })
            }
            Err(error) => Err(self.package_io(error, Some(id.clone()))),
        }
    }

    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        if prefix.package() != self.id {
            return Err(VfsError::AssetOutsidePackage {
                id: prefix.clone(),
                package: self.id.clone(),
            });
        }
        if !prefix.is_directory() {
            return Err(VfsError::AssetNotDirectory { id: prefix.clone() });
        }
        let host_path = self.join_under_root(prefix)?;
        let entries = match fs::read_dir(&host_path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(VfsError::AssetMissing { id: prefix.clone() });
            }
            Err(error) => return Err(self.package_io(error, Some(prefix.clone()))),
        };

        let mut children: Vec<(String, bool)> = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| self.package_io(error, Some(prefix.clone())))?;
            let file_name = entry.file_name();
            let Some(file_name_str) = file_name.to_str() else {
                continue;
            };
            let file_type = entry
                .file_type()
                .map_err(|error| self.package_io(error, Some(prefix.clone())))?;
            if !file_type.is_dir() && !file_type.is_file() {
                continue;
            }
            children.push((file_name_str.to_string(), file_type.is_dir()));
        }
        // Byte-lexicographic on path component for deterministic order.
        children.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));

        let mut ids = Vec::with_capacity(children.len());
        for (name, is_dir) in children {
            let child_relative = if is_dir { format!("{name}/") } else { name };
            let child_id = prefix.join(&child_relative)?;
            ids.push(child_id);
        }
        Ok(ids)
    }
}

impl super::archive::sealed::Sealed for PlaintextDirPackage {}

/// Walk `root` recursively, building a case-folded index of every file
/// path relative to `root`. Used as the one-shot lazy initialiser for
/// [`PlaintextDirPackage::case_folded_index`].
///
/// Directory traversal failures are surfaced via [`VfsError::PackageIo`]
/// so the composite resolver reports a redaction-safe diagnostic instead
/// of leaking the host path through the underlying `io::Error`.
fn build_dir_index(package_id: &str, root: &Path) -> Result<CaseFoldedIndex, VfsError> {
    let mut index = CaseFoldedIndex::new();
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // No root → empty index. Composite resolves miss; no error.
            return Ok(index);
        }
        Err(error) => {
            return Err(VfsError::PackageIo {
                id: AssetId::from_parts(package_id, "")?,
                summary: IoSummary::from_io_error_kind(error.kind()),
            });
        }
    };
    if !root_metadata.is_dir() {
        return Ok(index);
    }
    walk_dir(package_id, root, root, &mut index)?;
    Ok(index)
}

fn walk_dir(
    package_id: &str,
    root: &Path,
    current: &Path,
    index: &mut CaseFoldedIndex,
) -> Result<(), VfsError> {
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(VfsError::PackageIo {
                id: AssetId::from_parts(package_id, "")?,
                summary: IoSummary::from_io_error_kind(error.kind()),
            });
        }
    };
    for entry in entries {
        let entry = entry.map_err(|error| VfsError::PackageIo {
            id: AssetId::from_parts(package_id, "").expect("valid package id"),
            summary: IoSummary::from_io_error_kind(error.kind()),
        })?;
        let file_type = entry.file_type().map_err(|error| VfsError::PackageIo {
            id: AssetId::from_parts(package_id, "").expect("valid package id"),
            summary: IoSummary::from_io_error_kind(error.kind()),
        })?;
        let entry_path = entry.path();
        if file_type.is_dir() {
            walk_dir(package_id, root, &entry_path, index)?;
        } else if file_type.is_file() {
            let Ok(relative) = entry_path.strip_prefix(root) else {
                continue;
            };
            // Build a forward-slash-separated logical path from the
            // platform-native path components. Skip non-UTF8 names.
            let mut segments: Vec<String> = Vec::new();
            let mut valid = true;
            for component in relative.components() {
                let Component::Normal(os_segment) = component else {
                    continue;
                };
                match os_segment.to_str() {
                    Some(segment) => segments.push(segment.to_string()),
                    None => {
                        valid = false;
                        break;
                    }
                }
            }
            if !valid || segments.is_empty() {
                continue;
            }
            index.insert(segments.join("/"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_temp_package(case_rule: CaseRule) -> (TempDir, PlaintextDirPackage) {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("nested")).unwrap();
        fs::write(temp.path().join("intro.txt"), "hello world\n").unwrap();
        fs::write(temp.path().join("nested").join("glyph.txt"), "glyph").unwrap();
        let package = PlaintextDirPackage::new(
            "hello",
            temp.path(),
            case_rule,
            PackageSource::PublicName("public-fixture:plaintext".to_string()),
        );
        (temp, package)
    }

    #[test]
    fn insensitive_ascii_resolve_matches_uppercase_request() {
        let (_temp, package) = make_temp_package(CaseRule::InsensitiveAscii);
        let id = package.resolve("INTRO.TXT").unwrap();
        // Resolution recovers the stored case so the id is canonical.
        assert_eq!(id.path(), "intro.txt");
    }

    #[test]
    fn sensitive_resolve_rejects_case_mismatch() {
        let (_temp, package) = make_temp_package(CaseRule::Sensitive);
        let id = package.resolve("INTRO.TXT").unwrap();
        // Sensitive does not change the case; the file is missing under
        // that stored form.
        assert!(matches!(package.exists(&id), Ok(false)));
        // The lowercase form exists.
        let canonical = package.resolve("intro.txt").unwrap();
        assert_eq!(canonical.path(), "intro.txt");
        assert!(package.exists(&canonical).unwrap());
    }

    #[test]
    fn list_returns_children_in_byte_lexicographic_order() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["c.txt", "a.txt", "b.txt"] {
            fs::write(temp.path().join(name), name).unwrap();
        }
        let package = PlaintextDirPackage::new(
            "lex",
            temp.path(),
            CaseRule::Sensitive,
            PackageSource::PublicName("public-fixture:lex".to_string()),
        );
        let prefix = AssetId::from_parts("lex", "").unwrap();
        let children = package.list(&prefix).unwrap();
        let names: Vec<&str> = children.iter().map(|id| id.path()).collect();
        assert_eq!(names, vec!["a.txt", "b.txt", "c.txt"]);
    }

    #[test]
    fn list_on_non_directory_returns_asset_not_directory() {
        let (_temp, package) = make_temp_package(CaseRule::Sensitive);
        let id = AssetId::from_parts("hello", "intro.txt").unwrap();
        let err = package.list(&id).unwrap_err();
        assert!(matches!(err, VfsError::AssetNotDirectory { .. }));
    }

    #[test]
    fn open_on_directory_returns_asset_not_file() {
        let (_temp, package) = make_temp_package(CaseRule::Sensitive);
        let id = AssetId::from_parts("hello", "nested/").unwrap();
        let err = package.open(&id).unwrap_err();
        assert!(matches!(err, VfsError::AssetNotFile { .. }));
    }

    #[test]
    fn open_missing_returns_asset_missing() {
        let (_temp, package) = make_temp_package(CaseRule::Sensitive);
        let id = AssetId::from_parts("hello", "absent.txt").unwrap();
        let err = package.open(&id).unwrap_err();
        match err {
            VfsError::AssetMissing { id: missing } => {
                assert_eq!(missing.path(), "absent.txt");
            }
            other => panic!("expected AssetMissing, got {other:?}"),
        }
    }

    #[test]
    fn case_folded_index_is_built_once_and_cached() {
        let (_temp, package) = make_temp_package(CaseRule::Sensitive);
        let first = package.case_folded_index().unwrap() as *const CaseFoldedIndex;
        let second = package.case_folded_index().unwrap() as *const CaseFoldedIndex;
        assert_eq!(first, second, "OnceLock must hand back the same reference");
    }

    #[test]
    fn case_folded_index_contains_every_file_under_root() {
        let (_temp, package) = make_temp_package(CaseRule::Sensitive);
        let index = package.case_folded_index().unwrap();
        assert_eq!(index.len(), 2);
        assert_eq!(
            index.lookup("intro.txt").unwrap().stored_path(),
            "intro.txt"
        );
        assert_eq!(
            index.lookup("nested/glyph.txt").unwrap().stored_path(),
            "nested/glyph.txt"
        );
    }

    #[test]
    fn mounted_vfs_routes_through_internal_composite() {
        let (_temp, package) = make_temp_package(CaseRule::Sensitive);
        let mut vfs = MountedVfs::new(
            "hello",
            PackageSource::PublicName("public-fixture:hello".to_string()),
        );
        vfs.mount_plaintext_dir(package);
        let id = vfs.resolve("intro.txt").unwrap();
        let bytes = vfs.open(&id).unwrap();
        assert_eq!(bytes.as_slice(), b"hello world\n");
    }

    #[test]
    fn mounted_vfs_unknown_logical_returns_asset_missing() {
        let (_temp, package) = make_temp_package(CaseRule::Sensitive);
        let mut vfs = MountedVfs::new(
            "hello",
            PackageSource::PublicName("public-fixture:hello".to_string()),
        );
        vfs.mount_plaintext_dir(package);
        let err = vfs.resolve("definitely-absent.bin").unwrap_err();
        assert!(matches!(err, VfsError::AssetMissing { .. }));
    }

    #[test]
    fn vfs_error_for_real_host_path_input_does_not_leak_path_into_display() {
        // Build a package rooted under a real tempdir so the host path
        // contains /tmp/... — a forbidden substring.
        let (temp, package) = make_temp_package(CaseRule::Sensitive);
        let host_root_display = temp.path().display().to_string();
        let id = AssetId::from_parts("hello", "definitely-absent.bin").unwrap();
        let err = package.open(&id).unwrap_err();
        let rendered = err.to_string();
        assert!(
            !rendered.contains(&host_root_display),
            "rendered display leaked host path: {rendered}"
        );
        // Sanity: tempdir paths under Linux start with `/tmp/`.
        if host_root_display.starts_with("/tmp/") {
            assert!(!rendered.contains("/tmp/"));
        }
    }

    #[test]
    fn package_io_failure_summary_does_not_include_errno_text() {
        // Mount a package whose root does not exist; stat will report a
        // missing path. The `Display` for the resulting AssetMissing must
        // not include the system errno text.
        let nonexistent = std::env::temp_dir().join("utsushi-vfs-no-such-dir-xyz");
        let _ = fs::remove_dir_all(&nonexistent);
        let package = PlaintextDirPackage::new(
            "ghost",
            nonexistent,
            CaseRule::Sensitive,
            PackageSource::PublicName("public-fixture:ghost".to_string()),
        );
        let id = AssetId::from_parts("ghost", "anything.txt").unwrap();
        let err = package.open(&id).unwrap_err();
        let rendered = err.to_string();
        assert!(!rendered.contains("os error"));
        assert!(!rendered.contains("No such file"));
    }
}
