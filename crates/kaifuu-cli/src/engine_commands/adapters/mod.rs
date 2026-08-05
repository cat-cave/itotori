//! Registry of the engine-owned top-level command handlers.
//!
//! This directory is the extension point for a new engine: add an adapter
//! wrapper and its registration here. The shared process dispatcher does not
//! acquire an engine branch or an engine-specific flag.

mod reallive;
mod rpgmaker;
mod siglus;
mod softpal;

use super::EngineCommandHandler;

struct EngineCommandAdapter {
    engine_ids: &'static [&'static str],
    verbs: &'static [&'static str],
    handler: EngineCommandHandler,
}

const ADAPTERS: &[EngineCommandAdapter] = &[
    EngineCommandAdapter {
        engine_ids: &["reallive"],
        verbs: &["extract", "patch"],
        handler: reallive::run,
    },
    EngineCommandAdapter {
        engine_ids: &["rpgmaker", "rpg-maker"],
        verbs: &["extract", "patch"],
        handler: rpgmaker::run,
    },
    EngineCommandAdapter {
        engine_ids: &["siglus"],
        verbs: &["extract", "patch"],
        handler: siglus::run,
    },
    EngineCommandAdapter {
        engine_ids: &["softpal"],
        verbs: &["extract", "patch", "verify"],
        handler: softpal::run,
    },
];

pub(super) fn handler_for(engine: &str, verb: &str) -> Option<EngineCommandHandler> {
    ADAPTERS
        .iter()
        .find(|adapter| adapter.engine_ids.contains(&engine) && adapter.verbs.contains(&verb))
        .map(|adapter| adapter.handler)
}
