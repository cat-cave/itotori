//! `synthetic-fixture-author-feature-complete-archives` (P2) — KiriKiri XP3.
//! XP3 is a CONTAINER-detection surface: it has no translatable scene-bytecode
//! opcode catalogue, so its unique components (per the coverage manifest) are
//! the [`Xp3CapabilityVariant`]s. This test instantiates every one of them and
//! asserts the synthetic corpus covers 100% of the manifest's
//! `capability_variant` group — the enum IS the source of truth the manifest
//! is derived from, so instantiating each variant is the faithful synthetic
//! exercise for this container surface.

use std::collections::BTreeSet;
use std::path::PathBuf;

use kaifuu_core::Xp3CapabilityVariant;
use serde_json::Value;

fn manifest_value() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/synthetic/coverage-manifest.v0.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|err| panic!("read coverage manifest {}: {err}", path.display()));
    serde_json::from_slice(&bytes).expect("coverage manifest is valid JSON")
}

fn pascal_to_snake(name: &str) -> String {
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i != 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[test]
fn synthetic_corpus_instantiates_every_xp3_capability_variant() {
    // Every real variant, instantiated. Exhaustive by construction: if the
    let all = [
        Xp3CapabilityVariant::PlaintextKs,
        Xp3CapabilityVariant::PlainXp3,
        Xp3CapabilityVariant::EncryptedXp3,
        Xp3CapabilityVariant::HelperRequiredXp3,
        Xp3CapabilityVariant::ProtectedExecutable,
        Xp3CapabilityVariant::UniversalDump,
    ];
    let instantiated: BTreeSet<String> = all.iter().map(|v| v.as_str().to_string()).collect();

    let manifest = manifest_value();
    let components = manifest["engineFamilies"]["kirikiri_xp3"]["componentGroups"]
        ["capability_variant"]["components"]
        .as_array()
        .expect("capability_variant components array");
    assert_eq!(
        components.len(),
        6,
        "manifest enumerates 6 XP3 capability variants"
    );

    for component in components {
        let snake = pascal_to_snake(component.as_str().expect("variant name"));
        assert!(
            instantiated.contains(&snake),
            "XP3 capability variant {snake} not instantiated; have {instantiated:?}"
        );
    }
}
