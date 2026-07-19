//! CLI registry wiring for the canonical fixture engine-port adapter.

use std::sync::OnceLock;

use utsushi_core::{EnginePortAdapter, RuntimeAdapterRegistry};
use utsushi_fixture::{BrowserLaunchAdapter, FixtureEnginePort, NwjsLaunchAdapter};

use crate::replay_registry::RealLiveReplayAdapter;

static FIXTURE_ENGINE_PORT_ADAPTER: OnceLock<EnginePortAdapter<FixtureEnginePort>> =
    OnceLock::new();
static BROWSER_LAUNCH_ADAPTER: BrowserLaunchAdapter = BrowserLaunchAdapter::new();
static NWJS_LAUNCH_ADAPTER: NwjsLaunchAdapter = NwjsLaunchAdapter::new();
static REALLIVE_REPLAY_ADAPTER: RealLiveReplayAdapter = RealLiveReplayAdapter::new();

pub(crate) fn runtime_registry() -> RuntimeAdapterRegistry<'static> {
    let mut registry = RuntimeAdapterRegistry::new();
    registry
        .register(FIXTURE_ENGINE_PORT_ADAPTER.get_or_init(|| {
            EnginePortAdapter::new(FixtureEnginePort::new())
                .expect("fixture engine port manifest must be valid")
        }))
        .expect("fixture engine port adapter descriptor is valid");
    registry
        .register(&BROWSER_LAUNCH_ADAPTER)
        .expect("browser launch adapter descriptor is valid");
    registry
        .register(&NWJS_LAUNCH_ADAPTER)
        .expect("NW.js capability diagnostic descriptor is valid");
    registry
        .register(&REALLIVE_REPLAY_ADAPTER)
        .expect("RealLive replay adapter descriptor is valid");
    registry
}
