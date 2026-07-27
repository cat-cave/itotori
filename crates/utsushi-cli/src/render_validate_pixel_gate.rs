//! Report projection for the renderer-owned localized-text pixel gate.

use serde_json::{Value, json};

/// The caller reaches this only after `emit_scene_screenshots` accepted the
/// post-blend glyph pixels. Keep selection/decode evidence separate from this
/// raster verdict.
pub(super) fn passed() -> Value {
    json!({
        "status": "passed",
        "checks": ["visible-delta", "expected-bounds", "distinct-glyph-masks"],
    })
}
