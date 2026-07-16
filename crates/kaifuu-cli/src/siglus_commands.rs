use std::path::PathBuf;

use crate::{
    EngineAdapter, SiglusParserBoundarySmokeRequest, SiglusParserBoundarySmokeVariant,
    atomic_write_text, flag, flag_optional, positional, read_json,
    run_siglus_known_key_parser_boundary_smoke, write_json,
};

pub(crate) fn run_siglus_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "parser-boundary-smoke" => {
            let scene_path = PathBuf::from(flag(args, "--scene")?);
            let gameexe_path = PathBuf::from(flag(args, "--gameexe")?);
            let output = PathBuf::from(flag(args, "--output")?);
            let key_request = flag_optional(args, "--key-request")
                .map(PathBuf::from)
                .map(|path| read_json::<serde_json::Value>(&path))
                .transpose()?;
            let variant = parse_siglus_parser_boundary_variant(
                flag_optional(args, "--variant").unwrap_or("parser-boundary-success"),
            )?;
            let report =
                run_siglus_known_key_parser_boundary_smoke(SiglusParserBoundarySmokeRequest {
                    scene_path: &scene_path,
                    gameexe_path: &gameexe_path,
                    key_request: key_request.as_ref(),
                    variant,
                })?;
            write_json(&output, &report.redacted_for_report())?;
            if report.status == kaifuu_core::OperationStatus::Failed {
                return Err(
                    format!("siglus parser-boundary smoke failed: {:?}", report.outcome).into(),
                );
            }
        }
        "static-key" => {
            return run_siglus_static_key(args);
        }
        "profile-proof" => {
            return run_siglus_profile_proof(args);
        }
        _ => {
            return Err(
                "usage: kaifuu siglus <parser-boundary-smoke|static-key|profile-proof> ...\n  parser-boundary-smoke --scene <Scene.pck> --gameexe <Gameexe.dat> --key-request <helper-request.json> --output <report.json> [--variant parser-boundary-success|helper-required|missing-key|unsupported-opcode|out-of-profile]\n  static-key --fixture <manifest.json> [--output <report.json>]\n  profile-proof --fixture <synthetic-profile.json> --out <report.json>"
                    .into(),
            );
        }
    }
    Ok(())
}

/// `kaifuu siglus static-key --fixture <manifest>
/// [--output <report.json>]`.
/// Runs in-process Siglus static-key discovery for every entry in the manifest:
/// each synthetic stub (or scoped local executable + `Gameexe.dat`) is
/// statically analysed in-process — never shelled out — and any recovered
/// candidate is validated against the `Gameexe.dat` known-plaintext header
/// BEFORE a consumable secret-ref is published. Unsupported packers, protected
/// executables, helper-provenance mismatches, missing key regions, and
/// validation failures surface as structured findings. The redacted report
/// (secret-refs + proof hashes only, never raw keys) is written to `--output`
/// (or stdout); the command exits non-zero, listing each entry's blocking
/// finding codes, when any entry fails.
fn run_siglus_static_key(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = PathBuf::from(flag(args, "--fixture")?);
    let fixture: kaifuu_core::SiglusStaticKeyFixture = read_json(&fixture_path)?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or("fixture path must have a parent directory")?;
    let fixture_file_name = fixture_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("fixture path must have a file name")?;
    let report = kaifuu_core::discover_siglus_static_key(kaifuu_core::SiglusStaticKeyRequest {
        fixture: &fixture,
        fixture_dir,
        fixture_file_name,
    })?;
    let redacted = report.redacted_for_report();
    let json = redacted.stable_json()?;
    match flag_optional(args, "--output") {
        Some(output) => atomic_write_text(&PathBuf::from(output), &json)?,
        None => println!("{json}"),
    }
    if redacted.status == kaifuu_core::OperationStatus::Failed {
        let failures = redacted
            .entries
            .iter()
            .filter(|entry| entry.status == kaifuu_core::OperationStatus::Failed)
            .map(|entry| {
                let codes = entry
                    .findings
                    .iter()
                    .filter(|finding| finding.severity.is_blocking())
                    .map(|finding| format!("{}:{}", finding.severity.as_str(), finding.code))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{} [{}]", entry.entry_id, codes)
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("Siglus static-key discovery failed: {failures}").into());
    }
    Ok(())
}

/// `kaifuu siglus profile-proof --fixture <synthetic-profile.json>
/// --out <report.json>`.
/// COMPOSES the Siglus detector, known-key key-profile, parser-boundary, and
/// redacted compat-profile validation slices into one honestly-scoped proof
/// report over a SYNTHETIC profile fixture. It runs each real slice in-process:
/// 1. the `SiglusProfileDetectorAdapter` over the fixture's `detectorGameDir` →
///    detector evidence;
/// 2. `run_siglus_known_key_parser_boundary_smoke` over the fixture's synthetic
///    `Scene.pck` / `Gameexe.dat` / key-request → parser profile id + key-refs;
/// 3. `validate_claimed_support_tuple` over the fixture's compat tuple →
///    capability-level honesty.
///    The composed report records detector evidence, key-profile id, parser-profile
///    id, capability level, and a redaction summary. Before the artifact is
///    written it is deep-scanned: a seeded raw key, helper dump
///    private path, or decrypted private text makes the composition fail loud and
///    nothing is persisted. The command claims NO broad commercial Siglus
///    compatibility — the extract/decrypt/repack core is NotImplemented.
fn run_siglus_profile_proof(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = PathBuf::from(flag(args, "--fixture")?);
    let out = PathBuf::from(flag(args, "--out")?);
    let fixture: kaifuu_core::SiglusProfileProofFixture = read_json(&fixture_path)?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or("fixture path must have a parent directory")?;

    let detector_game_dir = fixture_dir.join(&fixture.detector_game_dir);
    let detector = kaifuu_engine_fixture::SiglusProfileDetectorAdapter;
    let detection = detector.detect(kaifuu_core::DetectRequest {
        game_dir: &detector_game_dir,
    })?;

    let scene_path = fixture_dir.join(&fixture.parser.scene);
    let gameexe_path = fixture_dir.join(&fixture.parser.gameexe);
    let key_request_path = fixture_dir.join(&fixture.parser.key_request);
    let key_request: serde_json::Value = read_json(&key_request_path)?;
    let variant = parse_siglus_parser_boundary_variant(&fixture.parser.variant)?;
    let parser_boundary =
        run_siglus_known_key_parser_boundary_smoke(SiglusParserBoundarySmokeRequest {
            scene_path: &scene_path,
            gameexe_path: &gameexe_path,
            key_request: Some(&key_request),
            variant,
        })?;

    let compat_tuple_path = fixture_dir.join(&fixture.compat_tuple);
    let compat_tuple: kaifuu_core::compat_profile::ClaimedSupportTuple =
        read_json(&compat_tuple_path)?;
    let compat_entry = kaifuu_core::compat_profile::validate_claimed_support_tuple(&compat_tuple);

    let report =
        kaifuu_core::compose_siglus_profile_proof(kaifuu_core::SiglusProfileProofComposeInput {
            fixture: &fixture,
            detection: &detection,
            parser_boundary: &parser_boundary,
            compat_entry: &compat_entry,
        })?;

    atomic_write_text(&out, &report.stable_json()?)?;
    if report.status == kaifuu_core::OperationStatus::Failed {
        let codes = report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity.is_blocking())
            .map(|diagnostic| format!("{}:{}", diagnostic.severity.as_str(), diagnostic.code))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!("Siglus profile proof failed: {codes}").into());
    }
    Ok(())
}

fn parse_siglus_parser_boundary_variant(
    value: &str,
) -> Result<SiglusParserBoundarySmokeVariant, Box<dyn std::error::Error>> {
    match value {
        "parser-boundary-success" | "success" => {
            Ok(SiglusParserBoundarySmokeVariant::ParserBoundarySuccess)
        }
        "helper-required" => Ok(SiglusParserBoundarySmokeVariant::HelperRequired),
        "missing-key" => Ok(SiglusParserBoundarySmokeVariant::MissingKey),
        "unsupported-opcode" => Ok(SiglusParserBoundarySmokeVariant::UnsupportedOpcode),
        "out-of-profile" => Ok(SiglusParserBoundarySmokeVariant::OutOfProfile),
        _ => Err(format!("unsupported Siglus parser-boundary smoke variant {value}").into()),
    }
}
