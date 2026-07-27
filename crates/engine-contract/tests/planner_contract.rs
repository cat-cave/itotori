use std::fmt::{Display, Formatter};
use std::path::Path;

use engine_contract::{
    Catalog, EnginePlugin, Inventory, Lane, PluginExecutionError, PluginRequest, PluginResponse,
    ReceiptValidationError, compile_plan, execute_plan, parse_catalog, parse_inventory, parse_lane,
};

const FIXTURE_ROOT: &str = "tests/fixtures/planner";

#[derive(Debug)]
struct FixturePlugin {
    response: PluginResponse,
}

#[derive(Debug)]
struct FixturePluginError;

impl Display for FixturePluginError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("fixture plugin error")
    }
}

impl std::error::Error for FixturePluginError {}

impl EnginePlugin for FixturePlugin {
    type Error = FixturePluginError;

    fn execute(&mut self, request: &PluginRequest) -> Result<PluginResponse, Self::Error> {
        assert_eq!(request.engine, "engine-fixture");
        assert_eq!(request.executor.command, "prove");
        assert_eq!(request.corpora.len(), 2);
        assert!(
            request
                .corpora
                .iter()
                .all(|corpus| corpus.root.starts_with("/private/"))
        );
        Ok(self.response.clone())
    }
}

#[test]
fn descriptor_driven_plan_selects_and_executes_one_strict_proof() {
    let (catalog, lane, inventory) = strict_fixture();
    let declared_ids = catalog
        .proof
        .iter()
        .filter(|proof| proof.lane == lane.id)
        .map(|proof| proof.id.as_str())
        .collect::<Vec<_>>();
    let plan = compile_plan(
        std::slice::from_ref(&catalog),
        std::slice::from_ref(&lane),
        &inventory,
        &lane,
        "plan-fixture",
    )
    .expect("fixture descriptor must select its strict proof");
    let selected_ids = plan
        .proofs
        .iter()
        .map(|proof| proof.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(selected_ids, declared_ids);
    let mut plugin = FixturePlugin {
        response: response("strict/plugin-response.json"),
    };

    let receipt = execute_plan(&plan, &inventory, &mut plugin, "run-fixture")
        .expect("fixture plugin must execute the selected proof");

    let executed_ids = receipt
        .proofs
        .iter()
        .filter(|proof| proof.state == engine_contract::ReceiptProofState::Executed)
        .map(|proof| proof.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(executed_ids, selected_ids);
    assert_eq!(executed_ids, ["proof-two-corpora"]);
    assert_eq!(receipt.counts.executed, 1);
}

#[test]
fn fixture_diagnostics_distinguish_missing_empty_skipped_and_zero_execution() {
    let (catalog, lane, inventory) = strict_fixture();
    let missing_inventory = inventory_fixture("diagnostics/missing-corpus-inventory.toml");
    let missing = compile_plan(
        std::slice::from_ref(&catalog),
        std::slice::from_ref(&lane),
        &missing_inventory,
        &lane,
        "plan-fixture",
    )
    .expect_err("one corpus cannot satisfy the two-corpus proof");
    assert_eq!(
        missing.to_string(),
        "required corpus selection is unsatisfied for proof `proof-two-corpora`: need 2, found 1"
    );

    let empty_lane = lane_fixture("diagnostics/empty-selection-lane.toml");
    let empty = compile_plan(
        std::slice::from_ref(&catalog),
        &[lane.clone(), empty_lane.clone()],
        &inventory,
        &empty_lane,
        "plan-fixture",
    )
    .expect_err("the fixture lane declares no proof");
    assert_eq!(empty.to_string(), "lane `lane-empty` selected no proofs");

    let plan = compile_plan(
        &[catalog],
        std::slice::from_ref(&lane),
        &inventory,
        &lane,
        "plan-fixture",
    )
    .expect("strict fixture plan compiles");
    let mut skipped_plugin = FixturePlugin {
        response: response("diagnostics/skipped-plugin-response.json"),
    };
    let skipped = execute_plan(&plan, &inventory, &mut skipped_plugin, "run-fixture")
        .expect_err("a selected proof cannot be skipped");
    assert_eq!(
        skipped,
        PluginExecutionError::InvalidReceipt(ReceiptValidationError::SkippedProof(
            "proof-two-corpora".to_owned()
        ))
    );
    assert_eq!(
        skipped.to_string(),
        "selected proof `proof-two-corpora` was skipped"
    );

    let mut zero_plugin = FixturePlugin {
        response: response("diagnostics/zero-execution-plugin-response.json"),
    };
    let zero = execute_plan(&plan, &inventory, &mut zero_plugin, "run-fixture")
        .expect_err("a plugin must return an executed receipt entry");
    assert_eq!(
        zero,
        PluginExecutionError::ZeroExecution("proof-two-corpora".to_owned())
    );
    assert_eq!(
        zero.to_string(),
        "plugin returned zero executed receipt entries for selected proof `proof-two-corpora`"
    );
}

fn strict_fixture() -> (Catalog, Lane, Inventory) {
    (
        catalog_fixture("strict/catalog.toml"),
        lane_fixture("strict/lane.toml"),
        inventory_fixture("strict/inventory.toml"),
    )
}

fn catalog_fixture(path: &str) -> Catalog {
    parse_catalog(&fixture(path)).expect("catalog fixture must parse")
}

fn lane_fixture(path: &str) -> Lane {
    parse_lane(&fixture(path)).expect("lane fixture must parse")
}

fn inventory_fixture(path: &str) -> Inventory {
    parse_inventory(&fixture(path)).expect("inventory fixture must parse")
}

fn response(path: &str) -> PluginResponse {
    serde_json::from_str(&fixture(path)).expect("plugin response fixture must parse")
}

fn fixture(path: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(FIXTURE_ROOT)
            .join(path),
    )
    .expect("committed fixture must be readable")
}
