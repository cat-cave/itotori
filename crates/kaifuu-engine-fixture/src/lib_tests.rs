use super::*;
use kaifuu_core::{
    Capability, GoldenAssertionStatus, GoldenByteEquivalenceMode, GoldenHarnessRequest,
    PatchExport, ProtectedSpanMapping, XP3_PLAIN_MAGIC, read_json, run_round_trip_golden,
    sha256_hash_bytes, stable_json,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[path = "lib_tests_support.rs"]
mod support;
use support::*;

#[path = "lib_tests_reallive_support.rs"]
mod reallive_support;
use reallive_support::*;

#[path = "lib_tests_fixture_markup.rs"]
mod fixture_markup;

#[path = "lib_tests_fixture_round_trip.rs"]
mod fixture_round_trip;

#[path = "lib_tests_fixture_golden.rs"]
mod fixture_golden;

#[path = "lib_tests_fixture_protected_spans.rs"]
mod fixture_protected_spans;

#[path = "lib_tests_fixture_contracts.rs"]
mod fixture_contracts;

#[path = "lib_tests_softpal.rs"]
mod softpal;

#[path = "lib_tests_xp3.rs"]
mod xp3;

#[path = "lib_tests_siglus.rs"]
mod siglus;

#[path = "lib_tests_reallive_detection.rs"]
mod reallive_detection;

#[path = "lib_tests_reallive_contracts.rs"]
mod reallive_contracts;

#[path = "lib_tests_reallive_extract.rs"]
mod reallive_extract;

#[path = "lib_tests_reallive_patch.rs"]
mod reallive_patch;

#[path = "lib_tests_asset_inventory.rs"]
mod asset_inventory;
