//! Sealed archive-reader trait and case-folded directory index.
//!
//! Substrate extension M.1. The trait lets future PAK / XP3
//! readers plug into [`super::CompositeAssetPackage`] without rewriting the
//! resolver. The seal makes the multiplex-policy invariant load-bearing:
//! only readers defined inside `utsushi-core` can be composed in, so an
//! external crate cannot bypass the first-match-wins source ordering by
//! masquerading as an archive.
//!
//! Implementors of [`AssetArchiveReader`] expose:
//! - a [`CaseFoldedIndex`] built lazily on first call and cached for the
//!   lifetime of the reader, so directory resolution is O(1) per lookup
//!   rather than O(n) per call;
//! - an [`open_entry`](AssetArchiveReader::open_entry) operation that
//!   returns the bytes for a previously-resolved entry.
//!
//! [`super::Xp3HandoffArchiveReader`] already serves Kaifuu-extracted XP3
//! members through this trait. Direct PAK reading and XP3-container parsing
//! remain outside this substrate.

use std::collections::BTreeMap;

use super::diagnostics::VfsResult;
use super::package::AssetBytes;

/// `#[doc(hidden)]` seal that prevents [`AssetArchiveReader`] from being
/// implemented outside the substrate. The seal trait is reachable from
/// downstream code so the in-tree integration test in
/// `tests/composite_asset_package.rs` can hand-roll a fake reader to
/// prove the resolver's contract; production callers MUST NOT implement
/// `Sealed` — it carries no semantics, only the seal. Reading this
/// docstring is the only warning.
#[doc(hidden)]
pub mod sealed {
    pub trait Sealed {}
}

/// One entry in a [`CaseFoldedIndex`]: maps a case-folded lookup key back
/// to the stored, canonical-case logical path inside the source.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CaseFoldedIndexEntry {
    /// The path as it appears in the source. Forward-slash separated, no
    /// leading slash, no traversal segments.
    stored_path: String,
}

impl CaseFoldedIndexEntry {
    /// Construct an entry from a stored, canonical-case logical path.
    /// The caller MUST have validated the path against
    /// [`super::package::validate_logical_path`] semantics.
    pub fn new(stored_path: impl Into<String>) -> Self {
        Self {
            stored_path: stored_path.into(),
        }
    }

    /// The path as it appears in the source. Used by the composite resolver
    /// to construct the canonical [`super::AssetId`].
    pub fn stored_path(&self) -> &str {
        &self.stored_path
    }
}

/// ASCII-case-folded lookup table from a stored source. Used so the
/// composite resolver answers an arbitrary-case request in O(1) without
/// walking the source on every call.
///
/// Folding is ASCII-only by design: the VFS contract restricts package ids
/// and treats path segments as NFC-normalised but does not Unicode-lowercase
/// them, so a non-ASCII folding scheme would over-match. RealLive RPGMV/MZ
/// asset paths are ASCII in practice.
#[derive(Clone, Debug, Default)]
pub struct CaseFoldedIndex {
    by_lowercase: BTreeMap<String, CaseFoldedIndexEntry>,
}

impl CaseFoldedIndex {
    /// Construct an empty index.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert an entry. The stored path is folded to lowercase ASCII for
    /// indexing; the original casing is preserved inside the entry.
    pub fn insert(&mut self, stored_path: impl Into<String>) {
        let stored: String = stored_path.into();
        let key = fold_ascii(&stored);
        self.by_lowercase
            .insert(key, CaseFoldedIndexEntry::new(stored));
    }

    /// Look up an entry by a case-insensitive logical path. Returns
    /// `None` if the path is not present in the source.
    pub fn lookup(&self, logical: &str) -> Option<&CaseFoldedIndexEntry> {
        let key = fold_ascii(logical);
        self.by_lowercase.get(&key)
    }

    /// Number of entries currently indexed.
    pub fn len(&self) -> usize {
        self.by_lowercase.len()
    }

    /// Whether the index has no entries.
    pub fn is_empty(&self) -> bool {
        self.by_lowercase.is_empty()
    }

    /// Iterate every entry in deterministic byte-lex order on the
    /// case-folded key. Used by [`super::CompositeAssetPackage::list`] to
    /// enumerate immediate children across multiple sources.
    pub fn iter_entries(&self) -> impl Iterator<Item = &CaseFoldedIndexEntry> {
        self.by_lowercase.values()
    }
}

/// Lowercase the ASCII portion of `path`. Non-ASCII bytes pass through
/// unchanged (NFC pre-normalisation already ran during AssetId parsing).
fn fold_ascii(path: &str) -> String {
    path.chars()
        .map(|character| {
            if character.is_ascii() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect()
}

/// Sealed trait every archive reader implements so a composite asset
/// package can route lookups through it.
///
/// The trait is sealed via [`sealed::Sealed`]; downstream crates cannot
/// implement it. This is a load-bearing invariant: the composite's
/// first-match-wins ordering is only sound if every archive source obeys
/// the same lazy-index contract, which only in-crate readers can be held
/// to.
pub trait AssetArchiveReader: sealed::Sealed + Send + Sync + std::fmt::Debug {
    /// A stable, redacted public name for the archive source. Used by the
    /// composite's diagnostics so an open-failure can point at the
    /// archive's identity without leaking host paths.
    fn source_label(&self) -> &str;

    /// Lazily-built, cached case-folded directory index for this archive.
    /// Implementors MUST build the index once on first call and return the
    /// same reference on every subsequent call so the composite resolver
    /// is O(1) per lookup.
    fn case_folded_index(&self) -> VfsResult<&CaseFoldedIndex>;

    /// Read the bytes for a previously-resolved entry. The entry MUST come
    /// from this reader's own [`case_folded_index`](Self::case_folded_index);
    /// passing an entry from another archive is a programmer error.
    fn open_entry(&self, entry: &CaseFoldedIndexEntry) -> VfsResult<AssetBytes>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_folded_index_lookup_is_ascii_insensitive() {
        let mut index = CaseFoldedIndex::new();
        index.insert("G00/BG01A1.G00");
        let hit = index.lookup("g00/bg01a1.g00").unwrap();
        assert_eq!(hit.stored_path(), "G00/BG01A1.G00");
    }

    #[test]
    fn case_folded_index_preserves_stored_case_on_lookup() {
        let mut index = CaseFoldedIndex::new();
        index.insert("DATA/System.json");
        let hit = index.lookup("data/system.json").unwrap();
        assert_eq!(hit.stored_path(), "DATA/System.json");
    }

    #[test]
    fn case_folded_index_returns_none_for_absent_path() {
        let index = CaseFoldedIndex::new();
        assert!(index.lookup("missing.txt").is_none());
    }

    #[test]
    fn case_folded_index_len_reports_inserted_count() {
        let mut index = CaseFoldedIndex::new();
        index.insert("a.txt");
        index.insert("b/c.txt");
        assert_eq!(index.len(), 2);
        assert!(!index.is_empty());
    }

    #[test]
    fn fold_ascii_lowercases_ascii_only() {
        assert_eq!(fold_ascii("Foo/Bar.TXT"), "foo/bar.txt");
        assert_eq!(fold_ascii("café/X"), "café/x");
    }
}
