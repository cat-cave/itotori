//! Render-outcome report types for the headless render pipeline.
//!
//! Extracted from the parent [`crate::render_pipeline`] module so the
//! compositing skip-reason / skipped-object / decode-warning records, the
//! structural [`RenderReport`], and the emit-result [`SceneScreenshots`]
//! live in their own ≤500-line child. Public items are re-exported from
//! the parent to keep the crate API path unchanged.

use std::path::PathBuf;

use crate::g00::G00Warning;
use crate::graphics_objects::GraphicsPlane;
use utsushi_core::substrate::FrameArtifact;

use super::RedactionPolicy;

/// Why a graphics object contributed NO pixels during compositing.
///
/// Every variant corresponds to one fail-soft branch in
/// [`RenderPass::paint_image`]. The compositor keeps rendering the rest
/// of the stack, but the skip is recorded (never silently dropped) so a
/// consumer can tell an incomplete frame from a complete render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    /// No [`AssetPackage`] is bound, so the image ref cannot be
    /// dereferenced at all.
    NoAssetPackage,
    /// The asset package failed to resolve the logical `g00/<key>.g00`
    /// path to an asset id.
    ResolveFailed {
        /// The logical path that failed to resolve.
        logical: String,
        /// Display of the underlying resolve error.
        error: String,
    },
    /// The asset id resolved but the package failed to open its bytes.
    OpenFailed {
        /// The logical path whose bytes failed to open.
        logical: String,
        /// Display of the underlying open error.
        error: String,
    },
    /// [`decode_g00`] returned a hard error on the real bytes (e.g. the
    /// `BACK.g00` decoder bug). This is the branch that would
    /// otherwise silently drop the dominant scene background.
    DecodeFailed {
        /// Display of the g00 decode error.
        error: String,
    },
    /// The decoded image, or its scaled destination rect, had a zero
    /// dimension, so there was no extent to composite.
    ZeroDims {
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
    },
}

/// A single graphics object that was skipped (dropped, contributing no
/// pixels) during compositing, plus enough detail to be audit-traceable
/// back to the exact object and fail-soft branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedObject {
    /// The image object's asset key (g00 stem, e.g. `BACK`).
    pub asset_key: String,
    /// Plane the skipped object lived on.
    pub plane: GraphicsPlane,
    /// Slot within the plane.
    pub slot: usize,
    /// Why the object was skipped.
    pub reason: SkipReason,
}

/// A non-fatal [`G00Warning`] surfaced while decoding an object's g00
/// asset, tagged with the asset key it came from. These were previously
/// discarded (the `_warnings` binding); they are now carried up to the
/// render result so corpus-level audit can see them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectWarning {
    /// The image object's asset key (g00 stem) the warning came from.
    pub asset_key: String,
    /// The decode warning.
    pub warning: G00Warning,
}

/// Structural record of everything the compositor could NOT fully render
/// while rasterising a stack: the objects it skipped (with reasons) and
/// the non-fatal decode warnings it observed. An empty [`Self::is_empty`]
/// report means the frame is a COMPLETE render of the stack; a non-empty
/// skip list means at least one object was dropped and the frame is
/// incomplete. This is what keeps a render artifact from looking complete
/// when it is not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RenderReport {
    /// Objects that contributed no pixels, with the reason for each.
    pub skipped_objects: Vec<SkippedObject>,
    /// Non-fatal g00 decode warnings observed, tagged by asset key.
    pub warnings: Vec<ObjectWarning>,
}

impl RenderReport {
    /// True when nothing was skipped and no decode warning fired — the
    /// frame is a complete render of the stack.
    pub fn is_empty(&self) -> bool {
        self.skipped_objects.is_empty() && self.warnings.is_empty()
    }

    /// True when at least one object was DROPPED (contributed no pixels)
    /// so the rendered frame is incomplete regardless of warnings.
    pub fn is_incomplete(&self) -> bool {
        !self.skipped_objects.is_empty()
    }
}

/// Outcome of [`RenderPass::emit_scene_screenshots`]: the public
/// (policy-selected) frame artifact plus the private full-fidelity PNG's
/// on-disk path and content hash.
#[derive(Debug, Clone)]
pub struct SceneScreenshots {
    /// The public frame announced through the substrate sink at E2.
    pub public: FrameArtifact,
    /// On-disk path of the uncommitted full-fidelity PNG (pixels
    /// byte-derived from the decoded g00). Hashable and re-readable.
    pub private_png_path: PathBuf,
    /// SHA-256 hex of the private PNG bytes.
    pub private_png_sha256: String,
    /// The redaction policy the PUBLIC frame was rendered under.
    pub redaction: RedactionPolicy,
    /// Objects that were DROPPED while compositing the full-fidelity
    /// buffer (empty for a complete render). A non-empty list means the
    /// emitted frame does NOT contain every object in the scene — e.g. an
    /// un-decodable `BACK.g00` background reports here as
    /// [`SkipReason::DecodeFailed`] instead of silently succeeding. See
    /// [`Self::is_incomplete`].
    pub skipped_objects: Vec<SkippedObject>,
    /// Non-fatal g00 decode warnings observed while compositing the
    /// full-fidelity buffer (previously discarded).
    pub decode_warnings: Vec<ObjectWarning>,
}

impl SceneScreenshots {
    /// True when at least one object was dropped during compositing, so
    /// the emitted frame is NOT a complete render of the scene. A
    /// consumer treats an incomplete frame as a non-final proof artifact.
    pub fn is_incomplete(&self) -> bool {
        !self.skipped_objects.is_empty()
    }
}
