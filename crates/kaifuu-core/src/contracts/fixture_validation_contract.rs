use super::*;

pub fn validate_contract_fixture_manifest_v02(value: &Value) -> BridgeContractResult<()> {
    let manifest = as_record(value, "ContractFixtureManifestV02")?;
    assert_schema_version(manifest, "ContractFixtureManifestV02")?;
    assert_required_uuid7(manifest, "suiteId", "ContractFixtureManifestV02.suiteId")?;
    assert_required_rfc3339(
        manifest,
        "generatedAt",
        "ContractFixtureManifestV02.generatedAt",
    )?;

    let valid_fixtures = required_array(
        manifest,
        "validFixtures",
        "ContractFixtureManifestV02.validFixtures",
    )?;
    let invalid_fixtures = required_array(
        manifest,
        "invalidFixtures",
        "ContractFixtureManifestV02.invalidFixtures",
    )?;
    let mut paths = HashSet::new();
    let mut valid_kinds = HashSet::new();

    for (index, fixture) in valid_fixtures.iter().enumerate() {
        let label = format!("ContractFixtureManifestV02.validFixtures[{index}]");
        let (kind, path) = validate_contract_fixture_manifest_entry(fixture, &label)?;
        valid_kinds.insert(kind);
        assert_unique_path(&mut paths, &path, &label)?;
    }
    for (index, fixture) in invalid_fixtures.iter().enumerate() {
        let label = format!("ContractFixtureManifestV02.invalidFixtures[{index}]");
        let (_kind, path) = validate_contract_fixture_manifest_entry(fixture, &label)?;
        assert_required_string(
            as_record(fixture, &label)?,
            "expectedSemanticError",
            &format!("{label}.expectedSemanticError"),
        )?;
        assert_unique_path(&mut paths, &path, &label)?;
    }
    assert_exact_string_set(
        &valid_kinds,
        CONTRACT_FIXTURE_KINDS_V02,
        "ContractFixtureManifestV02.validFixtures.kind",
    )
}

pub fn validate_contract_compatibility_report_v02(value: &Value) -> BridgeContractResult<()> {
    let report = as_record(value, "ContractCompatibilityReportV02")?;
    assert_schema_version(report, "ContractCompatibilityReportV02")?;
    assert_required_uuid7(
        report,
        "reportId",
        "ContractCompatibilityReportV02.reportId",
    )?;
    assert_required_rfc3339(
        report,
        "generatedAt",
        "ContractCompatibilityReportV02.generatedAt",
    )?;
    assert_fixture_path_value(
        required(
            report,
            "suiteManifestPath",
            "ContractCompatibilityReportV02.suiteManifestPath",
        )?,
        "ContractCompatibilityReportV02.suiteManifestPath",
    )?;
    assert_required_string(
        report,
        "sourceOfTruth",
        "ContractCompatibilityReportV02.sourceOfTruth",
    )?;
    assert_command_tokens(
        required(
            report,
            "typescriptCommand",
            "ContractCompatibilityReportV02.typescriptCommand",
        )?,
        "ContractCompatibilityReportV02.typescriptCommand",
    )?;
    assert_command_tokens(
        required(
            report,
            "rustCommand",
            "ContractCompatibilityReportV02.rustCommand",
        )?,
        "ContractCompatibilityReportV02.rustCommand",
    )?;
    let overall_status = assert_required_one_of(
        report,
        "overallStatus",
        &["compatible", "incompatible"],
        "ContractCompatibilityReportV02.overallStatus",
    )?;

    let coverage = required_array(
        report,
        "coverage",
        "ContractCompatibilityReportV02.coverage",
    )?;
    let mut covered_kinds = HashSet::new();
    for (index, entry) in coverage.iter().enumerate() {
        let label = format!("ContractCompatibilityReportV02.coverage[{index}]");
        let entry = as_record(entry, &label)?;
        let kind = assert_required_one_of(
            entry,
            "kind",
            CONTRACT_FIXTURE_KINDS_V02,
            &format!("{label}.kind"),
        )?;
        if !covered_kinds.insert(kind.to_string()) {
            return error(format!("{label}.kind must be unique within coverage"));
        }
        assert_required_string(
            entry,
            "typescriptValidator",
            &format!("{label}.typescriptValidator"),
        )?;
        assert_required_string(entry, "rustValidator", &format!("{label}.rustValidator"))?;
        assert_fixture_path_array(
            required(entry, "validFixtures", &format!("{label}.validFixtures"))?,
            &format!("{label}.validFixtures"),
            true,
        )?;
        assert_fixture_path_array(
            required(
                entry,
                "invalidFixtures",
                &format!("{label}.invalidFixtures"),
            )?,
            &format!("{label}.invalidFixtures"),
            false,
        )?;
        let status = assert_required_one_of(
            entry,
            "status",
            &["compatible", "incompatible"],
            &format!("{label}.status"),
        )?;
        if overall_status == "compatible" && status != "compatible" {
            return error(format!(
                "{label}.status must be compatible when overallStatus is compatible"
            ));
        }
    }
    assert_exact_string_set(
        &covered_kinds,
        CONTRACT_FIXTURE_KINDS_V02,
        "ContractCompatibilityReportV02.coverage.kind",
    )?;

    let cross_refs = required_array(
        report,
        "crossContractRefs",
        "ContractCompatibilityReportV02.crossContractRefs",
    )?;
    let mut has_local_user_ref = false;
    for (index, cross_ref) in cross_refs.iter().enumerate() {
        let label = format!("ContractCompatibilityReportV02.crossContractRefs[{index}]");
        let cross_ref = as_record(cross_ref, &label)?;
        let from = assert_required_string(cross_ref, "from", &format!("{label}.from"))?;
        assert_required_string(cross_ref, "to", &format!("{label}.to"))?;
        assert_required_string(cross_ref, "rule", &format!("{label}.rule"))?;
        if from == "./permission-local-user-v0.2.json" {
            has_local_user_ref = true;
        }
    }
    if !has_local_user_ref {
        return error(
            "ContractCompatibilityReportV02.crossContractRefs must document permission-local-user-v0.2.json",
        );
    }
    assert_string_array(
        required(report, "notes", "ContractCompatibilityReportV02.notes")?,
        "ContractCompatibilityReportV02.notes",
    )?;
    Ok(())
}

/// Validate a v0.2 patch-export bundle.
/// # Duplicate protected-span policy
/// A `protectedSpanMappings` entry may be one of two shapes, and the two are
/// deliberately governed by different duplicate rules:
/// - **Legacy (v0.1-shaped) spans** carry only `raw` plus a target byte range
///   and no source identity (`sourceSpanId`/`sourceStartByte`/`sourceEndByte`).
///   These are **compatibility-preserving**: a duplicate `raw` value is
///   ALLOWED. The same protected literal (a variable token, a markup tag, a
///   glossary term) legitimately recurs inside one unit, and the distinct
///   target byte ranges disambiguate the occurrences. Rejecting duplicate raw
///   would drop faithful coverage of repeated tokens and break patches emitted
///   by older exporters that never populated source identity.
/// - **v0.2 source-identity spans** additionally carry a `sourceSpanId`
///   (UUID7). A `sourceSpanId` names exactly one source span, so it is held to
///   a **strict identity requirement**: a duplicate `sourceSpanId` within an
///   entry is an identity collision and is REJECTED with the typed diagnostic
///   `kaifuu.patch_export.duplicate_source_span_identity`. Two identity spans
///   with the SAME `raw` but DISTINCT `sourceSpanId`s stay allowed — that is
///   exactly the reordered/duplicate-raw case source identity exists to carry
///   (see `MIGRATING-0.2.md`).
///   This keeps legacy v0.1 raw-only exports genuinely distinct from v0.2
///   identity-carrying exports: the former preserve duplicates, the latter reject
///   duplicate identities.
fn validate_contract_fixture_manifest_entry(
    value: &Value,
    label: &str,
) -> BridgeContractResult<(String, String)> {
    let entry = as_record(value, label)?;
    let kind = assert_required_one_of(
        entry,
        "kind",
        CONTRACT_FIXTURE_KINDS_V02,
        &format!("{label}.kind"),
    )?;
    let path = assert_required_string(entry, "path", &format!("{label}.path"))?;
    assert_fixture_path(path, &format!("{label}.path"))?;
    assert_required_string(entry, "description", &format!("{label}.description"))?;
    Ok((kind.to_string(), path.to_string()))
}
