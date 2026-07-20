//! `Gameexe.dat` → typed, category-indexed inventory + sanitized summary.
//!
//! [`crate::gameexe::decode_gameexe_dat`] lowers a real `Gameexe.dat` into flat
//! key/value entries. This module is the node's user-facing **reader**: given
//! the raw `SiglusEngine.exe` and `Gameexe.dat` bytes it recovers the per-game
//! exe-angou key in-process (never a raw literal — the key crosses the boundary
//! only as encapsulated [`crate::decrypt::SiglusSecondLayerMaterial`] resolved
//! against a structured secret-ref), decodes the body, and lifts the flat
//! entries into a category-indexed [`GameexeInventory`].
//!
//! # Feeding speaker resolution
//! The downstream speaker-resolution layer selects entries by **key family**:
//! the `NAMAE` family carries the per-index speaker-name table. Rather than
//! re-parsing the INI, a consumer pulls exactly the family it needs, in document
//! order, via [`GameexeInventory::entries_in_category`] (and single keys such as
//! `GAMENAME` via [`GameexeInventory::get`]). The category of a key is the text
//! before its first `.` separator ([`category_of`]).
//!
//! # Sanitized reporting
//! A `Gameexe.ini` value can be copyrighted free-text — the game title in
//! `GAMENAME`, speaker names in the `NAMAE.*` family, disc strings in
//! `DISCMARK`. The typed inventory keeps those values in memory for the
//! in-process consumer, but the only **serializable** artifact,
//! [`GameexeInventorySummary`], discloses structural facts ONLY: the total
//! entry count, per-category entry counts, and per-value-**shape** counts. Key
//! and category names are engine configuration identifiers (not content); raw
//! values never appear in the summary.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::decrypt::SiglusSecondLayerKey;
use crate::exe_angou::{ExeAngouKeyError, recover_exe_angou_key};
use crate::gameexe::{
    GameexeDatEntry, GameexeDatError, GameexeDatReport, decode_gameexe_dat, read_gameexe_header,
};

/// The **category** (key family) of a Gameexe key: the text up to the first `.`
/// separator. `NAMAE.003` → `NAMAE`, `SCREEN_SIZE` → `SCREEN_SIZE`,
/// `GAMENAME` → `GAMENAME`. Category names are engine configuration
/// identifiers, safe to record in a sanitized report.
pub fn category_of(key: &str) -> &str {
    key.split('.').next().unwrap_or(key)
}

/// Structural **shape** of a Gameexe entry value — never its text. Lets a
/// sanitized summary describe a value's form without disclosing any copyrighted
/// free-text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameexeValueShape {
    /// No value text (`key =` with nothing after the `=`).
    Empty,
    /// A single decimal integer (optionally signed), e.g. `1`.
    Integer,
    /// A comma-separated list of two or more decimal integers, e.g. `1280, 720`
    /// (the `SCREEN_SIZE` / geometry family shape).
    IntegerList,
    /// A double-quoted string literal — free-text (title, speaker name, path).
    /// The text itself is withheld from every sanitized report.
    QuotedText,
    /// Any other bare token or free-text value not matching the shapes above.
    Text,
}

impl GameexeValueShape {
    /// Classify a raw value string into its structural shape. Purely a function
    /// of the value's *form*; it neither stores nor discloses the text.
    pub fn classify(value: &str) -> Self {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Self::Empty;
        }
        if trimmed.starts_with('"') {
            return Self::QuotedText;
        }
        if is_decimal_integer(trimmed) {
            return Self::Integer;
        }
        if is_decimal_integer_list(trimmed) {
            return Self::IntegerList;
        }
        Self::Text
    }

    /// Stable lowercase tag used as the summary map key (never a value).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Integer => "integer",
            Self::IntegerList => "integer_list",
            Self::QuotedText => "quoted_text",
            Self::Text => "text",
        }
    }
}

/// Whether `text` is a single optionally-signed decimal integer.
fn is_decimal_integer(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// Whether `text` is a comma-separated list of ≥2 decimal integers.
fn is_decimal_integer_list(text: &str) -> bool {
    let mut parts = 0usize;
    for part in text.split(',') {
        if !is_decimal_integer(part.trim()) {
            return false;
        }
        parts += 1;
    }
    parts >= 2
}

/// A category-indexed view over a decoded `Gameexe.dat`. Wraps the flat
/// [`GameexeDatReport`] with family/key lookups for the speaker-resolution
/// layer, and produces the sanitized [`GameexeInventorySummary`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameexeInventory {
    report: GameexeDatReport,
}

impl GameexeInventory {
    /// Wrap an already-decoded report.
    pub fn from_report(report: GameexeDatReport) -> Self {
        Self { report }
    }

    /// All parsed entries in document order.
    pub fn entries(&self) -> &[GameexeDatEntry] {
        &self.report.entries
    }

    /// Total entry count.
    pub fn len(&self) -> usize {
        self.report.entries.len()
    }

    /// Whether the inventory is empty.
    pub fn is_empty(&self) -> bool {
        self.report.entries.is_empty()
    }

    /// The first entry with this exact key (e.g. `GAMENAME`), if present.
    pub fn get(&self, key: &str) -> Option<&GameexeDatEntry> {
        self.report.entries.iter().find(|entry| entry.key == key)
    }

    /// Entries whose key belongs to `category` (the family before the first
    /// `.`), in document order. Speaker resolution pulls the `NAMAE` family
    /// through this method.
    pub fn entries_in_category<'a>(
        &'a self,
        category: &'a str,
    ) -> impl Iterator<Item = &'a GameexeDatEntry> + 'a {
        self.report
            .entries
            .iter()
            .filter(move |entry| category_of(&entry.key) == category)
    }

    /// Whether at least one entry belongs to `category`.
    pub fn has_category(&self, category: &str) -> bool {
        self.entries_in_category(category).next().is_some()
    }

    /// Distinct category (key-family) names present, sorted. These are engine
    /// configuration identifiers, safe to disclose.
    pub fn categories(&self) -> Vec<String> {
        self.report
            .entries
            .iter()
            .map(|entry| category_of(&entry.key).to_string())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    /// The structural shape of a single entry's value.
    pub fn value_shape(&self, entry: &GameexeDatEntry) -> GameexeValueShape {
        GameexeValueShape::classify(&entry.value)
    }

    /// Build the **sanitized** structural summary: counts only, no raw values.
    pub fn summary(&self) -> GameexeInventorySummary {
        let mut category_counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut value_shape_counts: BTreeMap<String, usize> = BTreeMap::new();
        for entry in &self.report.entries {
            *category_counts
                .entry(category_of(&entry.key).to_string())
                .or_default() += 1;
            *value_shape_counts
                .entry(
                    GameexeValueShape::classify(&entry.value)
                        .as_str()
                        .to_string(),
                )
                .or_default() += 1;
        }
        GameexeInventorySummary {
            entry_count: self.report.entries.len(),
            category_count: category_counts.len(),
            category_counts,
            value_shape_counts,
        }
    }
}

/// The sanitized, serializable summary of a decoded `Gameexe.dat`. Records
/// structural facts ONLY — total entry count, distinct category count,
/// per-category entry counts, and per-value-shape counts. Category names are
/// engine configuration identifiers; no raw copyrighted value ever appears.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeInventorySummary {
    /// Total parsed entry count.
    pub entry_count: usize,
    /// Number of distinct categories (key families).
    pub category_count: usize,
    /// Per-category entry counts (category name → count). Sorted by name.
    pub category_counts: BTreeMap<String, usize>,
    /// Per-value-shape entry counts (shape tag → count). Structural only.
    pub value_shape_counts: BTreeMap<String, usize>,
}

/// Fatal, typed diagnostics for the `Gameexe.dat` reader. Each variant wraps the
/// underlying stage's typed error; every `Display` form begins with the crate's
/// `kaifuu.siglus` honesty marker, so a malformed / wrong-key input surfaces a
/// semantic diagnostic, never garbage.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GameexeReadError {
    /// The per-game exe-angou key could not be recovered from the executable
    /// (non-PE, packed/protected, or unmapped gather source).
    #[error("kaifuu.siglus.gameexe.key_recovery: {source}")]
    KeyRecovery {
        #[source]
        source: ExeAngouKeyError,
    },
    /// The `Gameexe.dat` body failed to decode (truncated, wrong key/cipher, or
    /// invalid UTF-16LE).
    #[error("kaifuu.siglus.gameexe.decode: {source}")]
    Decode {
        #[source]
        source: GameexeDatError,
    },
}

impl From<ExeAngouKeyError> for GameexeReadError {
    fn from(source: ExeAngouKeyError) -> Self {
        Self::KeyRecovery { source }
    }
}

impl From<GameexeDatError> for GameexeReadError {
    fn from(source: GameexeDatError) -> Self {
        Self::Decode { source }
    }
}

/// Read a `Gameexe.dat` into a typed [`GameexeInventory`], recovering the
/// per-game exe-angou key in-process from `SiglusEngine.exe` bytes.
///
/// The outer header is read first; only when it declares `exe_angou_mode != 0`
/// is the key recovered (via [`recover_exe_angou_key`]) and threaded into the
/// decode as encapsulated material bound to `key_ref` — the raw key never
/// appears as a literal. A `Gameexe.dat` that declares no exe-angou mask decodes
/// with no key. Every failure is a typed [`GameexeReadError`].
pub fn read_gameexe_inventory(
    exe_bytes: &[u8],
    gameexe_bytes: &[u8],
    key_ref: &SiglusSecondLayerKey,
) -> Result<GameexeInventory, GameexeReadError> {
    let header = read_gameexe_header(gameexe_bytes)?;
    let report: GameexeDatReport = if header.exe_angou_mode != 0 {
        let recovery = recover_exe_angou_key(exe_bytes, key_ref)?;
        decode_gameexe_dat(gameexe_bytes, Some(recovery.material()))?
    } else {
        decode_gameexe_dat(gameexe_bytes, None)?
    };
    Ok(GameexeInventory::from_report(report))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gameexe::GameexeDatEntry;

    fn entry(key: &str, value: &str) -> GameexeDatEntry {
        GameexeDatEntry {
            key: key.to_string(),
            value: value.to_string(),
        }
    }

    fn sample_inventory() -> GameexeInventory {
        GameexeInventory::from_report(GameexeDatReport {
            entries: vec![
                entry("GAMENAME", "\"secret-title-text\""),
                entry("SCREEN_SIZE", "1280, 720"),
                entry("NAMAE.000", "\"speaker-one\""),
                entry("NAMAE.001", "\"speaker-two\""),
                entry("BGMFADE2.003", "1500"),
                entry("MANUAL_PATH", ""),
                entry("START_SCENE", "openscene"),
            ],
        })
    }

    #[test]
    fn category_of_splits_on_first_dot() {
        assert_eq!(category_of("NAMAE.003"), "NAMAE");
        assert_eq!(category_of("GAMENAME"), "GAMENAME");
        assert_eq!(category_of("SCREEN_SIZE"), "SCREEN_SIZE");
        assert_eq!(category_of("A.B.C"), "A");
    }

    #[test]
    fn value_shape_classifies_structurally() {
        assert_eq!(GameexeValueShape::classify(""), GameexeValueShape::Empty);
        assert_eq!(GameexeValueShape::classify("   "), GameexeValueShape::Empty);
        assert_eq!(
            GameexeValueShape::classify("42"),
            GameexeValueShape::Integer
        );
        assert_eq!(
            GameexeValueShape::classify("-7"),
            GameexeValueShape::Integer
        );
        assert_eq!(
            GameexeValueShape::classify("1280, 720"),
            GameexeValueShape::IntegerList
        );
        assert_eq!(
            GameexeValueShape::classify("\"Rin\""),
            GameexeValueShape::QuotedText
        );
        assert_eq!(
            GameexeValueShape::classify("openscene"),
            GameexeValueShape::Text
        );
    }

    #[test]
    fn inventory_indexes_by_category_and_key() {
        let inventory = sample_inventory();
        assert_eq!(inventory.len(), 7);
        assert!(!inventory.is_empty());
        // NAMAE family — the speaker-name feed for the resolution layer.
        let namae: Vec<_> = inventory.entries_in_category("NAMAE").collect();
        assert_eq!(namae.len(), 2);
        assert_eq!(namae[0].key, "NAMAE.000");
        assert_eq!(namae[1].key, "NAMAE.001");
        assert!(inventory.has_category("GAMENAME"));
        assert!(!inventory.has_category("DISCMARK"));
        assert_eq!(
            inventory.get("SCREEN_SIZE").map(|e| e.key.as_str()),
            Some("SCREEN_SIZE")
        );
        assert!(inventory.get("MISSING").is_none());
        assert!(inventory.categories().contains(&"NAMAE".to_string()));
    }

    #[test]
    fn summary_counts_categories_and_shapes() {
        let summary = sample_inventory().summary();
        assert_eq!(summary.entry_count, 7);
        assert_eq!(summary.category_count, 6);
        assert_eq!(summary.category_counts.get("NAMAE"), Some(&2));
        assert_eq!(summary.category_counts.get("GAMENAME"), Some(&1));
        // GAMENAME + two NAMAE names are all quoted free-text.
        assert_eq!(summary.value_shape_counts.get("quoted_text"), Some(&3));
        assert_eq!(summary.value_shape_counts.get("integer_list"), Some(&1));
        assert_eq!(summary.value_shape_counts.get("integer"), Some(&1));
        assert_eq!(summary.value_shape_counts.get("empty"), Some(&1));
        assert_eq!(summary.value_shape_counts.get("text"), Some(&1));
    }

    #[test]
    fn summary_never_discloses_raw_values() {
        // The sanitized summary must serialize without any copyrighted free-text.
        let summary = sample_inventory().summary();
        let json = serde_json::to_string(&summary).expect("summary serializes");
        assert!(!json.contains("secret-title-text"));
        assert!(!json.contains("speaker-one"));
        assert!(!json.contains("openscene"));
        // Only structural facts (counts + category/shape names) survive.
        assert!(json.contains("NAMAE"));
        assert!(json.contains("quoted_text"));
    }

    #[test]
    fn reader_wraps_truncated_header_as_decode_diagnostic() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/exe-angou");
        // Fewer than the 8-byte outer header → semantic decode diagnostic.
        let err = read_gameexe_inventory(b"MZ", &[0u8; 4], &key_ref).expect_err("truncated");
        assert!(matches!(
            err,
            GameexeReadError::Decode {
                source: GameexeDatError::TruncatedHeader { .. }
            }
        ));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }

    #[test]
    fn reader_wraps_non_pe_exe_as_key_recovery_diagnostic() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/exe-angou");
        // Header declares exe_angou_mode = 1, so key recovery runs; a non-PE
        // "executable" must fail with a semantic key-recovery diagnostic.
        let mut dat = Vec::new();
        dat.extend_from_slice(&0i32.to_le_bytes()); // version
        dat.extend_from_slice(&1i32.to_le_bytes()); // exe_angou_mode
        dat.extend_from_slice(&[0u8; 16]); // arbitrary body
        let err = read_gameexe_inventory(b"not an executable", &dat, &key_ref).expect_err("non-pe");
        assert!(matches!(
            err,
            GameexeReadError::KeyRecovery {
                source: ExeAngouKeyError::NotPortableExecutable { .. }
            }
        ));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
