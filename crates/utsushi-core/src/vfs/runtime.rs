//! `RuntimeVfs` trait and concrete implementations.
//!
//! `MountedVfs` composes one or more `AssetPackage`s and routes by the
//! `<package-id>` prefix carried in an `AssetId`. `PlaintextDirPackage` is a
//! straight directory-tree `AssetPackage` impl backed by `std::fs`. It is
//! the natural plaintext case for extracted Kaifuu vault trees and the
//! synthetic-package fixture used by integration tests.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use super::diagnostics::{IoSummary, TraversalKind, VfsError, VfsResult};
use super::id::AssetId;
use super::package::{
    AssetBytes, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, PackageDescriptor,
    PackageKind, PackageSource, validate_logical_path,
};

/// Engine-neutral, read-only runtime virtual filesystem.
///
/// Routes by the `<package-id>` prefix of an `AssetId` to one of the
/// registered `AssetPackage`s.
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

    /// Resolve an engine-supplied logical path against a package id.
    fn resolve(&self, package: &str, logical: &str) -> VfsResult<AssetId>;
}

/// In-memory composition of `AssetPackage` implementations.
pub struct MountedVfs {
    packages: Vec<Arc<dyn AssetPackage>>,
    index: BTreeMap<String, usize>,
}

impl MountedVfs {
    pub fn new() -> Self {
        Self {
            packages: Vec::new(),
            index: BTreeMap::new(),
        }
    }

    /// Register a package. Returns an error if the package id is empty or
    /// collides with a previously-mounted package.
    pub fn mount(&mut self, package: Arc<dyn AssetPackage>) -> VfsResult<()> {
        let package_id = package.id().to_string();
        if package_id.is_empty() {
            return Err(VfsError::AssetPathUnsafe {
                package: package_id,
                logical: String::new(),
                kind: TraversalKind::EmptySegment,
            });
        }
        if self.index.contains_key(&package_id) {
            return Err(VfsError::AssetOutsidePackage {
                id: AssetId::from_parts(&package_id, "")?,
                package: package_id,
            });
        }
        let index = self.packages.len();
        self.packages.push(package);
        self.index.insert(package_id, index);
        Ok(())
    }

    fn package_for(&self, id: &AssetId) -> VfsResult<&Arc<dyn AssetPackage>> {
        let package_id = id.package();
        let index = self
            .index
            .get(package_id)
            .ok_or_else(|| VfsError::AssetOutsidePackage {
                id: id.clone(),
                package: package_id.to_string(),
            })?;
        Ok(&self.packages[*index])
    }
}

impl Default for MountedVfs {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeVfs for MountedVfs {
    fn packages(&self) -> Vec<PackageDescriptor> {
        self.packages
            .iter()
            .map(|package| package.descriptor())
            .collect()
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        match self.package_for(id) {
            Ok(package) => package.exists(id),
            Err(VfsError::AssetOutsidePackage { .. }) => Ok(false),
            Err(other) => Err(other),
        }
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let package = self.package_for(id)?;
        package.stat(id)
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let package = self.package_for(id)?;
        package.open(id)
    }

    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        let package = self.package_for(prefix)?;
        package.list(prefix)
    }

    fn resolve(&self, package: &str, logical: &str) -> VfsResult<AssetId> {
        let index = self
            .index
            .get(package)
            .ok_or_else(|| VfsError::AssetPathUnsafe {
                package: package.to_string(),
                logical: logical.to_string(),
                kind: TraversalKind::EmptySegment,
            })?;
        self.packages[*index].resolve(logical)
    }
}

/// Plaintext directory-tree `AssetPackage`. Reads via `std::fs`; never shells
/// out. Suitable for extracted Kaifuu trees and the synthetic-package fixture.
pub struct PlaintextDirPackage {
    id: String,
    root: PathBuf,
    case_rule: CaseRule,
    source: PackageSource,
    revision: Option<String>,
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
        }
    }

    pub fn with_revision(mut self, revision: impl Into<String>) -> Self {
        self.revision = Some(revision.into());
        self
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
        // Verify the resolved path does not escape the package root via a
        // symlink resolution upstream. We do not call canonicalize here
        // (which would touch the host fs); instead we re-check the component
        // structure: `Path::join` cannot escape because we rejected `..` above.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn make_temp_package(case_rule: CaseRule) -> (TempDir, Arc<dyn AssetPackage>) {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("nested")).unwrap();
        fs::write(temp.path().join("intro.txt"), "hello world\n").unwrap();
        fs::write(temp.path().join("nested").join("glyph.txt"), "glyph").unwrap();
        let package = Arc::new(PlaintextDirPackage::new(
            "hello",
            temp.path(),
            case_rule,
            PackageSource::PublicName("public-fixture:plaintext".to_string()),
        )) as Arc<dyn AssetPackage>;
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
    fn mounted_vfs_routes_to_correct_package_by_id() {
        let (_temp_a, package_a) = make_temp_package(CaseRule::Sensitive);
        let temp_b = tempfile::tempdir().unwrap();
        fs::write(temp_b.path().join("greeting.txt"), "yo").unwrap();
        let package_b = Arc::new(PlaintextDirPackage::new(
            "other",
            temp_b.path(),
            CaseRule::Sensitive,
            PackageSource::PublicName("public-fixture:other".to_string()),
        )) as Arc<dyn AssetPackage>;
        let mut vfs = MountedVfs::new();
        vfs.mount(package_a).unwrap();
        vfs.mount(package_b).unwrap();

        let bytes_a = vfs
            .open(&AssetId::from_parts("hello", "intro.txt").unwrap())
            .unwrap();
        assert_eq!(bytes_a.as_slice(), b"hello world\n");

        let bytes_b = vfs
            .open(&AssetId::from_parts("other", "greeting.txt").unwrap())
            .unwrap();
        assert_eq!(bytes_b.as_slice(), b"yo");
    }

    #[test]
    fn mounted_vfs_unknown_package_id_returns_asset_outside_package() {
        let vfs = MountedVfs::new();
        let id = AssetId::from_parts("missing", "x.txt").unwrap();
        let err = vfs.open(&id).unwrap_err();
        match err {
            VfsError::AssetOutsidePackage { package, .. } => {
                assert_eq!(package, "missing");
            }
            other => panic!("expected AssetOutsidePackage, got {other:?}"),
        }
    }

    #[test]
    fn mounted_vfs_rejects_duplicate_package_id() {
        let (_temp_a, package_a) = make_temp_package(CaseRule::Sensitive);
        let (_temp_b, package_b) = make_temp_package(CaseRule::Sensitive);
        let mut vfs = MountedVfs::new();
        vfs.mount(package_a).unwrap();
        let err = vfs.mount(package_b).unwrap_err();
        assert!(matches!(err, VfsError::AssetOutsidePackage { .. }));
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
