//! Engine-neutral asset-package boundary.
//!
//! `AssetPackage` is the trait every runtime port implements (or composes via
//! `MountedVfs`) to expose game content to Utsushi runtime adapters. The
//! trait surface is read-only, sync, `Send + Sync`, and engine-neutral; the
//! adapter is responsible for translating its internal store (XP3 readers,
//! a layered Kaifuu pipeline, a plaintext directory, etc.) into the
//! `AssetId`-keyed read model.

use bytes::Bytes;

use super::diagnostics::{VfsError, VfsResult};
use super::id::AssetId;

/// Reference-counted asset byte buffer returned by `RuntimeVfs::open` and
/// `AssetPackage::open`. Cheap to clone across observation hook payloads,
/// snapshots, and recording slices.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetBytes(Bytes);

impl AssetBytes {
    /// Wrap an existing `bytes::Bytes` buffer.
    pub fn new(bytes: Bytes) -> Self {
        Self(bytes)
    }

    /// Borrow the asset bytes as a slice.
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    /// Length in bytes.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the asset has zero bytes. Provided so clippy's
    /// `len_without_is_empty` lint is satisfied.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Consume the wrapper and return the underlying `bytes::Bytes`.
    pub fn into_bytes(self) -> Bytes {
        self.0
    }

    /// Construct an `AssetBytes` from a `'static` byte slice. Cheap (no copy).
    pub fn from_static(bytes: &'static [u8]) -> Self {
        Self(Bytes::from_static(bytes))
    }
}

impl From<Vec<u8>> for AssetBytes {
    fn from(value: Vec<u8>) -> Self {
        Self(Bytes::from(value))
    }
}

impl From<Bytes> for AssetBytes {
    fn from(value: Bytes) -> Self {
        Self(value)
    }
}

impl AsRef<[u8]> for AssetBytes {
    fn as_ref(&self) -> &[u8] {
        self.as_slice()
    }
}

/// Metadata-only view of an asset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetMetadata {
    pub id: AssetId,
    pub kind: AssetKind,
    pub size: AssetSize,
    /// Content hash or revision id where cheap to compute.
    pub revision: Option<String>,
}

/// File vs directory discriminant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AssetKind {
    File,
    Directory,
}

impl AssetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }
}

/// Size accounting for an asset.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AssetSize {
    Bytes(u64),
    Unknown,
}

/// Case-sensitivity rule applied when resolving logical paths against the
/// package's id namespace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CaseRule {
    /// Byte-identical, e.g. XP3.
    Sensitive,
    /// ASCII case-insensitive, e.g. RPG Maker `www/` on Windows hosts.
    InsensitiveAscii,
}

impl CaseRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sensitive => "sensitive",
            Self::InsensitiveAscii => "insensitive_ascii",
        }
    }
}

/// Engine-neutral discriminant on the package shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PackageKind {
    Plaintext,
    Archive,
    Composite,
}

impl PackageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plaintext => "plaintext",
            Self::Archive => "archive",
            Self::Composite => "composite",
        }
    }
}

/// Public, redacted source identifier for a package. Never a host path.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum PackageSource {
    /// A redacted public name for the source, e.g.
    /// `"public-fixture:hello-game"`, `"vault:cat-cave/utsushi-fixture"`.
    PublicName(String),
}

impl PackageSource {
    pub fn as_str(&self) -> &str {
        match self {
            Self::PublicName(name) => name.as_str(),
        }
    }
}

/// Public descriptor for a mounted package. Carries only the redacted source
/// name and engine-neutral classification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageDescriptor {
    pub id: String,
    pub kind: PackageKind,
    pub case_rule: CaseRule,
    pub source: PackageSource,
    pub revision: Option<String>,
}

/// Engine-neutral, read-only asset-package boundary.
///
/// Implementors MUST:
/// - Treat all logical paths as relative to the package root.
/// - Reject traversal (`..`, absolute roots, NUL, control characters) in
///   `resolve` BEFORE touching the underlying store.
/// - Return `VfsError::AssetEncrypted` or `VfsError::AssetHelperGated` rather
///   than panicking or returning partial / placeholder bytes.
/// - Sort `list` output byte-lexicographically on the path portion of the
///   returned `AssetId`s so traces are deterministic.
/// - Never include host paths in any returned `VfsError`.
pub trait AssetPackage: Send + Sync {
    /// Stable package identifier used inside [`AssetId`].
    fn id(&self) -> &str;

    /// Public descriptor for this package.
    fn descriptor(&self) -> PackageDescriptor;

    /// Case-sensitivity rule for this package.
    fn case_rule(&self) -> CaseRule;

    /// Resolve a package-relative logical path to an [`AssetId`].
    fn resolve(&self, logical: &str) -> VfsResult<AssetId>;

    /// Whether the asset exists and is openable for read.
    fn exists(&self, id: &AssetId) -> VfsResult<bool>;

    /// Metadata-only lookup. Does not decrypt or call helpers.
    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata>;

    /// Open an asset for read. Encrypted, helper-gated, or unsupported
    /// variants MUST return the appropriate [`VfsError`] variant rather than
    /// partial or placeholder bytes.
    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes>;

    /// List immediate children under a directory-shaped asset id. Returns
    /// asset ids in byte-lexicographic order.
    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>>;
}

/// Helper for engine adapters: apply the package's [`CaseRule`] when matching
/// a stored name against the resolution request.
pub fn case_rule_matches(rule: CaseRule, stored: &str, requested: &str) -> bool {
    match rule {
        CaseRule::Sensitive => stored == requested,
        CaseRule::InsensitiveAscii => stored.eq_ignore_ascii_case(requested),
    }
}

/// Helper: validate a logical path against the canonical asset-id grammar
/// rules. Returns a `VfsError::AssetPathUnsafe` for each forbidden pattern,
/// distinct from the parse-level `InvalidAssetId` because the source is an
/// engine-supplied logical, not a wire-format id.
pub fn validate_logical_path(package: &str, logical: &str) -> Result<String, VfsError> {
    use super::diagnostics::TraversalKind;

    if logical.is_empty() {
        return Err(VfsError::AssetPathUnsafe {
            package: package.to_string(),
            logical: logical.to_string(),
            kind: TraversalKind::EmptySegment,
        });
    }

    if logical.contains('\0') {
        return Err(VfsError::AssetPathUnsafe {
            package: package.to_string(),
            logical: logical.to_string(),
            kind: TraversalKind::NulByte,
        });
    }
    if logical.contains('\\') {
        return Err(VfsError::AssetPathUnsafe {
            package: package.to_string(),
            logical: logical.to_string(),
            kind: TraversalKind::BackslashSeparator,
        });
    }
    if logical.starts_with('/') {
        return Err(VfsError::AssetPathUnsafe {
            package: package.to_string(),
            logical: logical.to_string(),
            kind: TraversalKind::AbsoluteRoot,
        });
    }
    // Windows drive letter (e.g. "C:/...").
    let bytes = logical.as_bytes();
    if bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes
            .get(2)
            .is_some_and(|byte| *byte == b'/' || *byte == b'\\')
    {
        return Err(VfsError::AssetPathUnsafe {
            package: package.to_string(),
            logical: logical.to_string(),
            kind: TraversalKind::AbsoluteRoot,
        });
    }

    for character in logical.chars() {
        let codepoint = character as u32;
        if codepoint < 0x20 || codepoint == 0x7F {
            return Err(VfsError::AssetPathUnsafe {
                package: package.to_string(),
                logical: logical.to_string(),
                kind: TraversalKind::ControlCharacter,
            });
        }
    }

    // A trailing `/` is preserved (directory id).
    let (working, trailing) = match logical.strip_suffix('/') {
        Some(rest) => (rest, true),
        None => (logical, false),
    };
    if working.is_empty() {
        return Err(VfsError::AssetPathUnsafe {
            package: package.to_string(),
            logical: logical.to_string(),
            kind: TraversalKind::EmptySegment,
        });
    }
    for segment in working.split('/') {
        if segment.is_empty() {
            return Err(VfsError::AssetPathUnsafe {
                package: package.to_string(),
                logical: logical.to_string(),
                kind: TraversalKind::EmptySegment,
            });
        }
        if segment == ".." {
            return Err(VfsError::AssetPathUnsafe {
                package: package.to_string(),
                logical: logical.to_string(),
                kind: TraversalKind::ParentEscape,
            });
        }
        if segment.len() > super::id::MAX_ASSET_ID_SEGMENT_BYTES {
            return Err(VfsError::AssetPathUnsafe {
                package: package.to_string(),
                logical: logical.to_string(),
                kind: TraversalKind::OverlongSegment,
            });
        }
        // `.` is the no-op current-directory segment; reject because it
        // would change the canonical form on round-trip.
        if segment == "." {
            return Err(VfsError::AssetPathUnsafe {
                package: package.to_string(),
                logical: logical.to_string(),
                kind: TraversalKind::EmptySegment,
            });
        }
    }

    let canonical = if trailing {
        format!("{working}/")
    } else {
        working.to_string()
    };
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::diagnostics::TraversalKind;

    #[test]
    fn asset_bytes_round_trip_preserves_contents() {
        let original = b"abcd";
        let bytes = AssetBytes::from(original.to_vec());
        assert_eq!(bytes.as_slice(), original);
        assert_eq!(bytes.len(), 4);
        assert!(!bytes.is_empty());
        let inner = bytes.into_bytes();
        assert_eq!(inner.as_ref(), original);
    }

    #[test]
    fn case_rule_matches_sensitive_rejects_case_mismatch() {
        assert!(case_rule_matches(CaseRule::Sensitive, "Foo", "Foo"));
        assert!(!case_rule_matches(CaseRule::Sensitive, "Foo", "foo"));
    }

    #[test]
    fn case_rule_matches_insensitive_ascii_accepts_uppercase_request() {
        assert!(case_rule_matches(
            CaseRule::InsensitiveAscii,
            "intro.txt",
            "INTRO.TXT"
        ));
    }

    #[test]
    fn validate_logical_path_rejects_dot_dot_at_start() {
        let err = validate_logical_path("hello", "../etc/passwd").unwrap_err();
        match err {
            VfsError::AssetPathUnsafe { kind, .. } => {
                assert_eq!(kind, TraversalKind::ParentEscape);
            }
            other => panic!("expected AssetPathUnsafe, got {other:?}"),
        }
    }

    #[test]
    fn validate_logical_path_rejects_dot_dot_after_segment() {
        let err = validate_logical_path("hello", "foo/../bar").unwrap_err();
        match err {
            VfsError::AssetPathUnsafe { kind, .. } => {
                assert_eq!(kind, TraversalKind::ParentEscape);
            }
            other => panic!("expected AssetPathUnsafe, got {other:?}"),
        }
    }

    #[test]
    fn validate_logical_path_rejects_absolute_unix_root() {
        let err = validate_logical_path("hello", "/etc/passwd").unwrap_err();
        match err {
            VfsError::AssetPathUnsafe { kind, .. } => {
                assert_eq!(kind, TraversalKind::AbsoluteRoot);
            }
            other => panic!("expected AssetPathUnsafe, got {other:?}"),
        }
    }

    #[test]
    fn validate_logical_path_rejects_windows_drive_root() {
        let err = validate_logical_path("hello", "C:/Windows/system32").unwrap_err();
        match err {
            VfsError::AssetPathUnsafe { kind, .. } => {
                assert_eq!(kind, TraversalKind::AbsoluteRoot);
            }
            other => panic!("expected AssetPathUnsafe, got {other:?}"),
        }
    }

    #[test]
    fn validate_logical_path_rejects_backslash_separator() {
        let err = validate_logical_path("hello", "foo\\bar").unwrap_err();
        match err {
            VfsError::AssetPathUnsafe { kind, .. } => {
                assert_eq!(kind, TraversalKind::BackslashSeparator);
            }
            other => panic!("expected AssetPathUnsafe, got {other:?}"),
        }
    }

    #[test]
    fn validate_logical_path_rejects_nul_byte() {
        let err = validate_logical_path("hello", "foo\0bar").unwrap_err();
        match err {
            VfsError::AssetPathUnsafe { kind, .. } => {
                assert_eq!(kind, TraversalKind::NulByte);
            }
            other => panic!("expected AssetPathUnsafe, got {other:?}"),
        }
    }

    #[test]
    fn validate_logical_path_accepts_well_formed_relative_path() {
        let canonical = validate_logical_path("hello", "nested/glyph.txt").unwrap();
        assert_eq!(canonical, "nested/glyph.txt");
    }

    #[test]
    fn validate_logical_path_preserves_trailing_slash() {
        let canonical = validate_logical_path("hello", "nested/").unwrap();
        assert_eq!(canonical, "nested/");
    }
}
