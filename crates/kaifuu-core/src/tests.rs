use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

mod encrypted_media_proof;
mod helper_launch_toctou;

mod identity_or_null_key;

include!("tests/root_01_contract_and_xp3_inventory.rs");
include!("tests/root_02_plain_xp3_writer.rs");
include!("tests/root_03_golden_inventory_support.rs");
include!("tests/root_04_golden_and_archive_detection.rs");
include!("tests/root_05_archive_detection_engines.rs");
include!("tests/root_06_detection_redaction_and_paths.rs");
include!("tests/root_07_helper_registry_boundary.rs");
include!("tests/root_08_helper_keys_and_siglus.rs");
include!("tests/root_09_helper_results_and_encrypted_matrix.rs");
include!("tests/root_10_rpgmaker_keys_and_helper_contract.rs");
include!("tests/root_11_key_resolvers_and_secret_store.rs");
include!("tests/root_12_secret_store_and_profile_policy.rs");
include!("tests/root_13_redaction_and_key_preflight.rs");
include!("tests/root_14_layered_access_and_inventory.rs");
include!("tests/root_15_asset_and_bridge_contracts.rs");
include!("tests/root_16_contract_fixtures_and_serialization.rs");
include!("tests/root_17_inventory_and_xp3_profile.rs");
include!("tests/root_18_xp3_profile_diagnostics.rs");
