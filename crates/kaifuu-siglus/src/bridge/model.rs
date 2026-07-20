use std::fmt;

use serde_json::Value;
use thiserror::Error;

use kaifuu_core::{BridgeBundleV02, BridgeContractValidationError, RedactedContentSummary};

use crate::{GameexeDatReport, SceneFlowError, SceneSyscallError};

/// Caller-supplied bundle metadata.  All fields are required so a caller never
/// accidentally produces a bridge with an unstable source identity.
#[derive(Debug, Clone)]
pub struct BridgeOpts<'a> {
    pub game_id: &'a str,
    pub game_version: &'a str,
    pub source_profile_id: &'a str,
    pub source_locale: &'a str,
    pub extractor_name: &'a str,
    pub extractor_version: &'a str,
}

/// One SceneList entry after its payload has already been decoded.
#[derive(Clone, Copy)]
pub struct BridgeSceneInput<'a> {
    /// Stable SceneList id, used only if the packed name was absent.
    pub scene_id: u32,
    /// Packed SceneList name.  Supplying it preserves the engine's stable
    /// scene identity in `siglus:scene-<name>#<offset>` keys.
    pub scene_name: Option<&'a str>,
    /// Still-packed bytes for this asset; their hash is the asset revision.
    pub scene_bytes: &'a [u8],
    /// Decrypted, decompressed scene payload containing bytecode and strings.
    pub decoded_scene: &'a [u8],
}

impl fmt::Debug for BridgeSceneInput<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BridgeSceneInput")
            .field("scene_id", &self.scene_id)
            .field("scene_name", &self.scene_name)
            .field(
                "scene_bytes",
                &RedactedContentSummary::from_bytes(self.scene_bytes),
            )
            .field(
                "decoded_scene",
                &RedactedContentSummary::from_bytes(self.decoded_scene),
            )
            .finish()
    }
}

#[derive(Debug, Clone, Error)]
pub enum BridgeProduceError {
    #[error("kaifuu.siglus.bridge.empty_scene: scene {scene_id} decoded to no bytecode")]
    EmptyScene { scene_id: u32 },
    #[error(
        "kaifuu.siglus.bridge.no_text_units: scene {scene_id} has no localizable literal surfaces"
    )]
    NoTextUnits { scene_id: u32 },
    #[error(
        "kaifuu.siglus.bridge.whole_pack_no_text_units: {scene_count} decoded scene(s) yielded no localizable literal surfaces"
    )]
    WholePackNoTextUnits { scene_count: usize },
    #[error("kaifuu.siglus.bridge.flow: {0}")]
    Flow(#[from] SceneFlowError),
    #[error("kaifuu.siglus.bridge.syscall: {0}")]
    Syscall(#[from] SceneSyscallError),
    #[error(
        "kaifuu.siglus.bridge.unlocated_string: scene {scene_id} command {command_offset} has no concrete string-table literal"
    )]
    UnlocatedString {
        scene_id: u32,
        command_offset: usize,
    },
    #[error(
        "kaifuu.siglus.bridge.invalid_string_range: scene {scene_id} string {string_index} has an invalid UTF-16LE span"
    )]
    InvalidStringRange { scene_id: u32, string_index: i32 },
    #[error(
        "kaifuu.siglus.bridge.unlocated_selection_option: scene {scene_id} select command {command_offset} has no literal push site"
    )]
    UnlocatedSelectionOption {
        scene_id: u32,
        command_offset: usize,
    },
    #[error(
        "kaifuu.siglus.bridge.invalid_utf16le: scene {scene_id} string {string_index} is not valid UTF-16LE"
    )]
    InvalidUtf16Le { scene_id: u32, string_index: i32 },
    #[error(
        "kaifuu.siglus.bridge.duplicate_source_unit_key: scene {scene_id} key {source_unit_key}"
    )]
    DuplicateSourceUnitKey {
        scene_id: u32,
        source_unit_key: String,
    },
    #[error(
        "kaifuu.siglus.bridge.protected_span_invalid: scene {scene_id} command {command_offset} span {span_index} does not match source text"
    )]
    ProtectedSpanInvalid {
        scene_id: u32,
        command_offset: usize,
        span_index: usize,
    },
    #[error("kaifuu.siglus.bridge.schema_validation: {0}")]
    SchemaValidation(String),
}

impl From<BridgeContractValidationError> for BridgeProduceError {
    fn from(value: BridgeContractValidationError) -> Self {
        Self::SchemaValidation(value.to_string())
    }
}

/// Validated bridge JSON and its typed contract representation.
#[derive(Clone)]
pub struct ProducedBundle {
    pub bundle: BridgeBundleV02,
    pub json: Value,
}

impl fmt::Debug for ProducedBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProducedBundle")
            .field("bridge_id", &self.bundle.bridge_id)
            .field("unit_count", &self.bundle.units.len())
            .field(
                "json",
                &RedactedContentSummary::from_text(&self.json.to_string()),
            )
            .finish()
    }
}

pub(crate) fn inventory_from_report(report: &GameexeDatReport) -> crate::GameexeInventory {
    crate::GameexeInventory::from_report(report.clone())
}
