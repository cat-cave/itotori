use std::path::Path;

use engine_contract::{
    ReceiptDiagnosticCode, ReceiptDocument, ReceiptProofState, RequirementState, RunnerState,
    parse_catalog, parse_inventory, parse_lane, parse_plan, parse_receipt,
};

fn fixture(path: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(path),
    )
    .expect("committed fixture must be readable")
}

#[test]
fn fixture_contract_parsers_preserve_declared_receipt_states() {
    let catalog = parse_catalog(&fixture("valid/catalog.toml")).expect("catalog fixture parses");
    let inventory =
        parse_inventory(&fixture("valid/inventory.toml")).expect("inventory fixture parses");
    let lane = parse_lane(&fixture("valid/lane.toml")).expect("lane fixture parses");
    let plan = parse_plan(&fixture("valid/plan.json")).expect("plan fixture parses");

    assert_eq!(catalog.id, "engine-alpha");
    assert_eq!(inventory.corpus.len(), 2);
    assert_eq!(lane.id, "lane-strict");
    assert_eq!(plan.proofs[0].corpora, ["corpus-01", "corpus-02"]);

    let selected = parsed_receipt("valid/receipt-selected.json");
    assert_eq!(selected.proofs[0].state, ReceiptProofState::Selected);
    assert_eq!(selected.counts.executed, 0);
    assert_eq!(
        selected.diagnostics[0].code,
        ReceiptDiagnosticCode::SelectedProofUnexecuted
    );

    let zero_assertions = parsed_receipt("valid/receipt-zero-assertions.json");
    assert_eq!(zero_assertions.proofs[0].state, ReceiptProofState::Executed);
    assert_eq!(zero_assertions.proofs[0].assertion_count, Some(0));
    assert_eq!(
        zero_assertions.diagnostics[0].code,
        ReceiptDiagnosticCode::ExecutedProofProducedNoAssertions
    );

    let absent_input = parse_plan(&fixture("valid/plan-required-input-absent.json"))
        .expect("absent-input plan fixture parses");
    assert_eq!(absent_input.requirements[0].state, RequirementState::Absent);
    assert_eq!(
        absent_input.requirements[0].diagnostic.as_deref(),
        Some("required-input-absent")
    );

    let unavailable = parsed_receipt("valid/receipt-runner-unavailable.json");
    assert_eq!(unavailable.runner.state, RunnerState::Unavailable);
    assert_eq!(
        unavailable.diagnostics[0].code,
        ReceiptDiagnosticCode::RunnerUnavailable
    );

    let zero_step = parsed_receipt("valid/receipt-zero-step.json");
    assert_eq!(zero_step.runner.state, RunnerState::Available);
    assert_eq!(zero_step.runner.job_steps, Some(0));
    assert_eq!(
        zero_step.diagnostics[0].code,
        ReceiptDiagnosticCode::RunnerZeroStepJob
    );

    assert!(matches!(
        parse_receipt(None).expect("missing receipt is a distinct state"),
        ReceiptDocument::Missing
    ));
}

#[test]
fn fixture_contract_parsers_reject_malformed_documents() {
    for path in [
        "invalid/catalog-malformed.toml",
        "invalid/inventory-malformed.toml",
        "invalid/lane-malformed.toml",
    ] {
        let result = match path {
            "invalid/catalog-malformed.toml" => parse_catalog(&fixture(path)).map(|_| ()),
            "invalid/inventory-malformed.toml" => parse_inventory(&fixture(path)).map(|_| ()),
            "invalid/lane-malformed.toml" => parse_lane(&fixture(path)).map(|_| ()),
            _ => unreachable!("fixed fixture paths"),
        };
        assert!(result.is_err(), "{path} must be rejected");
    }
    for path in [
        "invalid/plan-malformed.fixture",
        "invalid/receipt-malformed.fixture",
    ] {
        let result = if path == "invalid/plan-malformed.fixture" {
            parse_plan(&fixture(path)).map(|_| ())
        } else {
            parse_receipt(Some(&fixture(path))).map(|_| ())
        };
        assert!(result.is_err(), "{path} must be rejected");
    }
}

#[test]
fn fixture_contract_parsers_reject_missing_required_fields() {
    for path in [
        "invalid/catalog-missing-id.toml",
        "invalid/inventory-missing-root.toml",
        "invalid/lane-missing-receipt.toml",
    ] {
        let result = match path {
            "invalid/catalog-missing-id.toml" => parse_catalog(&fixture(path)).map(|_| ()),
            "invalid/inventory-missing-root.toml" => parse_inventory(&fixture(path)).map(|_| ()),
            "invalid/lane-missing-receipt.toml" => parse_lane(&fixture(path)).map(|_| ()),
            _ => unreachable!("fixed fixture paths"),
        };
        assert!(result.is_err(), "{path} must be rejected");
    }
    for path in [
        "invalid/plan-missing-lane.json",
        "invalid/receipt-missing-counts.json",
    ] {
        let result = if path == "invalid/plan-missing-lane.json" {
            parse_plan(&fixture(path)).map(|_| ())
        } else {
            parse_receipt(Some(&fixture(path))).map(|_| ())
        };
        assert!(result.is_err(), "{path} must be rejected");
    }
}

#[test]
fn fixture_documents_conform_to_committed_schema_artifacts() {
    let catalog = parse_catalog(&fixture("valid/catalog.toml")).expect("catalog fixture parses");
    let inventory =
        parse_inventory(&fixture("valid/inventory.toml")).expect("inventory fixture parses");
    let lane = parse_lane(&fixture("valid/lane.toml")).expect("lane fixture parses");
    let plan = parse_plan(&fixture("valid/plan.json")).expect("plan fixture parses");
    let absent_input = parse_plan(&fixture("valid/plan-required-input-absent.json"))
        .expect("absent-input plan fixture parses");

    assert_schema_accepts("catalog-v1.schema.json", &catalog);
    assert_schema_accepts("inventory-v1.schema.json", &inventory);
    assert_schema_accepts("lane-v1.schema.json", &lane);
    assert_schema_accepts("plan-v1.schema.json", &plan);
    assert_schema_accepts("plan-v1.schema.json", &absent_input);
    for path in [
        "valid/receipt-selected.json",
        "valid/receipt-zero-assertions.json",
        "valid/receipt-runner-unavailable.json",
        "valid/receipt-zero-step.json",
    ] {
        assert_schema_accepts("receipt-v1.schema.json", &parsed_receipt(path));
    }
}

fn parsed_receipt(path: &str) -> engine_contract::Receipt {
    match parse_receipt(Some(&fixture(path))).expect("receipt fixture parses") {
        ReceiptDocument::Present(receipt) => receipt,
        ReceiptDocument::Missing => panic!("fixture supplied a receipt document"),
    }
}

fn assert_schema_accepts(schema_name: &str, value: &impl serde::Serialize) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let schema_path = root.join("catalog/schema").join(schema_name);
    let schema =
        serde_json::from_str(&std::fs::read_to_string(schema_path).expect("schema exists"))
            .expect("schema is JSON");
    let validator = jsonschema::draft202012::new(&schema).expect("schema compiles");
    let instance = serde_json::to_value(value).expect("fixture serializes to JSON");
    assert!(
        validator.is_valid(&instance),
        "{schema_name} rejects fixture: {instance}"
    );
}
