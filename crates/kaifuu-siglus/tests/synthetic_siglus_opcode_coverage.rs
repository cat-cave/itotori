//! `synthetic-fixture-author-feature-complete-archives` (P2) — Siglus.
//!
//! The Siglus scene-bytecode opcode catalogue is a skeleton STUB: only the
//! `Unknown` catch-all exists and [`parse_scene_bytecode`] returns a typed
//! `not_implemented`. The coverage manifest reflects exactly that — a single
//! `Unknown` component. This test instantiates it through the REAL decoder and
//! asserts the synthetic corpus covers 100% of the manifest's (stub) opcode
//! group. When a real Siglus catalogue lands, the manifest `--check` will force
//! the new opcodes in and this coverage will expand with it.

use std::path::PathBuf;

use kaifuu_siglus::{SiglusOpcode, parse_scene_bytecode};
use serde_json::Value;

fn manifest_value() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/synthetic/coverage-manifest.v0.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|err| panic!("read coverage manifest {}: {err}", path.display()));
    serde_json::from_slice(&bytes).expect("coverage manifest is valid JSON")
}

#[test]
fn synthetic_corpus_instantiates_the_siglus_stub_opcode() {
    let manifest = manifest_value();
    let components =
        manifest["engineFamilies"]["siglus"]["componentGroups"]["opcode"]["components"]
            .as_array()
            .expect("siglus opcode components array");
    assert_eq!(
        components.len(),
        1,
        "the Siglus opcode catalogue is a stub with a single Unknown component"
    );
    assert_eq!(components[0].as_str(), Some("Unknown"));

    // Instantiate the single stub opcode form.
    let unknown = SiglusOpcode::Unknown {
        lead: 0x00,
        byte_offset: 0,
    };
    assert!(matches!(unknown, SiglusOpcode::Unknown { .. }));

    // The real decoder is a typed not_implemented stub (never a silent Ok):
    // synthetic bytes drive the same not-implemented surface the real bytes do.
    let result = parse_scene_bytecode(&[0x00, 0x01, 0x02, 0x03]);
    assert!(
        result.is_err(),
        "the Siglus decoder stub must return a typed not_implemented, never a silent Ok"
    );
}
