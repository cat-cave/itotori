use std::path::{Path, PathBuf};

mod rpgmaker_encrypted_smoke;
mod selection;

use crate::{
    EncryptedMediaProofFixture, EncryptedMediaProofRequest, LocalSecretDirectoryStore,
    RpgMakerMvMzFixtureKeyValidationRequest, atomic_write_text, encrypted_media_proof,
    extract_scope::parse_extract_scope, flag, flag_optional, positional, read_json,
    validate_rpg_maker_mv_mz_fixture_key, write_json,
};

/// RPG Maker MV/MZ extraction (`extract --engine rpgmaker --game-root <root>
/// --scope <all|unit-set|unit-range> ...`). Wraps [`kaifuu_rpgmaker::extract_game_dir`]: walks the game's
/// `www/data/*.json` surfaces into the v0.2 BridgeBundle and writes the
/// JSON to `--bundle-output`. The adapter accepts either the format's `www/`
/// directory or its parent game root, resolving the `www/` directory locally.
/// Identity metadata mirrors the RealLive flag-shape. An optional `--findings-output` writes a sanitized
/// per-kind finding census (counts only — never source text).
pub(crate) fn run_extract_rpgmaker_bundle(
    args: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_rpgmaker::{BridgeOpts, extract_game_dir};

    reject_legacy_extract_game_dir(args)?;
    let scope = parse_extract_scope(args)?;
    let engine = flag_optional(args, "--engine").unwrap_or("rpgmaker");
    let game_root = PathBuf::from(
        flag_optional(args, "--game-root")
            .ok_or("kaifuu.rpgmaker.extract.game_root_required: --game-root <PATH> required")?,
    );
    let game_dir = resolve_rpgmaker_game_dir(&game_root);
    let game_id = flag(args, "--game-id")?;
    let game_version = flag(args, "--game-version")?;
    let source_profile_id = flag(args, "--source-profile-id")?;
    let source_locale = flag(args, "--source-locale")?;
    let bundle_output = PathBuf::from(flag(args, "--bundle-output")?);

    let opts = BridgeOpts {
        game_id,
        game_version,
        source_profile_id,
        source_locale,
        extractor_name: "kaifuu-rpgmaker",
        extractor_version: "0.1.0",
    };
    let extraction =
        extract_game_dir(&game_dir, &opts).map_err(|err| -> Box<dyn std::error::Error> {
            format!("kaifuu.rpgmaker.extract: {err}").into()
        })?;
    let filtered_bundle =
        selection::filter_bundle_for_scope(&extraction.bundle.json, engine, &scope)?;

    write_json(&bundle_output, &filtered_bundle)?;

    if let Some(findings_output) = flag_optional(args, "--findings-output") {
        let mut by_kind: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for finding in &extraction.findings {
            *by_kind.entry(format!("{:?}", finding.kind)).or_insert(0) += 1;
        }
        let census = serde_json::json!({
            "schema": "kaifuu.rpgmaker.findings-census.v0",
            "total": extraction.findings.len(),
            "byKind": by_kind,
        });
        write_json(&PathBuf::from(findings_output), &census)?;
    }

    eprintln!(
        "kaifuu rpgmaker extract: units={} assets={} findings={}",
        selection::unit_count(&filtered_bundle)?,
        extraction.bundle.bundle.assets.len(),
        extraction.findings.len(),
    );
    Ok(())
}

fn reject_legacy_extract_game_dir(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if flag_optional(args, "--game-dir").is_some() {
        return Err(
            "kaifuu.rpgmaker.extract.legacy_flag: --game-dir is not supported; use --game-root <PATH>"
                .into(),
        );
    }
    Ok(())
}

/// `extract_game_dir` reads the format's `www/data` tree. A project config
/// names the outer source root, so resolve a direct `www/` child only when the
/// supplied root is not already the format data root.
fn resolve_rpgmaker_game_dir(game_root: &Path) -> PathBuf {
    let www = game_root.join("www");
    if game_root.join("data").is_dir() || !www.is_dir() {
        game_root.to_path_buf()
    } else {
        www
    }
}

/// RPG Maker MV/MZ bundle-driven patchback + `.kaifuu` delta producer
/// (`patch --engine rpgmaker --source <www> --bundle <translated.json>
/// --delta-output <delta.kaifuu> --patched-data-output <dir>`).
/// Reads the translated v0.2 bundle, then calls
/// [`kaifuu_rpgmaker::produce_delta_package`]: it byte-surgically patches
/// the source `www/data/*.json` literals into a freshly-materialized
/// `--patched-data-output` tree (StaleSourceHash-gated) and emits the
/// `.kaifuu` delta package to `--delta-output`. The source tree is read
/// only; it is never written.
pub(crate) fn run_patch_rpgmaker_bundle(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_rpgmaker::{PatchbackOpts, TranslatedBundleV02, produce_delta_package};

    let source = PathBuf::from(flag(args, "--source")?);
    let bundle_path = PathBuf::from(flag(args, "--bundle")?);
    let delta_output = PathBuf::from(flag(args, "--delta-output")?);
    let patched_data_output = PathBuf::from(flag(args, "--patched-data-output")?);

    let bundle_value: serde_json::Value = read_json(&bundle_path)?;
    let translated = TranslatedBundleV02::from_json(&bundle_value)
        .map_err(|err| -> Box<dyn std::error::Error> { format!("{err}").into() })?;

    let produced = produce_delta_package(
        &source,
        &translated,
        &PatchbackOpts::rpg_maker_default(),
        &patched_data_output,
    )
    .map_err(|err| -> Box<dyn std::error::Error> { format!("{err}").into() })?;

    kaifuu_core::write_json(&delta_output, &produced.delta)?;

    eprintln!(
        "kaifuu rpgmaker patch: changed_files={}",
        produced.changed_file_count,
    );
    Ok(())
}

/// `kaifuu rpgmaker encrypted-media-proof
/// --fixture <fixture.json> [--output <report.json>]`.
/// Reads an RPG Maker MV/MZ encrypted-media-proof fixture, classifies each
/// declared media asset (encrypted image / audio / video, plaintext,
/// malformed-header, missing-asset, unknown-suffix), validates the
/// `data/System.json` key-profile evidence, and writes a redacted
/// readiness report.
/// Posture: research-only. The command never decrypts encrypted bytes,
/// never persists decrypted media, never claims dialogue extraction or
/// script-patch support based on media-key detection, and never
/// surfaces patch_back / extract capability for any encrypted asset.
/// Exits non-zero when any blocking (P0/P1) diagnostic fires so CI
/// pipelines can gate on the readiness field without re-parsing the
/// JSON.
fn run_rpg_maker_encrypted_media_proof(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = PathBuf::from(flag(args, "--fixture")?);
    let output = flag_optional(args, "--output").map(PathBuf::from);
    let fixture: EncryptedMediaProofFixture = read_json(&fixture_path)?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or("fixture path must have a parent directory")?;
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir,
    })?;
    let redacted = report.redacted_for_report();
    let report_json = redacted.stable_json()?;
    if let Some(output) = output.as_ref() {
        atomic_write_text(output, &report_json)?;
    } else {
        println!("{report_json}");
    }
    if redacted.status == kaifuu_core::OperationStatus::Failed {
        return Err(format!(
            "RPG Maker MV/MZ encrypted-media proof failed: {}",
            redacted
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity.is_blocking())
                .map(|diagnostic| format!("{}:{}", diagnostic.severity.as_str(), diagnostic.code,))
                .collect::<Vec<_>>()
                .join(", ")
        )
        .into());
    }
    Ok(())
}

pub(crate) fn run_rpg_maker_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "readiness-report" => {
            run_rpg_maker_readiness_report(args)?;
        }
        "encrypted-media-proof" => {
            run_rpg_maker_encrypted_media_proof(args)?;
        }
        "encrypted-smoke" => {
            rpgmaker_encrypted_smoke::run_rpg_maker_encrypted_smoke(args)?;
        }
        "validate-fixture-key" => {
            let game_dir = PathBuf::from(flag(args, "--game-dir")?);
            let image_asset = PathBuf::from(flag(args, "--image-asset")?);
            let secret_store = PathBuf::from(flag(args, "--secret-store")?);
            let secret_ref = flag(args, "--secret-ref")?;
            let output = PathBuf::from(flag(args, "--output")?);
            let fixture_id = flag_optional(args, "--fixture-id")
                .unwrap_or("kaifuu-rpg-maker-mv-mz-fixture-key-validation");
            let requirement_id =
                flag_optional(args, "--requirement-id").unwrap_or("rpg-maker-mv-mz-asset-key");
            let resolver =
                kaifuu_core::LocalKeyResolver::new(LocalSecretDirectoryStore::new(&secret_store));
            let report =
                validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
                    fixture_id,
                    game_dir: &game_dir,
                    image_asset_path: &image_asset,
                    requirement_id,
                    secret_ref,
                    resolver: &resolver,
                })
                .redacted_for_report();
            let failed = report.status == kaifuu_core::OperationStatus::Failed;
            atomic_write_text(&output, &report.stable_json()?)?;
            if failed {
                return Err(format!(
                    "RPG Maker MV/MZ key validation failed: {}",
                    report
                        .diagnostics
                        .iter()
                        .map(|diagnostic| format!("{:?}:{}", diagnostic.code, diagnostic.field))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
        }
        _ => {
            return Err(
                "usage: kaifuu rpgmaker <readiness-report|validate-fixture-key|encrypted-media-proof|encrypted-smoke> ...\n  readiness-report --game <dir> [--output <report.json>]\n  validate-fixture-key --game-dir <dir> --image-asset <asset> --secret-store <dir> --secret-ref <local-secret:id> --output <report.json> [--requirement-id <id>] [--fixture-id <id>]\n  encrypted-media-proof --fixture <fixture.json> [--output <report.json>]\n  encrypted-smoke --fixture <fixture-id>\n(alias: kaifuu rpg-maker ...)"
                    .into(),
            );
        }
    }
    Ok(())
}

/// `kaifuu rpg-maker readiness-report --game <dir> [--output <report.json>]`.
/// Scans a private-local owned RPG Maker MV/MZ game directory and emits the
/// REDACTED, aggregate-only readiness report: exactly the six top-level keys
/// `spec`, `assetSuffixHistogram`, `systemJsonHasEncryptionKey`,
/// `mapTextSurfaceCounts`, `helperRequirements`, `aggregateDataHashSha256`.
/// The report carries no project filename, no full path, and no
/// `System.json.encryptionKey` byte string — only histograms, counts, a
/// boolean key-presence flag, fixed helper tokens, and one aggregate data
/// hash. Safe to commit / publish even though the scan ran over private,
/// copyrighted owned bytes. Intended path lane:
/// `fixtures/private-local/<id>` (bodies never vendored).
fn run_rpg_maker_readiness_report(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let game_dir = PathBuf::from(flag(args, "--game")?);
    let report = kaifuu_core::scan_mv_mz_readiness_report(&game_dir)?;
    let json = report.stable_json()?;
    match flag_optional(args, "--output") {
        Some(output) => atomic_write_text(&PathBuf::from(output), &json)?,
        None => println!("{json}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use tempfile::TempDir;

    use super::*;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("test file has a parent"))
            .expect("create fixture directory");
        fs::write(path, contents).expect("write fixture file");
    }

    fn generic_extract_args(
        engine: &str,
        game_root: &Path,
        output: &Path,
        scope: &[&str],
    ) -> Vec<String> {
        let mut args = [
            "extract",
            "--engine",
            engine,
            "--game-root",
            game_root.to_str().expect("UTF-8 temporary root"),
        ]
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
        args.extend(scope.iter().map(|value| (*value).to_owned()));
        args.extend(
            [
                "--game-id",
                "neutral-work",
                "--game-version",
                "1.0",
                "--source-profile-id",
                "neutral-source-profile",
                "--source-locale",
                "ja-JP",
                "--bundle-output",
                output.to_str().expect("UTF-8 temporary output"),
            ]
            .iter()
            .map(|value| (*value).to_owned()),
        );
        args
    }

    fn write_extract_source(root: &Path) {
        let data = root.join("www/data");
        write(
            &data.join("System.json"),
            r#"{
                "gameTitle": "Neutral work",
                "hasEncryptedImages": true,
                "terms": {"basic": [], "params": [], "commands": [], "messages": {}},
                "equipTypes": [],
                "elements": []
            }"#,
        );
        write(
            &data.join("Map001.json"),
            r#"{
                "displayName": "Neutral map",
                "events": [null, {"id": 1, "pages": [{"list": [
                    {"code": 101, "indent": 0, "parameters": ["", 0, 0, 2, ""]},
                    {"code": 401, "indent": 0, "parameters": ["Neutral first line"]},
                    {"code": 401, "indent": 0, "parameters": ["Neutral second line"]},
                    {"code": 0, "indent": 0, "parameters": []}
                ]}]}]
            }"#,
        );
    }

    #[test]
    fn generic_game_root_resolves_a_format_www_child_and_extracts_all() {
        let root = TempDir::new().expect("temporary source root");
        write_extract_source(root.path());
        let output = root.path().join("bridge.json");

        let dispatched = crate::engine_commands::dispatch(&generic_extract_args(
            "rpg-maker",
            root.path(),
            &output,
            &["--scope", "all"],
        ))
        .expect("generic game-root extraction succeeds");
        assert!(
            dispatched,
            "the rpg-maker alias is owned by the adapter registry"
        );

        let bundle: serde_json::Value =
            serde_json::from_slice(&fs::read(output).expect("read bridge output"))
                .expect("bridge output is JSON");
        assert!(
            bundle["units"]
                .as_array()
                .is_some_and(|units| !units.is_empty()),
            "the generic extraction produced text units"
        );
    }

    #[test]
    fn generic_scopes_filter_a_v02_bundle_for_the_canonical_and_alias_engines() {
        let root = TempDir::new().expect("temporary source root");
        write_extract_source(root.path());
        let all_output = root.path().join("all.json");
        crate::engine_commands::dispatch(&generic_extract_args(
            "rpgmaker",
            root.path(),
            &all_output,
            &["--scope", "all"],
        ))
        .expect("all scope succeeds");
        let all_bundle: serde_json::Value =
            serde_json::from_slice(&fs::read(&all_output).expect("read all bundle"))
                .expect("all bundle is JSON");
        kaifuu_core::BridgeBundleV02::validate_json(&all_bundle)
            .expect("all bundle remains v0.2-valid");
        let all_keys = all_bundle["units"]
            .as_array()
            .expect("all bundle units")
            .iter()
            .map(|unit| {
                unit["sourceUnitKey"]
                    .as_str()
                    .expect("stable source unit key")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert!(all_keys.len() >= 3, "fixture exposes several source units");
        assert!(
            all_keys
                .iter()
                .all(|key| key.starts_with("rpgmaker:") && key.contains("#/"))
        );

        let unit_set_output = root.path().join("unit-set.json");
        crate::engine_commands::dispatch(&generic_extract_args(
            "rpgmaker",
            root.path(),
            &unit_set_output,
            &["--scope", "unit-set", "--unit-ids", &all_keys[1]],
        ))
        .expect("canonical engine accepts a source-unit set");
        let unit_set_bundle: serde_json::Value =
            serde_json::from_slice(&fs::read(&unit_set_output).expect("read unit-set bundle"))
                .expect("unit-set bundle is JSON");
        kaifuu_core::BridgeBundleV02::validate_json(&unit_set_bundle)
            .expect("unit-set bundle remains v0.2-valid");
        assert_eq!(
            unit_set_bundle["units"]
                .as_array()
                .expect("unit-set units")
                .iter()
                .map(|unit| unit["sourceUnitKey"].as_str().expect("unit key"))
                .collect::<Vec<_>>(),
            vec![all_keys[1].as_str()]
        );

        let range_output = root.path().join("unit-range.json");
        crate::engine_commands::dispatch(&generic_extract_args(
            "rpg-maker",
            root.path(),
            &range_output,
            &[
                "--scope",
                "unit-range",
                "--start",
                "1",
                "--end-exclusive",
                "3",
            ],
        ))
        .expect("rpg-maker alias accepts a source-unit range");
        let range_bundle: serde_json::Value =
            serde_json::from_slice(&fs::read(&range_output).expect("read unit-range bundle"))
                .expect("unit-range bundle is JSON");
        kaifuu_core::BridgeBundleV02::validate_json(&range_bundle)
            .expect("unit-range bundle remains v0.2-valid");
        assert_eq!(
            range_bundle["units"]
                .as_array()
                .expect("unit-range units")
                .iter()
                .map(|unit| unit["sourceUnitKey"].as_str().expect("unit key"))
                .collect::<Vec<_>>(),
            all_keys[1..3]
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn rejects_the_legacy_game_dir_flag() {
        let error = run_extract_rpgmaker_bundle(
            &[
                "extract",
                "--engine",
                "rpgmaker",
                "--game-dir",
                "legacy-path",
                "--scope",
                "all",
            ]
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>(),
        )
        .expect_err("the old path flag has no compatibility shim");

        assert!(error.to_string().contains("--game-dir is not supported"));
        assert!(error.to_string().contains("--game-root <PATH>"));
    }
}
