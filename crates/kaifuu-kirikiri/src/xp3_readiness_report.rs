//! Private-local KiriKiri XP3 **owned-game readiness report** (the redacted,
//! aggregate-only readiness lane for a private-local owned title).
//!
//! # What this is
//! A local operator points [`scan_xp3_readiness_report`] at a directory of their
//! own owned KiriKiri game's `.xp3` archives. The scan reads real bytes — it
//! classifies each archive's XP3 variant, enumerates its KAG `.ks` scenario
//! members, decodes them (encoding-aware, reusing the crate's
//! [`crate::parse`] BOM/Shift-JIS detection), and tallies KAG tag *names*.
//!
//! # Redaction is the whole point
//! The returned [`Xp3ReadinessReport`] carries EXACTLY six aggregate fields and
//! nothing else:
//! `spec`, `xp3VariantHistogram`, `kagTagHistogram`, `archiveCount`,
//! `kagScenarioCount`, `aggregateKagBodyHashSha256`.
//! Redaction is *structural*, not a scrub pass:
//! - No filename, archive path, or member path is ever placed in the report —
//!   archives and members contribute only to counts and histogram bucket totals.
//! - No KAG body byte string is retained — a `.ks` body is scanned for tag
//!   NAMES only (a leading `[A-Za-z_][A-Za-z0-9_]*` after `[` / `@`); every
//!   attribute value, message run, and speaker name is dropped on the floor.
//! - No raw or encrypted XP3 member bytes are retained — encrypted / unreadable
//!   archives contribute to the variant histogram + `archiveCount` only, never a
//!   byte of their content.
//! - The one hash (`aggregateKagBodyHashSha256`) is a single SHA-256 over the
//!   concatenation of every decoded KAG body in deterministic order: an
//!   aggregate fingerprint, not a per-member index, so it neither identifies nor
//!   reconstructs any individual scenario.
//!
//! Because the report is aggregate-only by construction, it is safe to commit /
//! publish even though the scan ran over private, copyrighted owned bytes.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use flate2::read::ZlibDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use kaifuu_core::{KaifuuResult, XP3_PLAIN_MAGIC, stable_json};

use crate::parse::{KsEncoding, decode_slice};

/// Spec identifier + version stamped into every report. A fixed constant — it
/// carries no game-derived data.
pub const XP3_READINESS_REPORT_SPEC: &str = "kaifuu.kirikiri.xp3_readiness_report@0.1.0";

/// A private-local KiriKiri XP3 owned-game readiness report.
///
/// Serializes to EXACTLY six top-level keys (`spec`, `xp3VariantHistogram`,
/// `kagTagHistogram`, `archiveCount`, `kagScenarioCount`,
/// `aggregateKagBodyHashSha256`). Adding a field here is a redaction-boundary
/// change and must be treated as one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3ReadinessReport {
    /// Fixed spec/version identifier ([`XP3_READINESS_REPORT_SPEC`]).
    pub spec: String,
    /// Count of archives per detected XP3 variant bucket (see
    /// [`classify_xp3_variant`]). Keys are fixed variant tokens, never paths.
    pub xp3_variant_histogram: BTreeMap<String, u64>,
    /// Count of occurrences per KAG tag NAME across every decoded `.ks` body.
    /// Keys are engine-vocabulary tag names (`eval`, `cm`, `jump`, …), never
    /// attribute values or message text.
    pub kag_tag_histogram: BTreeMap<String, u64>,
    /// Number of `.xp3` archives scanned.
    pub archive_count: u64,
    /// Number of KAG `.ks` scenario members found across all archives.
    pub kag_scenario_count: u64,
    /// Lowercase hex SHA-256 over the concatenation of every decoded KAG body,
    /// in deterministic (archive, member) order — one aggregate fingerprint.
    pub aggregate_kag_body_hash_sha256: String,
}

impl Xp3ReadinessReport {
    /// Stable, deterministic JSON for committing / publishing. Aggregate-only by
    /// construction, so no additional redaction pass is required.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }
}

/// Scan a directory of a private-local owned KiriKiri game's `.xp3` archives and
/// return the redacted, aggregate-only readiness report.
///
/// Best-effort per archive: an unreadable, encrypted, or malformed archive still
/// contributes to `archiveCount` and the variant histogram, but contributes zero
/// scenarios / tags / body bytes — the scan never fails on a single bad archive
/// and never surfaces a path in an error.
pub fn scan_xp3_readiness_report(game_dir: &Path) -> KaifuuResult<Xp3ReadinessReport> {
    let mut archive_paths: Vec<std::path::PathBuf> = Vec::new();
    let entries = std::fs::read_dir(game_dir).map_err(|_| -> Box<dyn std::error::Error> {
        "kaifuu.kirikiri.xp3_readiness_report: could not read the game directory".into()
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_xp3 = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("xp3"));
        if is_xp3 && path.is_file() {
            archive_paths.push(path);
        }
    }
    // Deterministic order so the aggregate hash is stable across filesystems.
    archive_paths.sort();

    let mut variant_histogram: BTreeMap<String, u64> = BTreeMap::new();
    let mut tag_histogram: BTreeMap<String, u64> = BTreeMap::new();
    let mut kag_scenario_count: u64 = 0;
    let mut aggregate = Sha256::new();

    for archive_path in &archive_paths {
        let Ok(bytes) = std::fs::read(archive_path) else {
            *variant_histogram
                .entry("unreadable".to_string())
                .or_insert(0) += 1;
            continue;
        };
        let variant = classify_xp3_variant(&bytes);
        *variant_histogram.entry(variant.to_string()).or_insert(0) += 1;

        // Only plain-magic archives expose a readable member table. Encrypted /
        // unrecognized containers contribute to the histogram only.
        if !bytes.starts_with(XP3_PLAIN_MAGIC) {
            continue;
        }
        for (_path, body) in extract_ks_bodies(&bytes) {
            kag_scenario_count += 1;
            aggregate.update(&body);
            accumulate_kag_tags(&body, &mut tag_histogram);
        }
    }

    Ok(Xp3ReadinessReport {
        spec: XP3_READINESS_REPORT_SPEC.to_string(),
        xp3_variant_histogram: variant_histogram,
        kag_tag_histogram: tag_histogram,
        archive_count: archive_paths.len() as u64,
        kag_scenario_count,
        aggregate_kag_body_hash_sha256: hex_lower(&aggregate.finalize()),
    })
}

/// Classify an archive's XP3 variant into a fixed histogram bucket token.
///
/// A full [`XP3_PLAIN_MAGIC`] container is plain; it is sub-classified by its
/// index-encoding byte (`0` raw, `1` zlib). Non-plain containers are classified
/// by the subtype token on the `XP3\r\n` marker line (the repo's synthetic
/// encrypted / compressed / unknown convention). Bucket tokens are fixed
/// constants — never a filename or path.
#[must_use]
pub fn classify_xp3_variant(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(XP3_PLAIN_MAGIC) {
        return match plain_index_encoding(bytes) {
            Some(0) => "plain_raw_index",
            Some(1) => "plain_zlib_index",
            Some(_) => "plain_other_index",
            None => "plain_unreadable_index",
        };
    }
    let Some(region) = bytes.strip_prefix(b"XP3\r\n") else {
        return "unrecognized";
    };
    let marker_line = match region.iter().position(|&byte| byte == b'\n') {
        Some(newline) => &region[..newline],
        None => region,
    };
    if marker_contains(marker_line, "xp3-encrypted") || marker_contains(marker_line, "xp3-crypt") {
        "encrypted"
    } else if marker_contains(marker_line, "xp3-compressed") {
        "compressed"
    } else if marker_contains(marker_line, "xp3-unknown") {
        "unknown"
    } else {
        "unrecognized"
    }
}

fn marker_contains(marker_line: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(marker_line)
        .to_ascii_lowercase()
        .contains(needle)
}

/// Read the index-encoding byte of a plain-magic archive, or `None` if the
/// header / index offset is truncated.
fn plain_index_encoding(bytes: &[u8]) -> Option<u8> {
    let index_offset = usize::try_from(read_le_u64(bytes, XP3_PLAIN_MAGIC.len())?).ok()?;
    bytes.get(index_offset).copied()
}

/// Extract the decoded (decompressed) bodies of every `.ks` member in a plain
/// XP3 archive, sorted by member path. Best-effort: a malformed table or member
/// yields an empty / partial result rather than an error, and never a panic.
fn extract_ks_bodies(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let Some(index) = read_plain_index(bytes) else {
        return Vec::new();
    };
    let mut bodies: Vec<(String, Vec<u8>)> = Vec::new();
    let mut cursor = 0usize;
    while cursor + 12 <= index.len() {
        let chunk_name = &index[cursor..cursor + 4];
        let Some(chunk_size) =
            read_le_u64(&index, cursor + 4).and_then(|v| usize::try_from(v).ok())
        else {
            break;
        };
        let content_start = cursor + 12;
        let Some(content_end) = content_start.checked_add(chunk_size) else {
            break;
        };
        if content_end > index.len() {
            break;
        }
        if chunk_name == b"File"
            && let Some((path, body)) =
                parse_ks_file_chunk(&index[content_start..content_end], bytes)
        {
            bodies.push((path, body));
        }
        cursor = content_end;
    }
    bodies.sort_by(|left, right| left.0.cmp(&right.0));
    bodies
}

/// Parse one `File` index chunk. Returns `Some((path, decoded_body))` only when
/// the member is a `.ks` scenario whose segments decode cleanly.
fn parse_ks_file_chunk(content: &[u8], archive: &[u8]) -> Option<(String, Vec<u8>)> {
    let mut cursor = 0usize;
    let mut path: Option<String> = None;
    let mut segments: Vec<(u32, u64, u64, u64)> = Vec::new();
    while cursor + 12 <= content.len() {
        let sub_name = &content[cursor..cursor + 4];
        let sub_size = usize::try_from(read_le_u64(content, cursor + 4)?).ok()?;
        let sub_start = cursor + 12;
        let sub_end = sub_start.checked_add(sub_size)?;
        if sub_end > content.len() {
            break;
        }
        let sub = &content[sub_start..sub_end];
        if sub_name == b"info" {
            path = parse_info_path(sub);
        } else if sub_name == b"segm" {
            let mut offset = 0usize;
            while offset + 28 <= sub.len() {
                let flags = u32::from_le_bytes(sub[offset..offset + 4].try_into().ok()?);
                let seg_offset = read_le_u64(sub, offset + 4)?;
                let original_size = read_le_u64(sub, offset + 12)?;
                let archive_size = read_le_u64(sub, offset + 20)?;
                segments.push((flags, seg_offset, original_size, archive_size));
                offset += 28;
            }
        }
        cursor = sub_end;
    }

    let path = path?;
    if !path.to_ascii_lowercase().ends_with(".ks") {
        return None;
    }
    let mut body: Vec<u8> = Vec::new();
    for (flags, seg_offset, original_size, archive_size) in segments {
        let start = usize::try_from(seg_offset).ok()?;
        let size = usize::try_from(archive_size).ok()?;
        let end = start.checked_add(size)?;
        let raw = archive.get(start..end)?;
        if flags & 1 != 0 {
            let mut decoder = ZlibDecoder::new(raw);
            let mut decoded = Vec::with_capacity(usize::try_from(original_size).unwrap_or(0));
            decoder.read_to_end(&mut decoded).ok()?;
            body.extend_from_slice(&decoded);
        } else {
            body.extend_from_slice(raw);
        }
    }
    Some((path, body))
}

/// Parse the member path from an `info` sub-chunk (flags/sizes then a UTF-16LE
/// name). Returns `None` on truncation.
fn parse_info_path(info: &[u8]) -> Option<String> {
    // flags(4) + original_size(8) + archive_size(8) + name_len(2) + name.
    let name_len = usize::from(u16::from_le_bytes(info.get(20..22)?.try_into().ok()?));
    let name_start = 22usize;
    let name_end = name_start.checked_add(name_len.checked_mul(2)?)?;
    let name_bytes = info.get(name_start..name_end)?;
    let units: Vec<u16> = name_bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// Read the plain XP3 index table, decompressing it when the archive uses the
/// zlib index encoding (`1`). Returns `None` on any malformation.
fn read_plain_index(bytes: &[u8]) -> Option<Vec<u8>> {
    if !bytes.starts_with(XP3_PLAIN_MAGIC) {
        return None;
    }
    let index_offset = usize::try_from(read_le_u64(bytes, XP3_PLAIN_MAGIC.len())?).ok()?;
    let encoding = *bytes.get(index_offset)?;
    let encoded_size = usize::try_from(read_le_u64(bytes, index_offset + 1)?).ok()?;
    let encoded_start = index_offset.checked_add(9)?;
    match encoding {
        0 => {
            let end = encoded_start.checked_add(encoded_size)?;
            bytes.get(encoded_start..end).map(<[u8]>::to_vec)
        }
        1 => {
            let decoded_size = usize::try_from(read_le_u64(bytes, encoded_start)?).ok()?;
            let compressed_start = encoded_start.checked_add(8)?;
            let compressed_end = compressed_start.checked_add(encoded_size)?;
            let compressed = bytes.get(compressed_start..compressed_end)?;
            let mut decoder = ZlibDecoder::new(compressed);
            let mut index = Vec::with_capacity(decoded_size);
            decoder.read_to_end(&mut index).ok()?;
            (index.len() == decoded_size).then_some(index)
        }
        _ => None,
    }
}

/// Tally KAG tag NAMES from one decoded `.ks` body into `histogram`.
///
/// Encoding-aware via the crate's [`KsEncoding::detect`] + [`decode_slice`].
/// Only the leading `[A-Za-z0-9_]+` identifier of each `@`-line-command and each
/// inline `[tag …]` is retained; `[[` is the KAG literal-`[` escape and is
/// skipped. All attribute values and message text are dropped.
fn accumulate_kag_tags(body: &[u8], histogram: &mut BTreeMap<String, u64>) {
    let encoding = KsEncoding::detect(body);
    let text = decode_slice(body, encoding);
    for line in text.lines() {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if let Some(rest) = trimmed.strip_prefix('@')
            && let Some(name) = leading_ident(rest)
        {
            *histogram.entry(name).or_insert(0) += 1;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            if chars[i] == '[' {
                if chars.get(i + 1) == Some(&'[') {
                    i += 2;
                    continue;
                }
                let rest: String = chars[i + 1..].iter().collect();
                if let Some(name) = leading_ident(&rest) {
                    *histogram.entry(name).or_insert(0) += 1;
                }
            }
            i += 1;
        }
    }
}

/// Leading KAG tag identifier of `text`: `[A-Za-z_][A-Za-z0-9_]*`. A KAG tag
/// name never starts with a digit, so this also rejects the numeric `[0]`,
/// `[10]`, … array-index tokens that appear in inline TJS (`iscript` / `eval`)
/// code rather than as KAG tags.
fn leading_ident(text: &str) -> Option<String> {
    let mut chars = text.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let mut ident = String::new();
    ident.push(first);
    for c in chars {
        if c.is_ascii_alphanumeric() || c == '_' {
            ident.push(c);
        } else {
            break;
        }
    }
    Some(ident)
}

/// Read a little-endian `u64` at `offset`, or `None` if truncated.
fn read_le_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    let slice = bytes.get(offset..offset.checked_add(8)?)?;
    Some(u64::from_le_bytes(slice.try_into().ok()?))
}

/// Lowercase hex of a byte slice.
fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests;
