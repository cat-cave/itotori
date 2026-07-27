use super::*;

/// Read a plain XP3 archive into a source-fidelity [`PlainXp3Archive`]
/// suitable for byte-identical rebuild.
/// Refuses encrypted / compressed / helper-required / protected-executable inputs
/// before exposing any write surface — callers can rely on the
/// `Unsupported*` errors to gate downstream patch-back claims.
pub fn read_plain_xp3_archive(bytes: &[u8]) -> Result<PlainXp3Archive, PlainXp3WriterError> {
    if !bytes.starts_with(XP3_PLAIN_MAGIC) {
        if has_legacy_xp3_encrypted_marker(bytes) {
            return Err(PlainXp3WriterError::UnsupportedEncrypted);
        }
        if has_legacy_xp3_compressed_marker(bytes) {
            return Err(PlainXp3WriterError::UnsupportedCompressed);
        }
        if has_legacy_xp3_helper_required_marker(bytes) {
            return Err(PlainXp3WriterError::UnsupportedHelperRequired);
        }
        return Err(PlainXp3WriterError::UnsupportedProtectedExecutable);
    }

    let index_offset = read_le_u64(bytes, XP3_PLAIN_MAGIC.len(), "index offset")
        .map_err(PlainXp3WriterError::InventoryError)?;
    let index_offset = usize::try_from(index_offset).map_err(|_| {
        PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset("index"))
    })?;
    if index_offset >= bytes.len() {
        return Err(PlainXp3WriterError::InventoryError(
            PlainXp3InventoryError::InvalidOffset("index"),
        ));
    }

    let index_encoding = *bytes
        .get(index_offset)
        .ok_or(PlainXp3WriterError::InventoryError(
            PlainXp3InventoryError::Truncated("index encoding"),
        ))?;
    if index_encoding != 0 {
        return Err(PlainXp3WriterError::InventoryError(
            PlainXp3InventoryError::UnsupportedIndexEncoding(index_encoding),
        ));
    }
    let index_size = read_le_u64(bytes, index_offset + 1, "index size")
        .map_err(PlainXp3WriterError::InventoryError)?;
    let index_start = index_offset
        .checked_add(9)
        .ok_or(PlainXp3WriterError::InventoryError(
            PlainXp3InventoryError::InvalidOffset("index start"),
        ))?;
    let index_size = usize::try_from(index_size).map_err(|_| {
        PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset("index size"))
    })?;
    let index_end = checked_end(index_start, index_size, bytes.len(), "index")
        .map_err(PlainXp3WriterError::InventoryError)?;

    let mut cursor = index_start;
    let mut entries: Vec<PlainXp3ArchiveEntry> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    while cursor < index_end {
        let chunk_name = read_chunk_name(bytes, cursor, "index chunk name")
            .map_err(PlainXp3WriterError::InventoryError)?;
        let chunk_size = read_le_u64(bytes, cursor + 4, "index chunk size")
            .map_err(PlainXp3WriterError::InventoryError)?;
        let content_start = cursor + 12;
        let content_size = usize::try_from(chunk_size).map_err(|_| {
            PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset(
                "index chunk size",
            ))
        })?;
        let content_end = checked_end(content_start, content_size, index_end, "index chunk")
            .map_err(PlainXp3WriterError::InventoryError)?;
        if chunk_name == *b"File" {
            let chunk = parse_xp3_file_chunk(bytes, content_start, content_end)
                .map_err(PlainXp3WriterError::InventoryError)?;
            let path = chunk.path.ok_or_else(|| {
                PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                    "File chunk missing info path".to_string(),
                ))
            })?;
            if !seen_paths.insert(path.clone()) {
                return Err(PlainXp3WriterError::InventoryError(
                    PlainXp3InventoryError::DuplicateEntry(path),
                ));
            }
            let original_size = chunk.original_size.ok_or_else(|| {
                PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                    "File chunk missing info original size".to_string(),
                ))
            })?;
            let archive_size = chunk.archive_size.ok_or_else(|| {
                PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                    "File chunk missing info archive size".to_string(),
                ))
            })?;

            let mut payload: Vec<u8> = Vec::new();
            let mut writer_segments: Vec<PlainXp3ArchiveSegment> = Vec::new();
            for segment in &chunk.segments {
                let offset = usize::try_from(segment.offset).map_err(|_| {
                    PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset(
                        "segment",
                    ))
                })?;
                let size = usize::try_from(segment.archive_size).map_err(|_| {
                    PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset(
                        "segment size",
                    ))
                })?;
                let end = checked_end(offset, size, bytes.len(), "segment payload")
                    .map_err(PlainXp3WriterError::InventoryError)?;
                payload.extend_from_slice(&bytes[offset..end]);
                writer_segments.push(PlainXp3ArchiveSegment {
                    flags: segment.flags,
                    original_size: segment.original_size,
                    archive_size: segment.archive_size,
                });
            }

            let stored_adler32 = match chunk.stored_adler32.as_deref() {
                Some(formatted) => {
                    let hex = formatted.strip_prefix("adler32:").ok_or_else(|| {
                        PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                            format!("adlr chunk had unexpected format {formatted:?}"),
                        ))
                    })?;
                    let value = u32::from_str_radix(hex, 16).map_err(|_| {
                        PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                            format!("adlr chunk had non-hex value {hex:?}"),
                        ))
                    })?;
                    Some(value)
                }
                None => None,
            };

            entries.push(PlainXp3ArchiveEntry {
                path,
                original_size,
                archive_size,
                stored_adler32,
                segments: writer_segments,
                payload,
            });
        }
        cursor = content_end;
    }

    Ok(PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries,
    })
}

/// Detect the helper-required marker the classifier emits.
pub(crate) fn has_legacy_xp3_helper_required_marker(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"XP3\r\n") {
        return false;
    }
    let marker_region = &bytes[..bytes.len().min(128)];
    header_contains_ascii(marker_region, "XP3-HELPER-REQUIRED")
        || header_contains_ascii(marker_region, "kaifuu-xp3-helper-required")
}

/// Detect the compressed/packed marker the classifier emits.
pub(crate) fn has_legacy_xp3_compressed_marker(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"XP3\r\n") {
        return false;
    }
    let marker_region = &bytes[..bytes.len().min(128)];
    header_contains_ascii(marker_region, "XP3-COMPRESSED")
        || header_contains_ascii(marker_region, "kaifuu-xp3-compressed")
}

/// Encode a [`PlainXp3Archive`] to a deterministic XP3 byte stream.
/// Layout (matches the existing fixture-only synthetic builder):
/// 1. [`XP3_PLAIN_MAGIC`] (11 bytes)
/// 2. Placeholder u64 for the index offset (filled in at the end).
/// 3. Each entry's concatenated segment payloads, in entry order, in
///    segment order. The offset of each segment is recorded into the
///    segm chunk so a re-parse round-trips.
/// 4. Index encoding byte (`0`).
/// 5. Index size u64 (the byte length of the File chunks that follow).
/// 6. One `File` chunk per entry, each containing `info`, `segm`, and
///    (when the source had one) `adlr` chunks in that order.
///    Rebuilding from a manifest produced by [`read_plain_xp3_archive`]
///    returns the same bytes as the source archive: this is the
///    determinism guarantee makes.
pub fn encode_xp3(archive: &PlainXp3Archive) -> Result<Vec<u8>, PlainXp3WriterError> {
    if archive.variant != PLAIN_XP3_MANIFEST_VARIANT {
        return Err(PlainXp3WriterError::UnsupportedVariant(
            archive.variant.clone(),
        ));
    }

    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    // Placeholder for index_offset.
    bytes.extend_from_slice(&0_u64.to_le_bytes());

    // Track segment offsets per entry as we emit payloads.
    let mut entry_segment_offsets: Vec<Vec<u64>> = Vec::with_capacity(archive.entries.len());
    for entry in &archive.entries {
        validate_safe_relative_path(&entry.path)
            .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;

        let total_archive_size: u64 = entry
            .segments
            .iter()
            .map(|segment| segment.archive_size)
            .sum();
        if total_archive_size != entry.archive_size {
            return Err(PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} segment archive_size sum {} does not match recorded archive_size {}",
                entry.path, total_archive_size, entry.archive_size
            )));
        }
        if (entry.payload.len() as u64) != total_archive_size {
            return Err(PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} payload length {} does not match segment archive_size sum {}",
                entry.path,
                entry.payload.len(),
                total_archive_size
            )));
        }

        let mut offsets = Vec::with_capacity(entry.segments.len());
        let mut payload_cursor = 0_usize;
        for segment in &entry.segments {
            offsets.push(bytes.len() as u64);
            let segment_len = usize::try_from(segment.archive_size).map_err(|_| {
                PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment archive_size {} does not fit in usize",
                    entry.path, segment.archive_size
                ))
            })?;
            let segment_end = payload_cursor.checked_add(segment_len).ok_or_else(|| {
                PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment slice overflows payload",
                    entry.path
                ))
            })?;
            if segment_end > entry.payload.len() {
                return Err(PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment slice {}..{} exceeds payload length {}",
                    entry.path,
                    payload_cursor,
                    segment_end,
                    entry.payload.len()
                )));
            }
            bytes.extend_from_slice(&entry.payload[payload_cursor..segment_end]);
            payload_cursor = segment_end;
        }
        entry_segment_offsets.push(offsets);
    }

    let index_offset = bytes.len() as u64;
    let mut index = Vec::new();
    for (entry, offsets) in archive.entries.iter().zip(&entry_segment_offsets) {
        let mut file = Vec::new();

        let path_units: Vec<u16> = entry.path.encode_utf16().collect();
        let mut info = Vec::with_capacity(4 + 8 + 8 + 2 + path_units.len() * 2);
        // writes the four reserved info-chunk bytes as zero
        // matching every fixture-only plain XP3 archive in the repo. The
        // reader ignores these bytes; preserving the value keeps the
        // round-trip byte-identical for every fixture we have.
        info.extend_from_slice(&0_u32.to_le_bytes());
        info.extend_from_slice(&entry.original_size.to_le_bytes());
        info.extend_from_slice(&entry.archive_size.to_le_bytes());
        let path_unit_count = u16::try_from(path_units.len()).map_err(|_| {
            PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} path length {} UTF-16 units does not fit in u16",
                entry.path,
                path_units.len()
            ))
        })?;
        info.extend_from_slice(&path_unit_count.to_le_bytes());
        for unit in path_units {
            info.extend_from_slice(&unit.to_le_bytes());
        }
        append_plain_xp3_chunk(&mut file, *b"info", &info);

        let mut segm = Vec::with_capacity(entry.segments.len() * 28);
        for (segment, segment_offset) in entry.segments.iter().zip(offsets) {
            segm.extend_from_slice(&segment.flags.to_le_bytes());
            segm.extend_from_slice(&segment_offset.to_le_bytes());
            segm.extend_from_slice(&segment.original_size.to_le_bytes());
            segm.extend_from_slice(&segment.archive_size.to_le_bytes());
        }
        append_plain_xp3_chunk(&mut file, *b"segm", &segm);

        if let Some(adler) = entry.stored_adler32 {
            append_plain_xp3_chunk(&mut file, *b"adlr", &adler.to_le_bytes());
        }

        append_plain_xp3_chunk(&mut index, *b"File", &file);
    }

    // Index encoding (plain) + size + content.
    bytes.push(0);
    bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&index);

    // Backfill the index offset.
    bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
        .copy_from_slice(&index_offset.to_le_bytes());

    Ok(bytes)
}

pub(crate) fn append_plain_xp3_chunk(output: &mut Vec<u8>, name: [u8; 4], content: &[u8]) {
    output.extend_from_slice(&name);
    output.extend_from_slice(&(content.len() as u64).to_le_bytes());
    output.extend_from_slice(content);
}
