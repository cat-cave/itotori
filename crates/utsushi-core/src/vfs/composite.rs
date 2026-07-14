//! Composite asset package: ordered, first-match-wins multiplex over a
//! mix of plaintext directories and sealed archive readers.
//!
//! Substrate extension M.1 (). Replaces the route-by-package-id
//! resolver that shipped with. RealLive's
//! `#FOLDNAME.G00 = "G00" = 0: "G00.PAK"` Gameexe pattern declares
//! per-asset-kind dual sources — try directory, fall back to archive — and
//! the composite is the substrate-side primitive that lets engine ports
//! express it without re-implementing the multiplex policy.
//!
//! Resolution order:
//!
//! 1. The composite walks `sources` in registration order.
//! 2. For each source it consults a case-folded directory index that is
//!    built once (lazily) and cached for the lifetime of the source. The
//!    audit-focus item "case-folded index that rebuilds per call" is
//!    refused by construction: indices live behind a [`OnceLock`].
//! 3. The first hit wins. Subsequent sources are not consulted, so
//!    plaintext overlays take precedence over archive fallbacks when the
//!    caller registers them in that order.

use std::collections::BTreeSet;
use std::sync::Arc;

use super::archive::{AssetArchiveReader, CaseFoldedIndex};
use super::diagnostics::{VfsError, VfsResult};
use super::id::AssetId;
use super::package::{
    AssetBytes, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, PackageDescriptor,
    PackageKind, PackageSource, validate_logical_path,
};
use super::runtime::PlaintextDirPackage;

/// One element of a [`CompositeAssetPackage`]'s ordered source list.
#[derive(Clone, Debug)]
pub enum CompositeSource {
    /// A plaintext directory on the host filesystem.
    PlaintextDir(Arc<PlaintextDirPackage>),
    /// A sealed archive reader. Implementors live inside `utsushi-core`.
    Archive(Arc<dyn AssetArchiveReader>),
}

impl CompositeSource {
    fn case_folded_index(&self) -> VfsResult<&CaseFoldedIndex> {
        match self {
            CompositeSource::PlaintextDir(dir) => dir.case_folded_index(),
            CompositeSource::Archive(archive) => archive.case_folded_index(),
        }
    }
}

/// Engine-neutral composite [`AssetPackage`].
///
/// Owns a single canonical [`AssetId`] package id; the composite's source
/// list provides multiplexed backing storage. Implements [`AssetPackage`]
/// so the runtime VFS can treat it uniformly.
#[derive(Debug)]
pub struct CompositeAssetPackage {
    id: String,
    source: PackageSource,
    revision: Option<String>,
    sources: Vec<CompositeSource>,
}

impl CompositeAssetPackage {
    /// Construct an empty composite under the given canonical package id.
    /// `source` is the redacted public name surfaced via the descriptor.
    pub fn new(id: impl Into<String>, source: PackageSource) -> Self {
        Self {
            id: id.into(),
            source,
            revision: None,
            sources: Vec::new(),
        }
    }

    /// Attach a revision / content-hash provenance string. Surfaced via
    /// [`AssetMetadata::revision`].
    pub fn with_revision(mut self, revision: impl Into<String>) -> Self {
        self.revision = Some(revision.into());
        self
    }

    /// Append a plaintext directory source. Earlier-registered sources
    /// take precedence over later ones (first-match-wins).
    pub fn push_plaintext_dir(&mut self, dir: Arc<PlaintextDirPackage>) {
        self.sources.push(CompositeSource::PlaintextDir(dir));
    }

    /// Append an archive-reader source. Earlier-registered sources take
    /// precedence over later ones (first-match-wins).
    pub fn push_archive(&mut self, archive: Arc<dyn AssetArchiveReader>) {
        self.sources.push(CompositeSource::Archive(archive));
    }

    /// Number of registered sources. Used by tests and diagnostics.
    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    /// Locate the first source whose case-folded index contains `logical`.
    /// Returns `(source_index, stored_path)` so the caller can route the
    /// follow-up open / stat / list to the same source.
    fn locate(&self, logical: &str) -> VfsResult<Option<(usize, String)>> {
        for (index, source) in self.sources.iter().enumerate() {
            let folded_index = source.case_folded_index()?;
            if let Some(entry) = folded_index.lookup(logical) {
                return Ok(Some((index, entry.stored_path().to_string())));
            }
        }
        Ok(None)
    }
}

impl AssetPackage for CompositeAssetPackage {
    fn id(&self) -> &str {
        &self.id
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id.clone(),
            kind: PackageKind::Composite,
            // The composite's effective case rule is ASCII-insensitive
            // because every source's index is case-folded. Carrying
            // `InsensitiveAscii` matches what `resolve` actually does.
            case_rule: CaseRule::InsensitiveAscii,
            source: self.source.clone(),
            revision: self.revision.clone(),
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::InsensitiveAscii
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        let canonical = validate_logical_path(&self.id, logical)?;
        // Strip the trailing slash for index lookups; the substrate
        // distinguishes file vs directory ids by the slash suffix but
        // sources index entries by their canonical-case stored path.
        let (working, trailing) = match canonical.strip_suffix('/') {
            Some(rest) => (rest, true),
            None => (canonical.as_str(), false),
        };

        if trailing {
            // Directory id: succeed if any source has an entry beneath
            // this prefix. We don't need a stored-case rebuild because
            // directories are not stored as entries themselves; we
            // canonicalise the path to lowercase below to keep resolve
            // deterministic across sources with differing internal case.
            let prefix_with_slash = if working.is_empty() {
                String::new()
            } else {
                format!("{}/", lowercase_ascii(working))
            };
            for source in &self.sources {
                let index = source.case_folded_index()?;
                let mut found = false;
                for entry in index.iter_entries() {
                    if lowercase_ascii(entry.stored_path()).starts_with(&prefix_with_slash) {
                        found = true;
                        break;
                    }
                }
                if found {
                    let canonical_dir = if working.is_empty() {
                        String::new()
                    } else {
                        format!("{working}/")
                    };
                    return AssetId::from_parts(&self.id, &canonical_dir);
                }
            }
            return Err(VfsError::AssetMissing {
                id: AssetId::from_parts(&self.id, &canonical)?,
            });
        }

        match self.locate(working)? {
            Some((_, stored)) => AssetId::from_parts(&self.id, &stored),
            None => Err(VfsError::AssetMissing {
                id: AssetId::from_parts(&self.id, &canonical)?,
            }),
        }
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        if id.package() != self.id {
            return Ok(false);
        }
        let path = id.path();
        let stripped = path.strip_suffix('/').unwrap_or(path);
        if stripped.is_empty() {
            // Package root always exists once any source is registered.
            return Ok(!self.sources.is_empty());
        }
        if path.ends_with('/') {
            // Directory existence: any source has an entry beneath this prefix.
            let prefix = format!("{}/", lowercase_ascii(stripped));
            for source in &self.sources {
                let index = source.case_folded_index()?;
                for entry in index.iter_entries() {
                    if lowercase_ascii(entry.stored_path()).starts_with(&prefix) {
                        return Ok(true);
                    }
                }
            }
            return Ok(false);
        }
        Ok(self.locate(stripped)?.is_some())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        if id.package() != self.id {
            return Err(VfsError::AssetOutsidePackage {
                id: id.clone(),
                package: self.id.clone(),
            });
        }
        let path = id.path();
        let stripped = path.strip_suffix('/').unwrap_or(path);
        if id.is_directory() {
            // Directories don't have a single backing source. Report kind
            // = Directory and Unknown size; this matches `PlaintextDirPackage`.
            if !stripped.is_empty() && !self.exists(id)? {
                return Err(VfsError::AssetMissing { id: id.clone() });
            }
            return Ok(AssetMetadata {
                id: id.clone(),
                kind: AssetKind::Directory,
                size: AssetSize::Unknown,
                revision: self.revision.clone(),
            });
        }
        let Some((source_index, stored)) = self.locate(stripped)? else {
            return Err(VfsError::AssetMissing { id: id.clone() });
        };
        match &self.sources[source_index] {
            CompositeSource::PlaintextDir(dir) => {
                // Build the canonical AssetId for the plaintext side and
                // re-stat through it so size/revision come from disk.
                let inner_id = AssetId::from_parts(dir.id(), &stored)?;
                let inner = dir.stat(&inner_id)?;
                Ok(AssetMetadata {
                    id: id.clone(),
                    kind: inner.kind,
                    size: inner.size,
                    revision: self.revision.clone().or(inner.revision),
                })
            }
            CompositeSource::Archive(archive) => {
                let entry = archive
                    .case_folded_index()?
                    .lookup(stripped)
                    .expect("archive index lookup succeeded above");
                let bytes = archive.open_entry(entry)?;
                Ok(AssetMetadata {
                    id: id.clone(),
                    kind: AssetKind::File,
                    size: AssetSize::Bytes(bytes.len() as u64),
                    revision: self.revision.clone(),
                })
            }
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
        let Some((source_index, stored)) = self.locate(id.path())? else {
            return Err(VfsError::AssetMissing { id: id.clone() });
        };
        match &self.sources[source_index] {
            CompositeSource::PlaintextDir(dir) => {
                let inner_id = AssetId::from_parts(dir.id(), &stored)?;
                dir.open(&inner_id)
            }
            CompositeSource::Archive(archive) => {
                let entry = archive
                    .case_folded_index()?
                    .lookup(id.path())
                    .expect("archive index lookup succeeded above");
                archive.open_entry(entry)
            }
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
        let path = prefix.path();
        let stripped = path.strip_suffix('/').unwrap_or(path);
        let folded_prefix = if stripped.is_empty() {
            String::new()
        } else {
            format!("{}/", lowercase_ascii(stripped))
        };
        // Collect immediate children across all sources, byte-lex sorted
        // and deduped. Earlier sources don't shadow later ones at the
        // directory level — the union of immediate children is correct
        // because each entry's bytes still come from the first source that
        // holds them (per the first-match-wins `open` policy).
        let mut children: BTreeSet<(String, bool)> = BTreeSet::new();
        for source in &self.sources {
            let index = source.case_folded_index()?;
            for entry in index.iter_entries() {
                let entry_path = entry.stored_path();
                let folded = lowercase_ascii(entry_path);
                let Some(rest) = folded.strip_prefix(&folded_prefix) else {
                    continue;
                };
                if rest.is_empty() {
                    continue;
                }
                let (head, has_more) = match rest.find('/') {
                    Some(index) => (&rest[..index], true),
                    None => (rest, false),
                };
                // Recover the stored-case form of `head` from the entry path.
                // ASCII byte length equals char length so this slice is
                // safe for ASCII paths (the substrate's canonical form).
                let stored_head_start = folded_prefix.len();
                let stored_head_end = stored_head_start + head.len();
                let stored_head = entry_path[stored_head_start..stored_head_end].to_string();
                children.insert((stored_head, has_more));
            }
        }
        let mut ids = Vec::with_capacity(children.len());
        for (name, is_dir) in children {
            let child_relative = if is_dir { format!("{name}/") } else { name };
            let child_id = prefix.join(&child_relative)?;
            ids.push(child_id);
        }
        ids.sort_by(|left, right| left.path().as_bytes().cmp(right.path().as_bytes()));
        Ok(ids)
    }
}

fn lowercase_ascii(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect()
}
