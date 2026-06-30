//! Siglus scene bytecode → v0.2 BridgeBundle producer — **skeleton**
//! (siglus-05).
//!
//! Mirrors `kaifuu-reallive`'s `bridge` module: walks a decompiled
//! [`crate::opcode::SiglusOpcode`] sequence into a
//! [`kaifuu_core::BridgeBundleV02`], emitting one translatable unit per
//! dialogue / choice-label surface with provenance anchored in the
//! **decompressed** scene-bytecode stream and protected spans pinned over
//! Siglus control markers.
//!
//! Skeleton status: [`produce_bundle`] returns
//! [`BridgeProduceError::NotImplemented`]. The real producer depends on
//! the (downstream) decompiler and Gameexe.dat inventory.

use serde_json::Value;
use thiserror::Error;

use kaifuu_core::{BridgeBundleV02, BridgeContractValidationError};

use crate::gameexe::GameexeDatReport;

/// Caller-supplied knobs for [`produce_bundle`] (mirrors the RealLive
/// `BridgeOpts` shape; all fields required, no silent defaults).
#[derive(Debug, Clone)]
pub struct BridgeOpts<'a> {
    /// Stable game id (e.g. `"karetoshi"`).
    pub game_id: &'a str,
    /// Human-readable game version label.
    pub game_version: &'a str,
    /// Source-profile id (stable per kaifuu extractor profile).
    pub source_profile_id: &'a str,
    /// Source locale tag for the decoded text (`"ja-JP"`).
    pub source_locale: &'a str,
    /// Extractor name embedded in `extractor.name`.
    pub extractor_name: &'a str,
    /// Extractor version embedded in `extractor.version`.
    pub extractor_version: &'a str,
}

/// Fatal errors raised by [`produce_bundle`].
#[derive(Debug, Clone, Error)]
pub enum BridgeProduceError {
    /// The bridge producer is not implemented in the skeleton.
    #[error(
        "kaifuu.siglus.bridge.not_implemented: Siglus BridgeBundleV02 producer is a siglus-05 \
         skeleton stub; the real producer depends on the downstream decompiler + Gameexe.dat \
         inventory and lands against real bytes"
    )]
    NotImplemented,
    /// The scene decoded to zero opcodes (no silent empty bundle).
    #[error("kaifuu.siglus.bridge.empty_scene: scene {scene_id} produced no opcodes")]
    EmptyScene { scene_id: u32 },
    /// Wrapped v0.2 schema validation error (producer-internal
    /// regression).
    #[error("kaifuu.siglus.bridge.schema_validation: {0}")]
    SchemaValidation(String),
}

impl From<BridgeContractValidationError> for BridgeProduceError {
    fn from(value: BridgeContractValidationError) -> Self {
        Self::SchemaValidation(value.to_string())
    }
}

/// Output of [`produce_bundle`]: the validated typed bundle plus the raw
/// JSON value the v0.2 validator accepted (mirrors RealLive's
/// `ProducedBundle`).
#[derive(Debug, Clone)]
pub struct ProducedBundle {
    pub bundle: BridgeBundleV02,
    pub json: Value,
}

/// Walk a Siglus scene's decompiled bytecode into a v0.2 BridgeBundle.
///
/// `scene_id` is the `SceneList` scene index; `scene_bytes` is the raw
/// packed scene blob; `decompressed_bytecode` is the post-decrypt,
/// post-LZSS bytecode the caller already produced; `gameexe_inventory` is
/// the parsed `Gameexe.dat` inventory used for speaker resolution.
///
/// Skeleton: always returns [`BridgeProduceError::NotImplemented`].
pub fn produce_bundle(
    _scene_id: u32,
    _scene_bytes: &[u8],
    _decompressed_bytecode: &[u8],
    _gameexe_inventory: &GameexeDatReport,
    _opts: &BridgeOpts<'_>,
) -> Result<ProducedBundle, BridgeProduceError> {
    Err(BridgeProduceError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts_for_test() -> BridgeOpts<'static> {
        BridgeOpts {
            game_id: "siglus-skeleton-test",
            game_version: "test",
            source_profile_id: "kaifuu-siglus-skeleton-test",
            source_locale: "ja-JP",
            extractor_name: "kaifuu-siglus-bridge",
            extractor_version: "0.0.0",
        }
    }

    #[test]
    fn skeleton_producer_returns_typed_not_implemented_not_fake_bundle() {
        let report = GameexeDatReport {
            entries: Vec::new(),
        };
        let err = produce_bundle(1, &[0u8; 32], &[0u8; 8], &report, &opts_for_test())
            .expect_err("skeleton must not fabricate a bridge bundle");
        assert!(matches!(err, BridgeProduceError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
