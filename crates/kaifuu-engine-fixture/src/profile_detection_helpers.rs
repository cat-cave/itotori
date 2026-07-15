use super::*;

// Case-insensitive direct-child lookup.
// The lookup mirrors the existing `ArchiveDetectionScan.file_name_count`
// case-insensitive pattern. Returns the resolved path on a hit so callers
// can read its bytes; returns None if no direct child matches the lowercase
// name. Used only against `game_dir` (no recursion); RealLive top-level
// markers are always at the game root per Haeleth's public documentation.
pub(crate) fn case_insensitive_find(dir: &Path, name: &str) -> Option<std::path::PathBuf> {
    let target = name.to_ascii_lowercase();
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        if let Some(entry_name) = entry.file_name().to_str()
            && entry_name.to_ascii_lowercase() == target
        {
            return Some(entry.path());
        }
    }
    None
}

// walks the effective RealLive data dir (the resolved
// REALLIVEDATA subdir or, when no marker was found, the game root) up
// to two directory levels deep to count corroborating extensions and
// the AVG32 disqualifier. The depth-2 bound captures Sweetie HD's
// observed layout (`<REALLIVEDATA>/g00/*.g00`,
// `<REALLIVEDATA>/koe/*.koe`, etc.) without descending into save /
// debug subtrees that ship with some retail installers. See
// `docs/audits/real-bytes-validation-2026-06-24.md` §2.1 for the
// `find <REALLIVEDATA> -maxdepth 2` reference command that fixed the
// 2,450 `.g00` / 139 `.koe` corpus counts.
pub(super) fn reallive_extension_counts(dir: &Path) -> (u64, u64, u64) {
    let mut g00_count: u64 = 0;
    let mut voice_archive_count: u64 = 0;
    let mut pdt_count: u64 = 0;
    walk_reallive_extension_dir(
        dir,
        2,
        0,
        &mut g00_count,
        &mut voice_archive_count,
        &mut pdt_count,
    );
    (g00_count, voice_archive_count, pdt_count)
}

fn walk_reallive_extension_dir(
    dir: &Path,
    max_depth: usize,
    current_depth: usize,
    g00_count: &mut u64,
    voice_archive_count: &mut u64,
    pdt_count: &mut u64,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if current_depth < max_depth {
                walk_reallive_extension_dir(
                    &path,
                    max_depth,
                    current_depth + 1,
                    g00_count,
                    voice_archive_count,
                    pdt_count,
                );
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(extension) = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
        else {
            continue;
        };
        match extension.as_str() {
            "g00" => *g00_count += 1,
            "ovk" | "koe" | "nwk" => *voice_archive_count += 1,
            "pdt" => *pdt_count += 1,
            _ => {}
        }
    }
}

// Generic real-shape SEEN.TXT envelope check.
// Derivation: every RealLive title since AVG32 stores SEEN.TXT as a fixed
// 10,000-slot directory of (u32_le offset, u32_le size) pairs at file
// offset 0. Each slot is 8 bytes; an unused slot is zeroed. See
// `docs/research/reallive-engine.md` §C and the Sweetie HD verification
// in `docs/audits/real-bytes-validation-2026-06-24.md` §2.8.
// We accept any file that is at least 80,000 bytes long (the fixed
// directory), contains at least one non-zero slot, and whose every
// non-zero slot resolves to a payload range inside the file. We do not
// parse scene bytecode.
pub(super) fn reallive_seen_txt_envelope_ok(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let file_len = metadata.len();
    if file_len < kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    match kaifuu_reallive::parse_archive(&bytes) {
        Ok(index) => !index.entries.is_empty(),
        Err(_) => false,
    }
}

// Read up to 64 KiB of Gameexe.ini and check for the documented
// RealLive-specific ASCII key prefixes. The detector intentionally only
// looks at ASCII prefixes; full Gameexe parsing (including Shift-JIS
// values) is a concern.
pub(super) fn reallive_gameexe_ini_key_hits(path: &Path) -> GameexeIniKeyHits {
    let Ok(bytes) = fs::read(path) else {
        return GameexeIniKeyHits::default();
    };
    let limit = std::cmp::min(bytes.len(), 64 * 1024);
    let slice = &bytes[..limit];
    let text = String::from_utf8_lossy(slice);
    let mut hits = GameexeIniKeyHits::default();
    for raw_line in text.lines() {
        let line = raw_line.trim_start();
        if !line.starts_with('#') {
            continue;
        }
        // Uppercase the key portion only (before '=' or whitespace) for
        // robustness, then match the RealLive Gameexe.ini key prefixes that
        // are positive engine evidence. These prefixes are documented on
        // Haeleth's RLDEV site (https://dev.haeleth.net/rldev.shtml) and
        // observable in any RealLive title's Gameexe.ini; none are copied
        // from rlvm source. This match is the single source of truth.
        let key_end = line
            .find(|c: char| c == '=' || c.is_whitespace())
            .unwrap_or(line.len());
        let key = line[..key_end].to_ascii_uppercase();
        if key == "#GAMEEXE_VERSION" {
            hits.gameexe_version = true;
        } else if key == "#REGNAME" {
            hits.regname = true;
        } else if key.starts_with("#G00") {
            hits.g00_key = true;
        } else if key.starts_with("#KOE") {
            hits.koe_key = true;
        } else if key.starts_with("#SEEN") {
            hits.seen_key = true;
        }
    }
    hits
}

pub(super) fn gameexe_ini_detail(exists: bool, keys: GameexeIniKeyHits) -> String {
    if !exists {
        return "Gameexe.ini missing".to_string();
    }
    if !keys.any() {
        return "Gameexe.ini present but no RealLive-specific keys matched".to_string();
    }
    let mut matched = Vec::new();
    if keys.gameexe_version {
        matched.push("#GAMEEXE_VERSION");
    }
    if keys.regname {
        matched.push("#REGNAME");
    }
    if keys.g00_key {
        matched.push("#G00*");
    }
    if keys.koe_key {
        matched.push("#KOE*");
    }
    if keys.seen_key {
        matched.push("#SEEN*");
    }
    format!("Gameexe.ini RealLive keys matched: {}", matched.join(", "))
}

// Bounded byte-substring search used to recognise Softpal PAC entry names in a
// header/table prefix. `haystack` is at most `SOFTPAL_PAC_TABLE_SCAN_LEN` and
// `needle` is a short entry name, so the naive scan is comfortably bounded.
pub(crate) fn bytes_contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

pub(super) fn file_starts_with(path: &Path, expected: &[u8]) -> bool {
    fs::read(path).is_ok_and(|bytes| bytes.starts_with(expected))
}

// Read up to `len` leading bytes of `path` without loading the whole file
// (Scene.pck archives are multi-megabyte; the detector only needs the header).
pub(crate) fn read_file_prefix(path: &Path, len: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; len];
    let mut filled = 0;
    while filled < len {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    Some(buf)
}

pub(crate) fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

// Shannon entropy (bits/byte) over `bytes`. Used only to distinguish an
// encrypted Siglus Gameexe.dat payload from a plaintext file that happens to
// share the 8-byte prefix; not a cryptographic measure.
fn shannon_entropy_bits(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &byte in bytes {
        counts[byte as usize] += 1;
    }
    let len = bytes.len() as f64;
    let mut entropy = 0.0;
    for &count in &counts {
        if count > 0 {
            let probability = count as f64 / len;
            entropy -= probability * probability.log2();
        }
    }
    entropy
}

// Recognise a REAL (non-synthetic) Siglus `Scene.pck` archive by its plaintext
// header shape: the header-size dword equals the fixed `0x5C`, the second
// dword equals that header size (the first index section starts immediately
// after the header), and the header's `(offset, count)` index-section pairs
// expose a monotonically ascending, in-bounds run of offsets. Identify-level
// only: the archive body is neither parsed nor decrypted here. See the
// `SIGLUS_SCENE_REAL_*` constants for provenance and the false-positive
// analysis in the tests.
pub(super) fn siglus_scene_pck_real_signature_ok(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let file_len = metadata.len();
    let header_len = u64::from(SIGLUS_SCENE_REAL_HEADER_SIZE);
    // The first index section starts at `header_size`, so a real archive is
    // always strictly longer than its header.
    if file_len <= header_len {
        return false;
    }
    let header_size_usize = SIGLUS_SCENE_REAL_HEADER_SIZE as usize;
    let Some(header) = read_file_prefix(path, header_size_usize) else {
        return false;
    };
    if header.len() < header_size_usize {
        return false;
    }
    let Some(header_size) = read_u32_le(&header, 0) else {
        return false;
    };
    if header_size != SIGLUS_SCENE_REAL_HEADER_SIZE {
        return false;
    }
    let Some(first_offset) = read_u32_le(&header, 4) else {
        return false;
    };
    if first_offset != header_size {
        return false;
    }
    // Header layout: `header_size` dword followed by `(offset, count)` pairs.
    // Walk the offset slots (odd dword indices) and count the leading run that
    // is strictly ascending, at/after the header, and inside the file.
    let dword_count = (header_size / 4) as usize;
    let mut previous_offset = 0u32;
    let mut ascending_offsets = 0usize;
    let mut index = 1usize;
    while index < dword_count {
        let Some(offset) = read_u32_le(&header, index * 4) else {
            break;
        };
        if u64::from(offset) >= file_len
            || offset <= previous_offset
            || u64::from(offset) < header_len
        {
            break;
        }
        previous_offset = offset;
        ascending_offsets += 1;
        index += 2;
    }
    ascending_offsets >= SIGLUS_SCENE_REAL_MIN_ASCENDING_OFFSETS
}

// Recognise a REAL (non-synthetic) Siglus `Gameexe.dat` by its plaintext
// 8-byte prefix (a zero dword followed by the `1` version dword) plus an
// encrypted, high-entropy payload. Identify-level only: the payload is not
// decrypted. The entropy gate keeps a plaintext file that happens to share
// the prefix from false-positiving.
pub(super) fn siglus_gameexe_dat_real_signature_ok(path: &Path) -> bool {
    let Some(prefix) = read_file_prefix(path, 8 + SIGLUS_GAMEEXE_REAL_ENTROPY_WINDOW) else {
        return false;
    };
    if prefix.len() < 8 + SIGLUS_GAMEEXE_REAL_MIN_BODY_LEN {
        return false;
    }
    let Some(reserved) = read_u32_le(&prefix, 0) else {
        return false;
    };
    let Some(version) = read_u32_le(&prefix, 4) else {
        return false;
    };
    if reserved != 0 || version != SIGLUS_GAMEEXE_REAL_VERSION {
        return false;
    }
    shannon_entropy_bits(&prefix[8..]) >= SIGLUS_GAMEEXE_REAL_MIN_ENTROPY_BITS
}

// normalises a `Path` to a forward-slash string for the
// JSON-serialised `DetectionEvidence.path` field. Detector evidence is
// always reported with `/` separators because the detection report is
// platform-portable.
pub(super) fn path_to_forward_slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

// prepends the resolved REALLIVEDATA/ relative path to a
// top-level marker file name so the evidence row points at the actual
// on-disk location. Falls back to the bare marker name when no nested
// dir was resolved (synthetic-fixture compatibility).
pub(super) fn nest_evidence_path(resolved_data_dir: Option<&str>, marker: &str) -> String {
    match resolved_data_dir {
        Some(dir) if !dir.is_empty() => format!("{dir}/{marker}"),
        _ => marker.to_string(),
    }
}

pub(super) fn xp3_inventory_asset_kind(path: &str) -> AssetInventoryAssetKind {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("ks" | "tjs" | "txt") => AssetInventoryAssetKind::Script,
        Some("png" | "jpg" | "jpeg" | "bmp" | "webp") => AssetInventoryAssetKind::Image,
        Some("ogg" | "wav" | "mp3" | "m4a") => AssetInventoryAssetKind::Audio,
        Some("ttf" | "otf") => AssetInventoryAssetKind::Font,
        _ => AssetInventoryAssetKind::Unknown,
    }
}

pub(super) fn evidence_status(exists: bool, signature_matches: bool) -> EvidenceStatus {
    if signature_matches {
        EvidenceStatus::Matched
    } else if exists {
        EvidenceStatus::Invalid
    } else {
        EvidenceStatus::Missing
    }
}

pub(super) fn signature_detail(exists: bool, signature_matches: bool, label: &str) -> String {
    match (exists, signature_matches) {
        (_, true) => format!("{label} matched"),
        (true, false) => {
            format!("{label} is present but does not match the synthetic fixture signature")
        }
        (false, false) => format!("{label} is missing"),
    }
}
