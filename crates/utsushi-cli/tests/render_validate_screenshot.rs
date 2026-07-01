//! ALPHA-006b — the `render-validate` screenshot real-bytes test lived here.
//!
//! It was a hollow planted-sentinel proof: it patched the all-binary
//! bootstrap scene 1 with a HARD-CODED en-US sentinel and then asserted the
//! rendered text layer echoed that same planted string (its "negative
//! control" likewise depended on the planted sentinel). Writing a string and
//! reading it back proves nothing about real rendering, and on real bytes it
//! failed outright (`NoTextUnits { scene_id: 1 }` — scene 1 surfaces no
//! translatable units).
//!
// Hollow planted-sentinel proof removed; real replay/render evidence is delivered by the utsushi-real-runtime-evidence-no-sentinel node.
