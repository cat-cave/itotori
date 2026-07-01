//! Synthetic integration tests for the composite asset package
//! introduced by substrate extension M.1 (UTSUSHI-222).
//!
//! These tests don't require real-byte corpora: they exercise the
//! first-match-wins resolution policy, case-folded indexing, and
//! lazy-cache invariant of the sealed [`AssetArchiveReader`] trait via
//! an in-test fake reader. The real-bytes multi-engine validation lives
//! in `composite_asset_package_real_bytes.rs`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

// Reach through the `#[doc(hidden)]` seal to fake-implement the archive
// reader. The seal is conventionally "do not implement" for production
// callers; the in-tree integration test is the carve-out described in
// the seal's docstring.
#[allow(unused_imports)]
use utsushi_core::vfs::archive::sealed::Sealed;
use utsushi_core::{
    AssetArchiveReader, AssetBytes, AssetPackage, CaseFoldedIndex, CaseFoldedIndexEntry, CaseRule,
    CompositeAssetPackage, PackageKind, PackageSource, PlaintextDirPackage, VfsError, VfsResult,
};

/// In-test sealed archive reader. Built around a static map of
/// `stored_path -> bytes`. Reaches through the substrate's
/// `#[doc(hidden)]` seal to fake-implement [`AssetArchiveReader`] —
/// production callers never do this. See `archive::sealed` docstring.
#[derive(Debug)]
struct FakeArchiveReader {
    label: String,
    entries: HashMap<String, Vec<u8>>,
    index: std::sync::OnceLock<CaseFoldedIndex>,
    index_build_count: AtomicUsize,
    open_count: AtomicUsize,
}

impl FakeArchiveReader {
    fn new(label: impl Into<String>, entries: HashMap<String, Vec<u8>>) -> Self {
        Self {
            label: label.into(),
            entries,
            index: std::sync::OnceLock::new(),
            index_build_count: AtomicUsize::new(0),
            open_count: AtomicUsize::new(0),
        }
    }

    fn index_build_count(&self) -> usize {
        self.index_build_count.load(Ordering::SeqCst)
    }

    fn open_count(&self) -> usize {
        self.open_count.load(Ordering::SeqCst)
    }
}

// Sealed via the substrate's pub(crate) seal — only reachable because the
// `sealed` module is re-exported below via `pub use` in `utsushi_core::vfs`.
// In production this seal keeps `AssetArchiveReader` unimplementable
// outside the crate; in tests we deliberately reach through to prove
// the composite's invariants.
impl Sealed for FakeArchiveReader {}

impl AssetArchiveReader for FakeArchiveReader {
    fn source_label(&self) -> &str {
        &self.label
    }

    fn case_folded_index(&self) -> VfsResult<&CaseFoldedIndex> {
        Ok(self.index.get_or_init(|| {
            self.index_build_count.fetch_add(1, Ordering::SeqCst);
            let mut index = CaseFoldedIndex::new();
            let mut keys: Vec<&String> = self.entries.keys().collect();
            keys.sort();
            for key in keys {
                index.insert(key.clone());
            }
            index
        }))
    }

    fn open_entry(&self, entry: &CaseFoldedIndexEntry) -> VfsResult<AssetBytes> {
        self.open_count.fetch_add(1, Ordering::SeqCst);
        match self.entries.get(entry.stored_path()) {
            Some(bytes) => Ok(AssetBytes::from(bytes.clone())),
            None => Err(VfsError::AssetMissing {
                id: utsushi_core::AssetId::from_parts("fake-archive", entry.stored_path())?,
            }),
        }
    }
}

fn temp_plaintext_dir(entries: &[(&str, &str)]) -> (tempfile::TempDir, PlaintextDirPackage) {
    let temp = tempfile::tempdir().unwrap();
    for (relative, contents) in entries {
        let host = temp.path().join(relative);
        if let Some(parent) = host.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&host, contents).unwrap();
    }
    let package = PlaintextDirPackage::new(
        "plaintext-source",
        temp.path(),
        CaseRule::InsensitiveAscii,
        PackageSource::PublicName("public-fixture:plaintext-source".to_string()),
    );
    (temp, package)
}

fn fake_archive(entries: &[(&str, &[u8])]) -> Arc<FakeArchiveReader> {
    let entries = entries
        .iter()
        .map(|(path, bytes)| ((*path).to_string(), bytes.to_vec()))
        .collect();
    Arc::new(FakeArchiveReader::new(
        "public-fixture:fake-archive",
        entries,
    ))
}

fn composite() -> CompositeAssetPackage {
    CompositeAssetPackage::new(
        "composite",
        PackageSource::PublicName("public-fixture:composite".to_string()),
    )
}

#[test]
fn composite_with_only_plaintext_resolves_real_file() {
    let (_temp, dir) = temp_plaintext_dir(&[("g00/bg01a1.g00", "fake-image-bytes")]);
    let mut composite = composite();
    composite.push_plaintext_dir(Arc::new(dir));

    let id = composite.resolve("g00/bg01a1.g00").unwrap();
    assert_eq!(id.path(), "g00/bg01a1.g00");
    let bytes = composite.open(&id).unwrap();
    assert_eq!(bytes.as_slice(), b"fake-image-bytes");
}

#[test]
fn composite_with_only_archive_resolves_via_archive_entry() {
    let archive = fake_archive(&[("g00/bg01a1.g00", b"archive-image-bytes")]);
    let mut composite = composite();
    composite.push_archive(archive.clone());

    let id = composite.resolve("g00/bg01a1.g00").unwrap();
    assert_eq!(id.path(), "g00/bg01a1.g00");
    let bytes = composite.open(&id).unwrap();
    assert_eq!(bytes.as_slice(), b"archive-image-bytes");
    assert_eq!(archive.open_count(), 1);
}

#[test]
fn composite_first_match_wins_when_plaintext_listed_before_archive() {
    // Logical path exists in both sources; plaintext is registered first.
    let (_temp, dir) = temp_plaintext_dir(&[("data/system.json", "plaintext-bytes")]);
    let archive = fake_archive(&[("data/system.json", b"archive-bytes")]);
    let mut composite = composite();
    composite.push_plaintext_dir(Arc::new(dir));
    composite.push_archive(archive);

    let id = composite.resolve("data/system.json").unwrap();
    let bytes = composite.open(&id).unwrap();
    assert_eq!(
        bytes.as_slice(),
        b"plaintext-bytes",
        "first-match-wins must prefer the earlier-registered source"
    );
}

#[test]
fn composite_falls_through_to_archive_when_plaintext_lacks_entry() {
    // Logical path is only in the archive; plaintext source is still
    // listed first to prove the resolver walks past it.
    let (_temp, dir) = temp_plaintext_dir(&[("data/other.json", "decoy")]);
    let archive = fake_archive(&[("data/system.json", b"archive-only-bytes")]);
    let mut composite = composite();
    composite.push_plaintext_dir(Arc::new(dir));
    composite.push_archive(archive);

    let id = composite.resolve("data/system.json").unwrap();
    let bytes = composite.open(&id).unwrap();
    assert_eq!(bytes.as_slice(), b"archive-only-bytes");
}

#[test]
fn composite_case_folding_resolves_mixed_case_request_to_stored_case_id() {
    let (_temp, dir) = temp_plaintext_dir(&[("G00/BG01A1.G00", "ucbytes")]);
    let mut composite = composite();
    composite.push_plaintext_dir(Arc::new(dir));

    let uppercase = composite.resolve("G00/BG01A1.G00").unwrap();
    let lowercase = composite.resolve("g00/bg01a1.g00").unwrap();
    assert_eq!(
        uppercase.path(),
        lowercase.path(),
        "case-folded lookup must recover the same canonical stored path"
    );
    // The stored case wins on the canonical id.
    assert_eq!(uppercase.path(), "G00/BG01A1.G00");
}

#[test]
fn composite_case_folding_in_archive_source() {
    let archive = fake_archive(&[("DATA/System.JSON", b"archive-bytes")]);
    let mut composite = composite();
    composite.push_archive(archive);

    let id = composite.resolve("data/system.json").unwrap();
    assert_eq!(
        id.path(),
        "DATA/System.JSON",
        "archive case-folding must recover the archive's stored casing"
    );
}

#[test]
fn composite_resolve_missing_path_returns_asset_missing() {
    let (_temp, dir) = temp_plaintext_dir(&[("intro.txt", "hi")]);
    let archive = fake_archive(&[("g00/other.g00", b"x")]);
    let mut composite = composite();
    composite.push_plaintext_dir(Arc::new(dir));
    composite.push_archive(archive);

    let err = composite.resolve("not-anywhere.bin").unwrap_err();
    assert!(matches!(err, VfsError::AssetMissing { .. }));
}

#[test]
fn composite_archive_index_is_built_once_across_many_resolves() {
    let archive = fake_archive(&[
        ("entry1.bin", b"a"),
        ("entry2.bin", b"b"),
        ("entry3.bin", b"c"),
    ]);
    let counter_handle = archive.clone();
    let mut composite = composite();
    composite.push_archive(archive);

    for path in ["entry1.bin", "entry2.bin", "entry3.bin", "entry1.bin"] {
        let _ = composite.resolve(path).unwrap();
    }
    assert_eq!(
        counter_handle.index_build_count(),
        1,
        "AssetArchiveReader::case_folded_index must be lazily built exactly once \
         no matter how many resolves run"
    );
}

#[test]
fn composite_descriptor_reports_composite_kind_and_insensitive_ascii_case_rule() {
    let composite = composite();
    let descriptor = composite.descriptor();
    assert_eq!(descriptor.id, "composite");
    assert_eq!(descriptor.kind, PackageKind::Composite);
    assert_eq!(descriptor.case_rule, CaseRule::InsensitiveAscii);
}

#[test]
fn composite_list_merges_immediate_children_across_sources() {
    let (_temp, dir) = temp_plaintext_dir(&[("a.txt", "x"), ("b.txt", "y")]);
    let archive = fake_archive(&[("c.bin", b"z"), ("d.bin", b"w")]);
    let mut composite = composite();
    composite.push_plaintext_dir(Arc::new(dir));
    composite.push_archive(archive);

    let root = utsushi_core::AssetId::from_parts("composite", "").unwrap();
    let children = composite.list(&root).unwrap();
    let names: Vec<&str> = children.iter().map(utsushi_core::AssetId::path).collect();
    assert_eq!(names, vec!["a.txt", "b.txt", "c.bin", "d.bin"]);
}
