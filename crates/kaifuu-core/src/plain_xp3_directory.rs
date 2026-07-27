use super::*;

/// Manifest written to disk by [`unpack_plain_xp3_to_directory`].
/// The on-disk layout mirrors [`PlainXp3Archive`] but stores each entry's
/// raw payload as a separate file under `payload/` so callers can edit
/// individual entries without going through hex round-tripping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3DirectoryManifest {
    pub schema_version: String,
    pub variant: String,
    pub entries: Vec<PlainXp3DirectoryManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3DirectoryManifestEntry {
    pub path: String,
    pub payload_relative_path: String,
    pub original_size: u64,
    pub archive_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_adler32_hex: Option<String>,
    pub segments: Vec<PlainXp3ArchiveSegment>,
}

/// Symlink-safe (`O_NOFOLLOW`, fd-relative) materialization of the unpacked
/// plain XP3 directory layout.
/// [`validate_safe_relative_path`] is a string-level first-line check only: it
/// cannot see the filesystem, so a symlink planted inside the unpack/output
/// directory (or a directory component that is a symlink pointing outside the
/// root) would let a `dir.join(relative)` + `fs::write`/`fs::read` escape the
/// intended root even though the string looked "safe" (TOCTOU / symlink
/// traversal). These helpers are the real security boundary: they open the
/// caller-named root, then descend every relative component RELATIVE to a held
/// directory descriptor with `O_NOFOLLOW`. A symlink squatting on any component
/// (or the leaf) fails the `openat` with `ELOOP` and is reported as
/// [`PlainXp3WriterError::SymlinkTraversalRefused`] — the read/write is refused
/// in place and can never follow the link out of the root, even under a
/// concurrent swap. Mirrors the runtime-artifact hardening.
/// Threat model: the root `dir` is the caller's trust anchor (they explicitly
/// name it), so the root path itself is resolved normally; every component
/// BELOW the root — which is influenced by the manifest and/or a prior unpack
/// of untrusted archive bytes — is descended no-follow.
#[cfg(unix)]
#[path = "lib/plain_xp3_no_follow_unix.rs"]
mod plain_xp3_no_follow;

/// Non-Unix fallback: the fd-relative `O_NOFOLLOW` primitives the symlink-safe
/// materialization depends on are Unix-only, so the plain XP3 directory writer
/// is unsupported there rather than silently falling back to an unsafe
/// `fs::write`/`fs::read`.
#[cfg(not(unix))]
mod plain_xp3_no_follow {
    use super::PlainXp3WriterError;
    use std::path::Path;

    pub(crate) const UNSUPPORTED: &str =
        "symlink-safe plain XP3 directory materialization requires a Unix platform";

    pub fn write_no_follow(
        _dir: &Path,
        _relative: &str,
        _contents: &[u8],
        _create_dirs: bool,
    ) -> Result<(), PlainXp3WriterError> {
        Err(PlainXp3WriterError::Io(UNSUPPORTED.to_string()))
    }

    pub fn read_no_follow(_dir: &Path, _relative: &str) -> Result<Vec<u8>, PlainXp3WriterError> {
        Err(PlainXp3WriterError::Io(UNSUPPORTED.to_string()))
    }
}

/// Unpack a plain XP3 archive into a directory layout suitable for the
/// deterministic writer.
/// Layout produced under `dir`:
/// - `manifest.json`: ordered list of entries with per-segment metadata.
/// - `payload/<index>-<flat-path>.bin`: raw segment payload for each
///   entry, where `<index>` is the entry's zero-padded source-order
///   index and `<flat-path>` replaces slashes with `__`.
///   Refuses non-plain XP3 bytes (encrypted, compressed, helper-required, or unknown
///   containers) **before** writing any file under `dir`. The directory
///   is created if missing.
pub fn unpack_plain_xp3_to_directory(
    bytes: &[u8],
    dir: &Path,
) -> Result<PlainXp3DirectoryManifest, PlainXp3WriterError> {
    let archive = read_plain_xp3_archive(bytes)?;

    fs::create_dir_all(dir).map_err(|error| PlainXp3WriterError::Io(error.to_string()))?;

    let mut manifest_entries = Vec::with_capacity(archive.entries.len());
    let width = format!("{}", archive.entries.len().saturating_sub(1))
        .len()
        .max(2);
    for (index, entry) in archive.entries.iter().enumerate() {
        validate_safe_relative_path(&entry.path)
            .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;
        let flat = entry.path.replace('/', "__");
        let payload_relative = format!("payload/{index:0width$}-{flat}.bin");
        // Symlink-safe materialization: descends `payload/` no-follow and
        // refuses a symlink squatting anywhere under the root (create_dirs=true
        // makes the `payload/` subdir with `mkdirat`).
        plain_xp3_no_follow::write_no_follow(dir, &payload_relative, &entry.payload, true)?;
        manifest_entries.push(PlainXp3DirectoryManifestEntry {
            path: entry.path.clone(),
            payload_relative_path: payload_relative,
            original_size: entry.original_size,
            archive_size: entry.archive_size,
            stored_adler32_hex: entry.stored_adler32.map(|value| format!("{value:08x}")),
            segments: entry.segments.clone(),
        });
    }

    let manifest = PlainXp3DirectoryManifest {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: manifest_entries,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|error| PlainXp3WriterError::ManifestParse(error.to_string()))?;
    plain_xp3_no_follow::write_no_follow(dir, "manifest.json", manifest_json.as_bytes(), true)?;
    Ok(manifest)
}

/// Rebuild a plain XP3 archive from a directory previously produced by
/// [`unpack_plain_xp3_to_directory`].
/// The directory's `manifest.json` is parsed; each entry's payload is
/// loaded from the manifest-declared relative path. The writer refuses
/// non-`plain` variants (encrypted / compressed / helper-required / unknown) with the
/// matching semantic diagnostic. Compressed entries are passed through
/// when their payload length still matches the recorded `archive_size`;
/// a length mismatch on a compressed entry triggers
/// [`PlainXp3WriterError::UnsupportedCompressedReplacement`] because the
/// writer cannot recompress.
pub fn pack_plain_xp3_from_directory(dir: &Path) -> Result<Vec<u8>, PlainXp3WriterError> {
    let manifest_bytes = plain_xp3_no_follow::read_no_follow(dir, "manifest.json")?;
    let manifest: PlainXp3DirectoryManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| PlainXp3WriterError::ManifestParse(error.to_string()))?;

    if manifest.variant != PLAIN_XP3_MANIFEST_VARIANT {
        return Err(PlainXp3WriterError::UnsupportedVariant(manifest.variant));
    }

    let mut archive_entries = Vec::with_capacity(manifest.entries.len());
    for entry in manifest.entries {
        validate_safe_relative_path(&entry.path)
            .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;
        validate_safe_relative_path(&entry.payload_relative_path).map_err(|_| {
            PlainXp3WriterError::UnsafeRelativePath(entry.payload_relative_path.clone())
        })?;
        // Symlink-safe read: refuses a symlink component so a tampered manifest
        // plus a planted symlink cannot exfiltrate a file outside the root.
        let payload = plain_xp3_no_follow::read_no_follow(dir, &entry.payload_relative_path)?;

        let total_archive_size: u64 = entry.segments.iter().map(|s| s.archive_size).sum();
        if (payload.len() as u64) != total_archive_size {
            let any_compressed = entry
                .segments
                .iter()
                .any(PlainXp3ArchiveSegment::is_compressed);
            if any_compressed {
                return Err(PlainXp3WriterError::UnsupportedCompressedReplacement(
                    entry.path,
                ));
            }
            return Err(PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} payload length {} no longer matches segment archive_size sum {}",
                entry.path,
                payload.len(),
                total_archive_size
            )));
        }
        let stored_adler32 = match entry.stored_adler32_hex.as_deref() {
            Some(hex) => Some(u32::from_str_radix(hex, 16).map_err(|_| {
                PlainXp3WriterError::ManifestParse(format!(
                    "stored_adler32_hex {hex:?} is not a valid hex u32"
                ))
            })?),
            None => None,
        };
        archive_entries.push(PlainXp3ArchiveEntry {
            path: entry.path,
            original_size: entry.original_size,
            archive_size: entry.archive_size,
            stored_adler32,
            segments: entry.segments,
            payload,
        });
    }

    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: archive_entries,
    };
    encode_xp3(&archive)
}

/// Replace a single entry's payload inside an unpacked plain XP3
/// directory layout. Updates `manifest.json` (archive_size,
/// original_size, segment archive_size/original_size) so the next
/// [`pack_plain_xp3_from_directory`] call emits the rewritten entry.
/// Acceptance criterion: "Replacing an allowed plain fixture file
/// updates table metadata and verification output."
/// The replacement is only allowed when the entry's segments are all
/// uncompressed (no decompression / recompression is in scope for
/// ). Refuses with
/// [`PlainXp3WriterError::UnsupportedCompressedReplacement`] otherwise.
/// Multi-segment uncompressed entries are also out of scope — the
/// writer would have no canonical rule for how to split the new payload
/// across the original segment boundaries, so we refuse with
/// `InconsistentManifest` to keep the rebuild deterministic.
pub fn replace_plain_xp3_entry_payload(
    dir: &Path,
    entry_path: &str,
    new_payload: &[u8],
) -> Result<PlainXp3DirectoryManifest, PlainXp3WriterError> {
    let manifest_bytes = plain_xp3_no_follow::read_no_follow(dir, "manifest.json")?;
    let mut manifest: PlainXp3DirectoryManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| PlainXp3WriterError::ManifestParse(error.to_string()))?;
    if manifest.variant != PLAIN_XP3_MANIFEST_VARIANT {
        return Err(PlainXp3WriterError::UnsupportedVariant(manifest.variant));
    }

    let entry = manifest
        .entries
        .iter_mut()
        .find(|entry| entry.path == entry_path)
        .ok_or_else(|| {
            PlainXp3WriterError::InconsistentManifest(format!(
                "entry {entry_path:?} not present in manifest"
            ))
        })?;
    validate_safe_relative_path(&entry.path)
        .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;
    validate_safe_relative_path(&entry.payload_relative_path).map_err(|_| {
        PlainXp3WriterError::UnsafeRelativePath(entry.payload_relative_path.clone())
    })?;
    if entry
        .segments
        .iter()
        .any(PlainXp3ArchiveSegment::is_compressed)
    {
        return Err(PlainXp3WriterError::UnsupportedCompressedReplacement(
            entry.path.clone(),
        ));
    }
    if entry.segments.len() != 1 {
        return Err(PlainXp3WriterError::InconsistentManifest(format!(
            "entry {entry_path:?} has {} segments; KAIFUU-098 only replaces single-segment uncompressed entries",
            entry.segments.len()
        )));
    }

    let new_size = new_payload.len() as u64;
    entry.original_size = new_size;
    entry.archive_size = new_size;
    entry.segments[0].original_size = new_size;
    entry.segments[0].archive_size = new_size;
    entry.stored_adler32_hex = Some(format!("{:08x}", compute_adler32(new_payload)));

    // Symlink-safe write: the payload is materialized first, so if a symlink is
    // refused here the manifest.json on disk is left untouched (metadata is not
    // persisted through a partial escape).
    plain_xp3_no_follow::write_no_follow(dir, &entry.payload_relative_path, new_payload, false)?;

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|error| PlainXp3WriterError::ManifestParse(error.to_string()))?;
    plain_xp3_no_follow::write_no_follow(dir, "manifest.json", manifest_json.as_bytes(), false)?;
    Ok(manifest)
}

pub(crate) fn has_legacy_xp3_encrypted_marker(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"XP3\r\n") {
        return false;
    }
    let marker_region = &bytes[..bytes.len().min(128)];
    header_contains_ascii(marker_region, "XP3-CRYPT")
        || header_contains_ascii(marker_region, "kaifuu-xp3-encrypted")
}

pub(crate) fn parse_xp3_file_chunk(
    bytes: &[u8],
    start: usize,
    end: usize,
) -> Result<PlainXp3FileChunk, PlainXp3InventoryError> {
    let mut cursor = start;
    let mut file = PlainXp3FileChunk {
        path: None,
        original_size: None,
        archive_size: None,
        segments: vec![],
        stored_adler32: None,
    };
    while cursor < end {
        let chunk_name = read_chunk_name(bytes, cursor, "file chunk name")?;
        let chunk_size = read_le_u64(bytes, cursor + 4, "file chunk size")?;
        let content_start = cursor + 12;
        let content_size = usize::try_from(chunk_size)
            .map_err(|_| PlainXp3InventoryError::InvalidOffset("file chunk size"))?;
        let content_end = checked_end(content_start, content_size, end, "file chunk")?;
        match &chunk_name {
            b"info" => parse_xp3_info_chunk(bytes, content_start, content_end, &mut file)?,
            b"segm" => parse_xp3_segment_chunk(bytes, content_start, content_end, &mut file)?,
            b"adlr" => {
                if content_size != 4 {
                    return Err(PlainXp3InventoryError::InvalidChunk(
                        "adlr chunk must be four bytes".to_string(),
                    ));
                }
                file.stored_adler32 = Some(format!(
                    "adler32:{:08x}",
                    read_le_u32(bytes, content_start, "adlr")?
                ));
            }
            _ => {}
        }
        cursor = content_end;
    }
    if file.segments.is_empty() {
        return Err(PlainXp3InventoryError::InvalidChunk(
            "File chunk missing segment table".to_string(),
        ));
    }
    Ok(file)
}

pub(crate) fn parse_xp3_info_chunk(
    bytes: &[u8],
    start: usize,
    end: usize,
    file: &mut PlainXp3FileChunk,
) -> Result<(), PlainXp3InventoryError> {
    let minimum_size = 4 + 8 + 8 + 2;
    if end.saturating_sub(start) < minimum_size {
        return Err(PlainXp3InventoryError::Truncated("info chunk"));
    }
    file.original_size = Some(read_le_u64(bytes, start + 4, "info original size")?);
    file.archive_size = Some(read_le_u64(bytes, start + 12, "info archive size")?);
    let path_units = usize::from(read_le_u16(bytes, start + 20, "info path length")?);
    let path_start = start + 22;
    let path_bytes = path_units
        .checked_mul(2)
        .ok_or(PlainXp3InventoryError::InvalidOffset("info path length"))?;
    let path_end = checked_end(path_start, path_bytes, end, "info path")?;
    let mut units = Vec::with_capacity(path_units);
    let mut cursor = path_start;
    while cursor < path_end {
        units.push(read_le_u16(bytes, cursor, "info path unit")?);
        cursor += 2;
    }
    file.path =
        Some(String::from_utf16(&units).map_err(|_| PlainXp3InventoryError::InvalidUtf16Path)?);
    Ok(())
}

pub(crate) fn parse_xp3_segment_chunk(
    bytes: &[u8],
    start: usize,
    end: usize,
    file: &mut PlainXp3FileChunk,
) -> Result<(), PlainXp3InventoryError> {
    let segment_size = 4 + 8 + 8 + 8;
    if !(end - start).is_multiple_of(segment_size) {
        return Err(PlainXp3InventoryError::InvalidChunk(
            "segment table size is not a multiple of 28".to_string(),
        ));
    }
    let mut cursor = start;
    while cursor < end {
        file.segments.push(PlainXp3Segment {
            flags: read_le_u32(bytes, cursor, "segment flags")?,
            offset: read_le_u64(bytes, cursor + 4, "segment offset")?,
            original_size: read_le_u64(bytes, cursor + 12, "segment original size")?,
            archive_size: read_le_u64(bytes, cursor + 20, "segment archive size")?,
        });
        cursor += segment_size;
    }
    Ok(())
}

pub(crate) fn hash_xp3_segments(
    bytes: &[u8],
    segments: &[PlainXp3Segment],
) -> Result<Option<String>, PlainXp3InventoryError> {
    let mut payload = Vec::new();
    for segment in segments {
        let offset = usize::try_from(segment.offset)
            .map_err(|_| PlainXp3InventoryError::InvalidOffset("segment"))?;
        let size = usize::try_from(segment.archive_size)
            .map_err(|_| PlainXp3InventoryError::InvalidOffset("segment size"))?;
        let end = checked_end(offset, size, bytes.len(), "segment payload")?;
        payload.extend_from_slice(&bytes[offset..end]);
    }
    Ok(Some(sha256_hash_bytes(&payload)))
}

pub(crate) fn read_chunk_name(
    bytes: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<[u8; 4], PlainXp3InventoryError> {
    let end = checked_end(offset, 4, bytes.len(), field)?;
    let mut name = [0; 4];
    name.copy_from_slice(&bytes[offset..end]);
    Ok(name)
}

pub(crate) fn read_le_u16(
    bytes: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<u16, PlainXp3InventoryError> {
    let end = checked_end(offset, 2, bytes.len(), field)?;
    let mut raw = [0; 2];
    raw.copy_from_slice(&bytes[offset..end]);
    Ok(u16::from_le_bytes(raw))
}

pub(crate) fn read_le_u32(
    bytes: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<u32, PlainXp3InventoryError> {
    let end = checked_end(offset, 4, bytes.len(), field)?;
    let mut raw = [0; 4];
    raw.copy_from_slice(&bytes[offset..end]);
    Ok(u32::from_le_bytes(raw))
}

pub(crate) fn read_le_u64(
    bytes: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<u64, PlainXp3InventoryError> {
    let end = checked_end(offset, 8, bytes.len(), field)?;
    let mut raw = [0; 8];
    raw.copy_from_slice(&bytes[offset..end]);
    Ok(u64::from_le_bytes(raw))
}

pub(crate) fn checked_end(
    start: usize,
    size: usize,
    upper_bound: usize,
    field: &'static str,
) -> Result<usize, PlainXp3InventoryError> {
    let end = start
        .checked_add(size)
        .ok_or(PlainXp3InventoryError::InvalidOffset(field))?;
    if end > upper_bound {
        return Err(PlainXp3InventoryError::Truncated(field));
    }
    Ok(end)
}
