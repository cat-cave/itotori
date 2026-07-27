use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use engine_contract::{CapabilityClaim, parse_catalog};
use kaifuu_core::CapabilityStatus;

fn descriptor_id(adapter_id: &str) -> &str {
    match adapter_id {
        "kaifuu.bgi" => "engine-bgi",
        "kaifuu.fixture" => "engine-fixture",
        "kaifuu.kirikiri_xp3" => "engine-kirikiri-xp3",
        "kaifuu.nexas" => "engine-nexas",
        "kaifuu.reallive" => "engine-reallive",
        "kaifuu.siglus" => "engine-siglus",
        "kaifuu.softpal" => "engine-softpal",
        _ => panic!("registered adapter has no descriptor mapping: {adapter_id}"),
    }
}

fn descriptor_capabilities(id: &str) -> BTreeMap<String, CapabilityClaim> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let path = root.join("catalog/engines").join(id).join("engine.toml");
    parse_catalog(&fs::read_to_string(&path).expect("descriptor must be readable"))
        .unwrap_or_else(|error| panic!("{} must parse: {error}", path.display()))
        .capabilities
}

fn descriptor_claim(status: CapabilityStatus) -> CapabilityClaim {
    match status {
        CapabilityStatus::Supported => CapabilityClaim::Supported,
        CapabilityStatus::Limited | CapabilityStatus::RequiresUserInput => CapabilityClaim::Partial,
        CapabilityStatus::Unsupported => CapabilityClaim::NotClaimed,
    }
}

fn separately_claimed_capabilities(adapter_id: &str) -> &[&str] {
    match adapter_id {
        "kaifuu.kirikiri_xp3" => &["plain_archive_extract", "plain_archive_patch"],
        "kaifuu.siglus" => &["known_key_parser_extract", "known_key_parser_helper"],
        _ => &[],
    }
}

#[test]
fn descriptor_projection_matches_live_registered_adapter_capabilities() {
    let registry = kaifuu_engine_fixture::registry();
    assert_eq!(
        registry.adapters().len(),
        7,
        "unexpected registered adapter count"
    );

    for adapter in registry.adapters() {
        let actual = adapter
            .capabilities()
            .reports
            .into_iter()
            .map(|report| {
                let capability = serde_json::to_value(report.capability)
                    .expect("capability serializes")
                    .as_str()
                    .expect("capability serializes as a string")
                    .to_owned();
                (capability, descriptor_claim(report.status))
            })
            .collect::<BTreeMap<_, _>>();
        let descriptor = descriptor_capabilities(descriptor_id(adapter.id()));
        let adapter_projection = descriptor
            .iter()
            .filter(|(capability, _)| actual.contains_key(*capability))
            .map(|(capability, claim)| (capability.clone(), *claim))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            adapter_projection,
            actual,
            "descriptor differs from live claims for {}",
            adapter.id()
        );
        let additional = descriptor
            .keys()
            .filter(|capability| !actual.contains_key(*capability))
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert_eq!(
            additional,
            separately_claimed_capabilities(adapter.id()),
            "descriptor has undeclared additional claims for {}",
            adapter.id()
        );
    }
}
