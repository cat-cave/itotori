//! Private-local RPG Maker MV/MZ **owned-game readiness report** (the redacted,
//! aggregate-only readiness lane for a private-local owned title).
//!
//! # What this is
//! A local operator points [`scan_mv_mz_readiness_report`] at a directory of
//! their own owned RPG Maker MV/MZ game (the `www/` tree, or a project root
//! that contains `www/data/`). The scan reads real bytes — it walks assets for
//! a suffix histogram, checks `data/System.json` for an `encryptionKey`
//! **presence** flag only, tallies map event-command text surfaces by role,
//! classifies helper requirements from encrypted-suffix + key evidence, and
//! hashes every `data/*.json` body into one aggregate fingerprint.
//!
//! # Redaction is the whole point
//! The returned [`MvMzReadinessReport`] carries EXACTLY six aggregate fields
//! and nothing else:
//! `spec`, `assetSuffixHistogram`, `systemJsonHasEncryptionKey`,
//! `mapTextSurfaceCounts`, `helperRequirements`, `aggregateDataHashSha256`.
//! Redaction is *structural*, not a scrub pass:
//! - No filename, relative path, or absolute path is ever placed in the report
//!   — files contribute only to suffix buckets, surface-role totals, and the
//!   aggregate hash.
//! - No `System.json.encryptionKey` byte string is retained — presence is a
//!   boolean only.
//! - No map dialogue / choice / comment text is retained — only role-name
//!   counts (engine vocabulary: `show_text`, `choice_option`, …).
//! - Helper requirement tokens are fixed engine vocabulary (`none`,
//!   `asset_encryption_key`), never secret refs or paths.
//! - The one hash (`aggregateDataHashSha256`) is a single SHA-256 over the
//!   concatenation of every `data/*.json` body in deterministic order — an
//!   aggregate fingerprint, not a per-file index.
//!
//! Because the report is aggregate-only by construction, it is safe to commit /
//! publish even though the scan ran over private, copyrighted owned bytes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{KaifuuResult, stable_json};

/// Spec identifier + version stamped into every report. A fixed constant — it
/// carries no game-derived data.
pub const MV_MZ_READINESS_REPORT_SPEC: &str = "kaifuu.rpgmaker.mv_mz_readiness_report@0.1.0";

/// Encrypted MV/MZ media suffixes (lowercase, no leading dot). Presence of any
/// of these drives the helper-requirement classification.
const ENCRYPTED_MEDIA_SUFFIXES: &[&str] = &[
    "rpgmvp", "rpgmvm", "rpgmvo", "rpgmvu", "png_", "m4a_", "ogg_",
];

/// Fixed helper-requirement token: no external helper is required.
pub const HELPER_NONE: &str = "none";
/// Fixed helper-requirement token: encrypted media is present but
/// `System.json` has no usable `encryptionKey` — a local key import is needed.
pub const HELPER_ASSET_ENCRYPTION_KEY: &str = "asset_encryption_key";

/// A private-local RPG Maker MV/MZ owned-game readiness report.
///
/// Serializes to EXACTLY six top-level keys (`spec`, `assetSuffixHistogram`,
/// `systemJsonHasEncryptionKey`, `mapTextSurfaceCounts`, `helperRequirements`,
/// `aggregateDataHashSha256`). Adding a field here is a redaction-boundary
/// change and must be treated as one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzReadinessReport {
    /// Fixed spec/version identifier ([`MV_MZ_READINESS_REPORT_SPEC`]).
    pub spec: String,
    /// Count of files per lowercase file-suffix bucket. Keys are suffix tokens
    /// only (`json`, `rpgmvp`, `png_`, …) — never basenames or paths.
    pub asset_suffix_histogram: BTreeMap<String, u64>,
    /// `true` iff `data/System.json` carries a non-empty `encryptionKey`
    /// string. The key bytes themselves are never retained.
    pub system_json_has_encryption_key: bool,
    /// Count of map event-command text surfaces per role name across every
    /// `MapNNN.json`. Keys are fixed engine-vocabulary role tokens
    /// (`show_text`, `choice_option`, `choice_branch`, `scrolling_text`,
    /// `comment`) — never dialogue text or map filenames.
    pub map_text_surface_counts: BTreeMap<String, u64>,
    /// Sorted list of fixed helper-requirement tokens. Empty of game-specific
    /// or path-bearing values by construction.
    pub helper_requirements: Vec<String>,
    /// Lowercase hex SHA-256 over the concatenation of every `data/*.json`
    /// body, in deterministic basename order — one aggregate fingerprint.
    pub aggregate_data_hash_sha256: String,
}

impl MvMzReadinessReport {
    /// Stable, deterministic JSON for committing / publishing. Aggregate-only
    /// by construction, so no additional redaction pass is required.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }
}

/// Scan a private-local owned RPG Maker MV/MZ game directory and return the
/// redacted, aggregate-only readiness report.
///
/// `game_dir` is the directory that contains `data/` (the usual `www/` root),
/// or a project root that contains `www/data/`. Errors never embed the input
/// path string.
pub fn scan_mv_mz_readiness_report(game_dir: &Path) -> KaifuuResult<MvMzReadinessReport> {
    let data_dir = resolve_data_dir(game_dir)?;
    let walk_root = resolve_walk_root(game_dir, &data_dir);

    let asset_suffix_histogram = collect_suffix_histogram(&walk_root)?;
    let system_json_has_encryption_key = system_json_has_encryption_key(&data_dir);
    let map_text_surface_counts = collect_map_text_surface_counts(&data_dir)?;
    let (aggregate_data_hash_sha256, _json_count) = aggregate_data_json_hash(&data_dir)?;

    let encrypted_media_present = ENCRYPTED_MEDIA_SUFFIXES
        .iter()
        .any(|suffix| asset_suffix_histogram.contains_key(*suffix));
    let helper_requirements =
        classify_helper_requirements(encrypted_media_present, system_json_has_encryption_key);

    Ok(MvMzReadinessReport {
        spec: MV_MZ_READINESS_REPORT_SPEC.to_string(),
        asset_suffix_histogram,
        system_json_has_encryption_key,
        map_text_surface_counts,
        helper_requirements,
        aggregate_data_hash_sha256,
    })
}

/// Resolve `data/` under `game_dir` or `game_dir/www/`. Errors without the path.
fn resolve_data_dir(game_dir: &Path) -> KaifuuResult<PathBuf> {
    let direct = game_dir.join("data");
    if direct.is_dir() {
        return Ok(direct);
    }
    let under_www = game_dir.join("www").join("data");
    if under_www.is_dir() {
        return Ok(under_www);
    }
    Err("kaifuu.rpgmaker.mv_mz_readiness_report: game directory has no data/ folder".into())
}

/// Walk root for the asset suffix histogram: the `www/` parent when the data
/// dir is `…/www/data`, otherwise `game_dir` itself.
fn resolve_walk_root(game_dir: &Path, data_dir: &Path) -> PathBuf {
    if data_dir.ends_with(Path::new("www").join("data")) {
        data_dir
            .parent()
            .map_or_else(|| game_dir.to_path_buf(), Path::to_path_buf)
    } else {
        game_dir.to_path_buf()
    }
}

/// Recursively count files by lowercase extension (no leading dot). Extensionless
/// files use the fixed bucket token `_none`. Never records basenames or paths.
fn collect_suffix_histogram(walk_root: &Path) -> KaifuuResult<BTreeMap<String, u64>> {
    let mut histogram: BTreeMap<String, u64> = BTreeMap::new();
    let mut stack = vec![walk_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|_| -> Box<dyn std::error::Error> {
            "kaifuu.rpgmaker.mv_mz_readiness_report: could not read a game subdirectory".into()
        })?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let suffix = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map_or_else(|| "_none".to_string(), str::to_ascii_lowercase);
            *histogram.entry(suffix).or_insert(0) += 1;
        }
    }
    Ok(histogram)
}

/// `true` iff `data/System.json` has a non-empty string `encryptionKey`. Never
/// returns or stores the key value.
fn system_json_has_encryption_key(data_dir: &Path) -> bool {
    let path = data_dir.join("System.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    value
        .get("encryptionKey")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

/// Tally map event-command text surfaces by role across every `MapNNN.json`
/// under `data/`. Best-effort per file: malformed JSON contributes zero.
fn collect_map_text_surface_counts(data_dir: &Path) -> KaifuuResult<BTreeMap<String, u64>> {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut map_names: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(data_dir).map_err(|_| -> Box<dyn std::error::Error> {
        "kaifuu.rpgmaker.mv_mz_readiness_report: could not read the data directory".into()
    })?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_map_file(&name) && entry.path().is_file() {
            map_names.push(name);
        }
    }
    map_names.sort();
    for name in map_names {
        let path = data_dir.join(&name);
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        accumulate_map_text_surfaces(&value, &mut counts);
    }
    Ok(counts)
}

/// `MapNNN.json` (digits only) — excludes `MapInfos.json`.
fn is_map_file(file: &str) -> bool {
    let Some(stem) = file.strip_suffix(".json") else {
        return false;
    };
    let Some(digits) = stem.strip_prefix("Map") else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Walk one map JSON value and tally declared text-surface roles. Counts
/// occurrences only — never retains parameter string contents.
fn accumulate_map_text_surfaces(value: &serde_json::Value, counts: &mut BTreeMap<String, u64>) {
    let Some(events) = value.get("events").and_then(serde_json::Value::as_array) else {
        return;
    };
    for event in events {
        if event.is_null() {
            continue;
        }
        let Some(pages) = event.get("pages").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for page in pages {
            let Some(list) = page.get("list").and_then(serde_json::Value::as_array) else {
                continue;
            };
            for command in list {
                let Some(code) = command.get("code").and_then(serde_json::Value::as_i64) else {
                    continue;
                };
                let params = command
                    .get("parameters")
                    .and_then(serde_json::Value::as_array);
                match code {
                    401 => {
                        if params
                            .and_then(|p| p.first())
                            .and_then(serde_json::Value::as_str)
                            .is_some()
                        {
                            *counts.entry("show_text".to_string()).or_insert(0) += 1;
                        }
                    }
                    405 => {
                        if params
                            .and_then(|p| p.first())
                            .and_then(serde_json::Value::as_str)
                            .is_some()
                        {
                            *counts.entry("scrolling_text".to_string()).or_insert(0) += 1;
                        }
                    }
                    108 | 408 => {
                        if params
                            .and_then(|p| p.first())
                            .and_then(serde_json::Value::as_str)
                            .is_some()
                        {
                            *counts.entry("comment".to_string()).or_insert(0) += 1;
                        }
                    }
                    402 => {
                        if params
                            .and_then(|p| p.get(1))
                            .and_then(serde_json::Value::as_str)
                            .is_some()
                        {
                            *counts.entry("choice_branch".to_string()).or_insert(0) += 1;
                        }
                    }
                    102 => {
                        if let Some(options) = params
                            .and_then(|p| p.first())
                            .and_then(serde_json::Value::as_array)
                        {
                            for option in options {
                                if option.as_str().is_some() {
                                    *counts.entry("choice_option".to_string()).or_insert(0) += 1;
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// SHA-256 of the concatenation of every `data/*.json` body in sorted basename
/// order. Returns (lowercase hex, file count).
fn aggregate_data_json_hash(data_dir: &Path) -> KaifuuResult<(String, u64)> {
    let mut names: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(data_dir).map_err(|_| -> Box<dyn std::error::Error> {
        "kaifuu.rpgmaker.mv_mz_readiness_report: could not read the data directory".into()
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_json = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
        if is_json {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    let mut digest = Sha256::new();
    let mut count = 0_u64;
    for name in names {
        let path = data_dir.join(&name);
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        digest.update(&bytes);
        count += 1;
    }
    Ok((hex_lower(&digest.finalize()), count))
}

/// Classify helper requirements from encrypted-media + key-presence evidence.
/// Returns only fixed vocabulary tokens, sorted.
fn classify_helper_requirements(
    encrypted_media_present: bool,
    has_encryption_key: bool,
) -> Vec<String> {
    if encrypted_media_present && !has_encryption_key {
        vec![HELPER_ASSET_ENCRYPTION_KEY.to_string()]
    } else {
        vec![HELPER_NONE.to_string()]
    }
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
