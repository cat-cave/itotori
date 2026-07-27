use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use engine_contract::{CapabilityClaim, Catalog, Inventory, parse_catalog, parse_inventory};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn descriptor_paths() -> Vec<PathBuf> {
    let mut paths = fs::read_dir(repo_root().join("catalog/engines"))
        .expect("committed engine catalog directory must be readable")
        .map(|entry| {
            entry
                .expect("catalog entry must be readable")
                .path()
                .join("engine.toml")
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn descriptors() -> Vec<Catalog> {
    descriptor_paths()
        .into_iter()
        .map(|path| {
            parse_catalog(&fs::read_to_string(&path).expect("descriptor must be readable"))
                .unwrap_or_else(|error| panic!("{} must parse: {error}", path.display()))
        })
        .collect()
}

#[test]
fn descriptor_projection_matches_recorded_current_claims() {
    let expected: BTreeMap<String, BTreeMap<String, CapabilityClaim>> = serde_json::from_str(
        &fs::read_to_string(repo_root().join("catalog/parity/current-claimed-projections.json"))
            .expect("recorded current-claim projection must be readable"),
    )
    .expect("recorded current-claim projection must be valid JSON");
    let actual = descriptors()
        .into_iter()
        .map(|descriptor| (descriptor.id, descriptor.capabilities))
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        actual, expected,
        "descriptor projection drifted from current claims"
    );
}

#[test]
fn descriptor_proofs_have_matching_private_inventory_templates() {
    let descriptors = descriptors();
    let catalogs = descriptors
        .iter()
        .map(|catalog| (catalog.id.as_str(), catalog))
        .collect::<BTreeMap<_, _>>();
    let template_dir = repo_root().join("catalog/inventory-templates");
    let templates = fs::read_dir(template_dir)
        .expect("inventory template directory must be readable")
        .map(|entry| {
            let path = entry
                .expect("inventory template entry must be readable")
                .path();
            parse_inventory(&fs::read_to_string(&path).expect("template must be readable"))
                .unwrap_or_else(|error| panic!("{} must parse: {error}", path.display()))
        })
        .collect::<Vec<Inventory>>();

    let template_engines = templates
        .iter()
        .flat_map(|template| template.corpus.iter().map(|corpus| corpus.engine.as_str()))
        .collect::<BTreeSet<_>>();
    for engine in &template_engines {
        assert!(
            catalogs.contains_key(engine),
            "template names unknown {engine}"
        );
    }

    for descriptor in &descriptors {
        for proof in descriptor
            .proof
            .iter()
            .filter(|proof| proof.requires.corpus_count > 0)
        {
            let matches = templates
                .iter()
                .flat_map(|template| &template.corpus)
                .filter(|corpus| {
                    corpus.engine == descriptor.id
                        && proof
                            .requires
                            .tags
                            .iter()
                            .all(|tag| corpus.tags.contains(tag))
                })
                .count();
            assert!(
                matches >= proof.requires.corpus_count as usize,
                "{} needs {} matching inventory records, found {matches}",
                proof.id,
                proof.requires.corpus_count,
            );
        }
    }
}
