use std::fmt;

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};

use super::GameexeKeyFamily;

/// Stable warning code emitted for non-catalogue Gameexe.ini keys.
pub const UNKNOWN_GAMEEXE_KEY_CODE: &str = "kaifuu.reallive.inventory.unknown_gameexe_key";

/// One Gameexe.ini entry classified for the inventory layer.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeInventoryEntry {
    /// 1-based line number.
    pub line_number: u64,
    /// Byte offset of the line within the file.
    pub byte_offset: u64,
    /// Byte length of the line (excluding the terminator).
    pub byte_len: u64,
    /// Upper-cased raw key text (e.g. `#FOLDNAME.G00`).
    pub key: String,
    /// Decoded value text. For triple-equals lines (`#FOLDNAME.*`,
    /// `#NAMAE`, `#SE.*`, `#DSTRACK`) the value is the full RHS string;
    /// per-group split is reported in the typed [`GameexeKeyFamily`].
    pub value: String,
    /// High-level treatment bucket the inventory layer consumes.
    pub treatment: GameexeKeyTreatment,
    /// Typed family classification (carries suffix/index data).
    pub family: GameexeKeyFamily,
}

impl fmt::Debug for GameexeInventoryEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GameexeInventoryEntry")
            .field("line_number", &self.line_number)
            .field("byte_offset", &self.byte_offset)
            .field("byte_len", &self.byte_len)
            .field("key", &RedactedContentSummary::from_text(&self.key))
            .field("value", &RedactedContentSummary::from_text(&self.value))
            .field("treatment", &self.treatment)
            .finish()
    }
}

/// High-level treatment of one Gameexe.ini entry.
/// This is the bucket consumed by the inventory layer. The richer
/// per-family classification is in [`GameexeInventoryEntry::family`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameexeKeyTreatment {
    /// User-visible translatable text (window title, character display
    /// name, save-dialog messages, etc.). Emitted as a BridgeUnit.
    BridgeUnit,
    /// Asset path or asset-archive declaration. Emitted as an
    /// AssetReference only.
    AssetReference,
    /// Engine configuration knob: counts, sizes, mode flags, scene-call
    /// dispatch tuples, layout coordinates, palette tables. Neither
    /// translatable nor an asset path.
    Config,
    /// Non-catalogue key. Carries a typed [`UnknownReason`] in
    /// [`GameexeKeyFamily::Unknown`]; warning is paired in
    /// `GameexeInventoryReport`.
    Unknown,
}

/// Why the classifier could not assign a key to a documented family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownReason {
    /// Key parses as `#<NAME>` / `#<NAME>.<...>` but the name doesn't
    /// match any documented family.
    UnknownFamily,
    /// Key is structurally malformed: empty, `#=`, `#.`, contains
    /// nothing after `#`, etc.
    MalformedKey,
}

/// Warning emitted by [`parse_gameexe_inventory`].
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeIniDiagnostic {
    pub code: String,
    pub line_number: u64,
    pub key: String,
    pub message: String,
}

impl fmt::Debug for GameexeIniDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GameexeIniDiagnostic")
            .field("code", &self.code)
            .field("line_number", &self.line_number)
            .field("key", &RedactedContentSummary::from_text(&self.key))
            .field("message", &RedactedContentSummary::from_text(&self.message))
            .finish()
    }
}

/// Output of [`parse_gameexe_inventory`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeInventoryReport {
    pub entries: Vec<GameexeInventoryEntry>,
    pub warnings: Vec<GameexeIniDiagnostic>,
}
