//! Canonical, engine-neutral asset identifier.
//!
//! Wire form: `vfs://<package-id>/<normalized-path>`
//!
//! Grammar:
//! - `package-id` matches `[a-z0-9][a-z0-9._-]{0,62}` (ASCII, lowercase).
//! - `normalized-path` uses forward slashes only.
//! - No path segment is empty, `.`, or `..`.
//! - Segments are NFC-normalized.
//! - Control characters (`U+0000..U+001F`, `U+007F`) are rejected.
//! - Backslash separators are rejected (use `/`).
//! - A single trailing `/` is permitted to denote a directory id.
//! - Leading slash is rejected after the scheme separator.
//! - Maximum total length is `MAX_ASSET_ID_BYTES` (4096) bytes.
//! - Maximum single segment length is `MAX_ASSET_ID_SEGMENT_BYTES` (255) bytes.

use std::sync::Arc;

use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfc_quick};

use super::diagnostics::{AssetIdErrorReason, VfsError, VfsResult};

/// Maximum total length of the textual form of an [`AssetId`].
pub const MAX_ASSET_ID_BYTES: usize = 4096;

/// Maximum length of a single path segment.
pub const MAX_ASSET_ID_SEGMENT_BYTES: usize = 255;

/// Maximum length of a package id.
pub const MAX_PACKAGE_ID_BYTES: usize = 63;

const VFS_SCHEME: &str = "vfs://";

/// Canonical, engine-neutral asset identifier.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct AssetId {
    inner: Arc<str>,
    package_end: usize,
    path_start: usize,
}

impl AssetId {
    /// Parse a textual `vfs://<package>/<path>` form into an [`AssetId`].
    ///
    /// Performs NFC normalization on the path portion. The package id must
    /// already be lowercase ASCII and is not normalized.
    pub fn parse(raw: &str) -> VfsResult<Self> {
        if raw.len() > MAX_ASSET_ID_BYTES {
            return Err(VfsError::InvalidAssetId {
                raw: raw.to_string(),
                reason: AssetIdErrorReason::OverlongTotal,
            });
        }

        let Some(rest) = raw.strip_prefix(VFS_SCHEME) else {
            return Err(VfsError::InvalidAssetId {
                raw: raw.to_string(),
                reason: AssetIdErrorReason::MissingScheme,
            });
        };

        let (package, path) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index + 1..]),
            None => (rest, ""),
        };

        validate_package_id(package).map_err(|reason| VfsError::InvalidAssetId {
            raw: raw.to_string(),
            reason,
        })?;

        let normalized_path =
            validate_and_normalize_path(path).map_err(|reason| VfsError::InvalidAssetId {
                raw: raw.to_string(),
                reason,
            })?;

        let canonical = format!("{VFS_SCHEME}{package}/{normalized_path}");
        if canonical.len() > MAX_ASSET_ID_BYTES {
            return Err(VfsError::InvalidAssetId {
                raw: raw.to_string(),
                reason: AssetIdErrorReason::OverlongTotal,
            });
        }

        let package_end = VFS_SCHEME.len() + package.len();
        let path_start = package_end + 1;

        Ok(Self {
            inner: Arc::from(canonical),
            package_end,
            path_start,
        })
    }

    /// Construct an asset id directly from package and path components.
    /// Performs the same validation as [`AssetId::parse`].
    pub fn from_parts(package: &str, path: &str) -> VfsResult<Self> {
        let raw = if path.is_empty() {
            format!("{VFS_SCHEME}{package}/")
        } else {
            format!("{VFS_SCHEME}{package}/{path}")
        };
        Self::parse(&raw)
    }

    /// The package id portion (e.g. `"www"`).
    pub fn package(&self) -> &str {
        &self.inner[VFS_SCHEME.len()..self.package_end]
    }

    /// The package-relative path portion using forward slashes.
    /// Empty string for the package root, may end in `/` for directories.
    pub fn path(&self) -> &str {
        &self.inner[self.path_start..]
    }

    /// The full textual `vfs://...` form.
    pub fn as_str(&self) -> &str {
        &self.inner
    }

    /// Whether the id refers to the package root (`vfs://<package>/`).
    pub fn is_package_root(&self) -> bool {
        self.path().is_empty()
    }

    /// Whether the id is directory-shaped (trailing `/` or package root).
    pub fn is_directory(&self) -> bool {
        let path = self.path();
        path.is_empty() || path.ends_with('/')
    }

    /// Append a child path segment (relative, no leading slash).
    /// The child is validated and NFC-normalized like a normal parse.
    pub fn join(&self, child: &str) -> VfsResult<Self> {
        let prefix = self.path();
        let combined = if prefix.is_empty() || prefix.ends_with('/') {
            format!("{prefix}{child}")
        } else {
            format!("{prefix}/{child}")
        };
        Self::from_parts(self.package(), &combined)
    }

    /// Return the parent directory id, or `None` for the package root.
    pub fn parent(&self) -> Option<Self> {
        let path = self.path();
        if path.is_empty() {
            return None;
        }
        // Strip a trailing slash before looking for the last separator.
        let trimmed = path.strip_suffix('/').unwrap_or(path);
        let parent_path = match trimmed.rfind('/') {
            Some(index) => &trimmed[..=index],
            None => "",
        };
        // Use from_parts so the parent is a well-formed directory id.
        Self::from_parts(self.package(), parent_path).ok()
    }
}

impl std::fmt::Display for AssetId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl serde::Serialize for AssetId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> serde::Deserialize<'de> for AssetId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

fn validate_package_id(package: &str) -> Result<(), AssetIdErrorReason> {
    if package.is_empty() {
        return Err(AssetIdErrorReason::EmptyPackage);
    }
    if package.len() > MAX_PACKAGE_ID_BYTES {
        return Err(AssetIdErrorReason::OverlongSegment);
    }
    let bytes = package.as_bytes();
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err(AssetIdErrorReason::BadPackageChar);
    }
    for byte in &bytes[1..] {
        let valid = byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || *byte == b'.'
            || *byte == b'_'
            || *byte == b'-';
        if !valid {
            return Err(AssetIdErrorReason::BadPackageChar);
        }
    }
    Ok(())
}

fn validate_and_normalize_path(path: &str) -> Result<String, AssetIdErrorReason> {
    if path.is_empty() {
        return Ok(String::new());
    }

    if path.starts_with('/') {
        // Leading slash means we had `vfs://pkg//...` — empty first segment.
        return Err(AssetIdErrorReason::EmptySegment);
    }

    // A single trailing slash is allowed (directory id); strip for segment
    // iteration, then re-attach.
    let (working, trailing) = match path.strip_suffix('/') {
        Some(stripped) => (stripped, true),
        None => (path, false),
    };

    if working.is_empty() {
        // Path was exactly `/` — empty segment.
        return Err(AssetIdErrorReason::EmptySegment);
    }

    let mut normalized_segments = Vec::new();
    for segment in working.split('/') {
        normalized_segments.push(validate_segment(segment)?);
    }

    let joined = normalized_segments.join("/");
    let result = if trailing {
        format!("{joined}/")
    } else {
        joined
    };
    Ok(result)
}

fn validate_segment(segment: &str) -> Result<String, AssetIdErrorReason> {
    if segment.is_empty() {
        return Err(AssetIdErrorReason::EmptySegment);
    }
    if segment == "." {
        return Err(AssetIdErrorReason::DotSegment);
    }
    if segment == ".." {
        return Err(AssetIdErrorReason::ParentSegment);
    }
    if segment.len() > MAX_ASSET_ID_SEGMENT_BYTES {
        return Err(AssetIdErrorReason::OverlongSegment);
    }
    for character in segment.chars() {
        let codepoint = character as u32;
        if character == '\0' {
            return Err(AssetIdErrorReason::NulByte);
        }
        if character == '\\' {
            return Err(AssetIdErrorReason::BackslashSeparator);
        }
        if codepoint < 0x20 || codepoint == 0x7F {
            return Err(AssetIdErrorReason::ControlCharacter);
        }
    }

    let normalized: String = match is_nfc_quick(segment.chars()) {
        IsNormalized::Yes => segment.to_string(),
        _ => segment.nfc().collect(),
    };
    if normalized.len() > MAX_ASSET_ID_SEGMENT_BYTES {
        return Err(AssetIdErrorReason::OverlongSegment);
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_well_formed_vfs_uri() {
        let id = AssetId::parse("vfs://hello/intro.txt").unwrap();
        assert_eq!(id.package(), "hello");
        assert_eq!(id.path(), "intro.txt");
        assert_eq!(id.as_str(), "vfs://hello/intro.txt");
    }

    #[test]
    fn parse_accepts_package_root_with_trailing_slash() {
        let id = AssetId::parse("vfs://hello/").unwrap();
        assert!(id.is_package_root());
        assert!(id.is_directory());
        assert_eq!(id.path(), "");
    }

    #[test]
    fn parse_accepts_directory_id_with_trailing_slash() {
        let id = AssetId::parse("vfs://hello/nested/").unwrap();
        assert!(id.is_directory());
        assert_eq!(id.path(), "nested/");
    }

    #[test]
    fn parse_rejects_non_vfs_scheme() {
        let error = AssetId::parse("file:///etc/passwd").unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::MissingScheme);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_empty_package_id() {
        let error = AssetId::parse("vfs:///intro.txt").unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::EmptyPackage);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_uppercase_in_package_id() {
        let error = AssetId::parse("vfs://Hello/intro.txt").unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::BadPackageChar);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_path_segments_containing_backslash() {
        let error = AssetId::parse("vfs://hello/foo\\bar").unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::BackslashSeparator);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_parent_segment_anywhere() {
        for raw in [
            "vfs://hello/../etc/passwd",
            "vfs://hello/foo/../bar",
            "vfs://hello/foo/..",
        ] {
            let error = AssetId::parse(raw).unwrap_err();
            match error {
                VfsError::InvalidAssetId { reason, .. } => {
                    assert_eq!(
                        reason,
                        AssetIdErrorReason::ParentSegment,
                        "raw input: {raw}"
                    );
                }
                other => panic!("expected InvalidAssetId, got {other:?}"),
            }
        }
    }

    #[test]
    fn parse_rejects_dot_segment_anywhere() {
        let error = AssetId::parse("vfs://hello/./foo").unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::DotSegment);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_empty_segment() {
        let error = AssetId::parse("vfs://hello/foo//bar").unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::EmptySegment);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_control_character_in_path() {
        let raw = "vfs://hello/intro\u{0001}.txt";
        let error = AssetId::parse(raw).unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::ControlCharacter);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_nul_byte_in_path() {
        let raw = "vfs://hello/intro\0.txt";
        let error = AssetId::parse(raw).unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::NulByte);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_overlong_total_length() {
        let mut raw = String::from("vfs://hello/");
        // Build a single segment slightly above the 255-byte cap and pad the
        // remaining length up to the total limit by repeating short segments
        // — but the segment-length cap will trip first; for the total-length
        // case, build many short segments instead.
        for _ in 0..(MAX_ASSET_ID_BYTES) {
            raw.push('a');
            raw.push('/');
        }
        raw.push('a');
        let error = AssetId::parse(&raw).unwrap_err();
        match error {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::OverlongTotal);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parse_normalizes_nfc_in_path_segment() {
        // "café" in NFD form (e + U+0301) -> NFC "café" (U+00E9).
        let nfd = "vfs://hello/cafe\u{0301}.txt";
        let id = AssetId::parse(nfd).unwrap();
        assert_eq!(id.path(), "café.txt");
        // Round-trip should be stable.
        let again = AssetId::parse(id.as_str()).unwrap();
        assert_eq!(again, id);
    }

    #[test]
    fn join_appends_child_segment_under_directory_id() {
        let dir = AssetId::parse("vfs://hello/nested/").unwrap();
        let leaf = dir.join("glyph.txt").unwrap();
        assert_eq!(leaf.as_str(), "vfs://hello/nested/glyph.txt");
    }

    #[test]
    fn join_appends_child_segment_under_package_root() {
        let root = AssetId::parse("vfs://hello/").unwrap();
        let leaf = root.join("intro.txt").unwrap();
        assert_eq!(leaf.as_str(), "vfs://hello/intro.txt");
    }

    #[test]
    fn join_rejects_traversal_in_child() {
        let dir = AssetId::parse("vfs://hello/").unwrap();
        let err = dir.join("..").unwrap_err();
        match err {
            VfsError::InvalidAssetId { reason, .. } => {
                assert_eq!(reason, AssetIdErrorReason::ParentSegment);
            }
            other => panic!("expected InvalidAssetId, got {other:?}"),
        }
    }

    #[test]
    fn parent_of_leaf_returns_directory_id() {
        let leaf = AssetId::parse("vfs://hello/nested/glyph.txt").unwrap();
        let parent = leaf.parent().unwrap();
        assert_eq!(parent.as_str(), "vfs://hello/nested/");
    }

    #[test]
    fn parent_of_directory_returns_grandparent() {
        let dir = AssetId::parse("vfs://hello/nested/").unwrap();
        let parent = dir.parent().unwrap();
        assert_eq!(parent.as_str(), "vfs://hello/");
    }

    #[test]
    fn parent_of_package_root_is_none() {
        let root = AssetId::parse("vfs://hello/").unwrap();
        assert!(root.parent().is_none());
    }
}
