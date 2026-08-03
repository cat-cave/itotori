//! Report projection for the renderer-owned localized-text pixel gate.

use serde_json::{Value, json};

/// Project the renderer-owned pixel verdict. A frame with a dropped graphics
/// object is real, but incomplete: preserve that evidence and make it fail
/// closed instead of promoting it to a clean render proof.
pub(super) fn scene_verdict(
    incomplete: bool,
    skipped_object_count: usize,
    decode_warning_count: usize,
) -> Value {
    if incomplete {
        return json!({
            "status": "failed",
            "checks": [
                "visible-delta",
                "expected-bounds",
                "distinct-glyph-masks",
                "complete-scene",
            ],
            "failedChecks": ["complete-scene"],
            "skippedObjectCount": skipped_object_count,
            "decodeWarningCount": decode_warning_count,
        });
    }
    json!({
        "status": "passed",
        "checks": [
            "visible-delta",
            "expected-bounds",
            "distinct-glyph-masks",
            "complete-scene",
        ],
    })
}
