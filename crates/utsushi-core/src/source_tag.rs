use serde::{Deserialize, Serialize};

/// Engine-family-neutral source tag for a recorded run.
///
/// Never a host path. Never a host or engine binary version. New engine
/// ports (browser / native / Wine) plug in by selecting an existing tag;
/// enrichment (e.g. `BrowserChromium`, `WineProton`) is out of scope here
/// and is a schema_version bump when it lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceTag {
    /// In-browser embed (WASM / JS host).
    Browser,
    /// Native engine binary running on the host OS.
    Native,
    /// Native engine binary running through Wine.
    Wine,
    /// Deterministic fixture runtime. The only producer in this slice.
    Fixture,
}
