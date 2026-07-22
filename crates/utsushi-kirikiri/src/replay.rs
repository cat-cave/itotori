//! KAG plaintext REPLAY engine + typed trace.
//!
//! [`replay_kag`] walks a [`KagScript`] instruction stream like a tiny VM
//! tracking the active speaker (`#name` state), emitting message text, and
//! following jumps + choices, producing a deterministic [`KagTrace`]. It is
//! the Utsushi-side analogue of `utsushi-reallive::replay_scene`: same
//! trace/observe shape (typed events + a byte-deterministic JSON surface
//! with sorted keys and no floats), same fail-soft-with-typed-diagnostics
//! posture (an unsupported command records a semantic diagnostic and
//! advances; it never panics and never silently skips).
//!
//! ## Honest scope ( macro + storage subset)
//!
//! This is a plaintext KAG REPLAY *skeleton*. It replays the structural
//! flow — message text, name state, choices, jumps — of a `.ks` script that
//! is ALREADY plaintext on disk, plus a BOUNDED subset of macro expansion
//! (handled in [`crate::parse`]) and storage variables:
//!
//! - **Storage variables (bounded subset).** `[eval exp="f.x = …"]` performs a
//!   SIMPLE assignment to an `f.` (game flag) or `sf.` (system flag) variable
//!   whose right-hand side is an integer literal, a quoted string literal
//!   another already-bound `f.`/`sf.` variable (a copy), or a single spaced
//!   `A + B` / `A - B` over integer operands (so `f.count = f.count + 1`
//!   counters work). `[emb exp="f.x"]` reads a single already-bound variable
//!   and records its value. Variable state is visible as
//!   [`KagEvent::VariableSet`] / [`KagEvent::EmbeddedValue`] events and in the
//!   final [`KagTrace::variables`] snapshot.
//! - **Everything else is a typed diagnostic, never faked.** Any `[eval]`
//!   `[emb]` expression outside that subset (multiplication, comparisons
//!   function/method calls, string concatenation, multi-statement, a
//!   non-`f.`/`sf.` target) is an `unsupported_tjs_expression`; a read/copy of
//!   an UNBOUND variable is an `unresolved_variable`; `[if]` conditionals
//!   `[iscript]` blocks, and out-of-subset macros surface as their own typed
//!   diagnostics. It does NOT open or decrypt XP3 containers. Every
//!   unsupported construct is a [`KagDiagnostic`], so the boundary is visible
//!   in the trace, not hidden. See [`crate::capability_note`].

use std::collections::BTreeMap;

use serde::Serialize;

use crate::parse::{BlockKind, Command, Instr, KagScript};

#[path = "replay/model.rs"]
mod model;
pub use model::*;

/// Recursively rebuild a serde value with object keys sorted, so the pretty
/// printer emits a byte-stable ordering regardless of struct field order.
pub(crate) fn to_sorted_value<T: Serialize>(value: &T) -> Result<serde_json::Value, KagTraceError> {
    let raw = serde_json::to_value(value).map_err(|e| KagTraceError::Serialize(e.to_string()))?;
    Ok(sort_value(raw))
}

fn sort_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<(String, serde_json::Value)> =
                map.into_iter().map(|(k, v)| (k, sort_value(v))).collect();
            entries.sort_by(|(a, _), (b, _)| a.cmp(b));
            let mut sorted = serde_json::Map::with_capacity(entries.len());
            for (k, v) in entries {
                sorted.insert(k, v);
            }
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(sort_value).collect())
        }
        other => other,
    }
}

#[path = "replay/helpers.rs"]
mod helpers;
use helpers::*;

#[path = "replay/engine.rs"]
mod engine;
pub use engine::*;
