use std::path::PathBuf;

mod rpgmaker_encrypted_smoke;

use crate::{
    EncryptedMediaProofFixture, EncryptedMediaProofRequest, LocalSecretDirectoryStore,
    RpgMakerMvMzFixtureKeyValidationRequest, atomic_write_text, encrypted_media_proof, flag,
    flag_optional, positional, read_json, validate_rpg_maker_mv_mz_fixture_key, write_json,
};

/// RPG Maker MV/MZ extraction (`extract --engine rpgmaker --game-dir <www>
/// ...`). Wraps [`kaifuu_rpgmaker::extract_game_dir`]: walks the game's
/// `www/data/*.json` surfaces into the v0.2 BridgeBundle and writes the
/// JSON to `--bundle-output`. Identity metadata mirrors the RealLive
/// flag-shape. An optional `--findings-output` writes a sanitized
/// per-kind finding census (counts only — never source text).
pub(crate) fn run_extract_rpgmaker_bundle(
    args: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_rpgmaker::{BridgeOpts, extract_game_dir};

    let game_dir = match flag_optional(args, "--game-dir") {
        Some(value) => PathBuf::from(value),
        None => match std::env::var_os("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ") {
            Some(value) => PathBuf::from(value),
            None => {
                return Err(
                    "--game-dir <www> or ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ env var required"
                        .into(),
                );
            }
        },
    };
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

    write_json(&bundle_output, &extraction.bundle.json)?;

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
        extraction.bundle.bundle.units.len(),
        extraction.bundle.bundle.assets.len(),
        extraction.findings.len(),
    );
    Ok(())
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
                "usage: kaifuu rpgmaker <validate-fixture-key|encrypted-media-proof|encrypted-smoke> ...\n  validate-fixture-key --game-dir <dir> --image-asset <asset> --secret-store <dir> --secret-ref <local-secret:id> --output <report.json> [--requirement-id <id>] [--fixture-id <id>]\n  encrypted-media-proof --fixture <fixture.json> [--output <report.json>]\n  encrypted-smoke --fixture <fixture-id>\n(alias: kaifuu rpg-maker ...)"
                    .into(),
            );
        }
    }
    Ok(())
}
