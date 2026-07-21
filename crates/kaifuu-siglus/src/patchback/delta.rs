//! Per-scene patch delta producer — **skeleton**.
//! Produces the unit-level edit record (a [`SiglusScenePatchDelta`]) that
//! [`super::bundle_driven::apply_translated_bundle`] splices into a scene.
//! Keeping delta production separate from archive re-emit mirrors the
//! kaifuu split between the bundle-driven driver and the lower-level
//! per-scene edit math.
//! Skeleton status: [`produce_scene_delta`] returns
//! [`SiglusDeltaError::NotImplemented`].

use thiserror::Error;

/// A computed per-scene patch delta: the byte-range edits to apply to a
/// single scene's decompiled bytecode before re-compression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusScenePatchDelta {
    /// `SceneList` scene id this delta edits.
    pub scene_id: u32,
    /// Replacement-text edits keyed by canonical source-unit key.
    pub unit_edits: Vec<(String, String)>,
}

/// Fatal errors raised by the per-scene delta producer.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusDeltaError {
    /// The delta producer is not implemented in the skeleton.
    #[error(
        "kaifuu.siglus.patchback.delta.not_implemented: per-scene patch-delta producer is a \
         siglus-05 skeleton stub; the real unit-edit byte-range math lands against real bytes \
         downstream"
    )]
    NotImplemented,
}

/// Compute the per-scene patch delta for a single scene's decompiled
/// bytecode given its translated unit edits.
/// Skeleton: always returns [`SiglusDeltaError::NotImplemented`].
pub fn produce_scene_delta(
    _scene_id: u32,
    _decompressed_bytecode: &[u8],
    _unit_edits: &[(String, String)],
) -> Result<SiglusScenePatchDelta, SiglusDeltaError> {
    Err(SiglusDeltaError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_delta_returns_typed_not_implemented_not_fake_delta() {
        let err = produce_scene_delta(1, &[0u8; 8], &[])
            .expect_err("skeleton must not fabricate a scene delta");
        assert!(matches!(err, SiglusDeltaError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
