use std::fs;
use std::path::{Path, PathBuf};

use crate::{
    EngineAdapter, SiglusParserBoundarySmokeRequest, SiglusParserBoundarySmokeVariant,
    atomic_write_text, flag, flag_optional, positional, read_json,
    run_siglus_known_key_parser_boundary_smoke, write_json,
};

pub(crate) fn is_siglus_engine_command(args: &[String]) -> bool {
    flag_optional(args, "--engine") == Some("siglus")
        && matches!(args.first().map(String::as_str), Some("extract" | "patch"))
}

/// Dispatch standard engine verbs through the Siglus profile gate.
///
/// The profile check deliberately runs before a source path is read. The bridge
/// and patchback byte transformations remain owned by their dedicated modules.
pub(crate) fn run_siglus_engine_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let profile = kaifuu_siglus::SiglusEngineProfile::standard();
    profile.validate_cipher_method(flag(args, "--cipher-method")?)?;

    match args.first().map(String::as_str) {
        Some("extract") => run_extract_siglus_bundle(args, &profile),
        Some("patch") => run_patch_siglus_bundle(args, &profile),
        _ => Err("usage: kaifuu <extract|patch> --engine siglus ...".into()),
    }
}

/// `extract --engine siglus` decodes every SceneList entry, then passes the
/// decoded payloads plus the Gameexe inventory to the whole-pack bridge.
fn run_extract_siglus_bundle(
    args: &[String],
    profile: &kaifuu_siglus::SiglusEngineProfile,
) -> Result<(), Box<dyn std::error::Error>> {
    let game_root = siglus_game_root(args)?;
    let scene_pck = fs::read(game_root.join("Scene.pck"))?;
    let gameexe = fs::read(game_root.join("Gameexe.dat"))?;
    let executable = fs::read(game_root.join("SiglusEngine.exe"))?;
    let key_ref = siglus_second_layer_key(profile);
    let inventory = kaifuu_siglus::read_gameexe_inventory(&executable, &gameexe, &key_ref)?;
    let index = kaifuu_siglus::parse_scene_pck(&scene_pck)?;
    let scene_key = index
        .extra_key_use
        .then(|| kaifuu_siglus::recover_exe_angou_key(&executable, &key_ref))
        .transpose()?;
    let second_layer = scene_key
        .as_ref()
        .map(kaifuu_siglus::ExeAngouKeyRecovery::material);

    let mut decoded_scenes = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let packed = siglus_scene_slice(&scene_pck, entry)?;
        let decoded = kaifuu_siglus::decode_scene_chunk(
            entry.scene_id,
            packed,
            index.extra_key_use,
            second_layer,
        )?;
        decoded_scenes.push(DecodedSiglusScene {
            entry,
            packed,
            decoded,
        });
    }
    let scene_inputs = decoded_scenes
        .iter()
        .map(|scene| kaifuu_siglus::BridgeSceneInput {
            scene_id: scene.entry.scene_id,
            scene_name: scene.entry.scene_name.as_deref(),
            scene_bytes: scene.packed,
            decoded_scene: &scene.decoded,
        })
        .collect::<Vec<_>>();
    let opts = kaifuu_siglus::BridgeOpts {
        game_id: flag(args, "--game-id")?,
        game_version: flag(args, "--game-version")?,
        source_profile_id: flag(args, "--source-profile-id")?,
        source_locale: flag(args, "--source-locale")?,
        extractor_name: "kaifuu-siglus-bridge",
        extractor_version: env!("CARGO_PKG_VERSION"),
    };
    let produced = kaifuu_siglus::produce_whole_scene_pack_bundle(
        &scene_pck,
        &scene_inputs,
        &inventory,
        &opts,
    )?;

    write_json(
        &PathBuf::from(flag(args, "--bundle-output")?),
        &produced.json,
    )?;
    Ok(())
}

/// `patch --engine siglus` consumes a translated v0.2 bundle and emits one
/// patched `Scene.pck`. A keyed archive recovers the matching second layer from
/// the executable next to the source archive before entering patchback.
fn run_patch_siglus_bundle(
    args: &[String],
    profile: &kaifuu_siglus::SiglusEngineProfile,
) -> Result<(), Box<dyn std::error::Error>> {
    let source_path = PathBuf::from(flag(args, "--source")?);
    let source = fs::read(&source_path)?;
    let bundle: serde_json::Value = read_json(&PathBuf::from(flag(args, "--bundle")?))?;
    let translated = kaifuu_siglus::TranslatedBundleV02::from_json(&bundle)?;
    let index = kaifuu_siglus::parse_scene_pck(&source)?;
    let key_ref = siglus_second_layer_key(profile);
    let scene_key = index
        .extra_key_use
        .then(|| recover_patch_scene_key(&source_path, &key_ref))
        .transpose()?;
    let patched = if let Some(recovery) = scene_key.as_ref() {
        kaifuu_siglus::apply_translated_bundle(
            &source,
            &translated,
            &kaifuu_siglus::PatchbackOpts::utf16le_with_second_layer(recovery.material()),
        )?
    } else {
        kaifuu_siglus::apply_translated_bundle(
            &source,
            &translated,
            &kaifuu_siglus::PatchbackOpts::utf16le(),
        )?
    };

    kaifuu_core::atomic_write_bytes(&PathBuf::from(flag(args, "--target")?), &patched)?;
    Ok(())
}

fn siglus_second_layer_key(
    profile: &kaifuu_siglus::SiglusEngineProfile,
) -> kaifuu_siglus::SiglusSecondLayerKey {
    kaifuu_siglus::SiglusSecondLayerKey::from_secret_ref(profile.cipher_posture.secret_ref.as_str())
}

fn recover_patch_scene_key(
    source_path: &Path,
    key_ref: &kaifuu_siglus::SiglusSecondLayerKey,
) -> Result<kaifuu_siglus::ExeAngouKeyRecovery, Box<dyn std::error::Error>> {
    let source_directory = source_path.parent().ok_or(
        "kaifuu.siglus.engine_profile.source_parent_missing: --source must name a Scene.pck file",
    )?;
    let executable_path = source_directory.join("SiglusEngine.exe");
    if !executable_path.is_file() {
        return Err(
            "kaifuu.siglus.engine_profile.required_assets_missing: keyed Scene.pck patchback requires SiglusEngine.exe next to --source"
                .into(),
        );
    }
    Ok(kaifuu_siglus::recover_exe_angou_key(
        &fs::read(executable_path)?,
        key_ref,
    )?)
}

struct DecodedSiglusScene<'a> {
    entry: &'a kaifuu_siglus::SiglusSceneEntry,
    packed: &'a [u8],
    decoded: Vec<u8>,
}

fn siglus_scene_slice<'a>(
    archive: &'a [u8],
    entry: &kaifuu_siglus::SiglusSceneEntry,
) -> Result<&'a [u8], Box<dyn std::error::Error>> {
    let start = usize::try_from(entry.byte_offset)?;
    let byte_len = usize::try_from(entry.byte_len)?;
    let end = start.checked_add(byte_len).ok_or_else(|| {
        format!(
            "kaifuu.siglus.archive.scene_range_overflow: scene {} has offset {} and length {}",
            entry.scene_id, entry.byte_offset, entry.byte_len
        )
    })?;
    archive.get(start..end).ok_or_else(|| {
        format!(
            "kaifuu.siglus.archive.truncated_scene: scene {} has offset {} and length {}",
            entry.scene_id, entry.byte_offset, entry.byte_len
        )
        .into()
    })
}

/// Resolve either a generic vault claim or a locally materialized root.
/// No title identifier, source bytes, or key bytes become profile metadata.
fn siglus_game_root(args: &[String]) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let vault_canonical_id = flag_optional(args, "--vault-canonical-id");
    let game_root = flag_optional(args, "--game-root");
    if vault_canonical_id.is_some() && game_root.is_some() {
        return Err(
            "kaifuu.siglus.engine_profile.ambiguous_source: provide either --vault-canonical-id or --game-root, not both"
                .into(),
        );
    }
    let root = if let Some(canonical_id) = vault_canonical_id {
        use kaifuu_vault_source::{
            ClaimQuery, LocalCorpusSource, MaterializeOptions, ScratchConfig, VaultConfig,
            VaultSource,
        };
        let source = VaultSource::open(&VaultConfig::default(), &ScratchConfig::default())?;
        let candidate = source
            .discover(&ClaimQuery::ByCanonicalId {
                canonical_id: canonical_id.to_string(),
            })?
            .into_iter()
            .next()
            .ok_or("kaifuu.siglus.engine_profile.vault_claim_unresolved")?;
        source
            .materialize(&candidate, MaterializeOptions::default())?
            .tree_root
    } else if let Some(root) = game_root {
        PathBuf::from(root)
    } else if let Some(root) = std::env::var_os("ITOTORI_REAL_GAME_ROOT_SIGLUS") {
        PathBuf::from(root)
    } else {
        return Err(
            "kaifuu.siglus.engine_profile.source_unresolved: --vault-canonical-id <ID>, --game-root <PATH>, or ITOTORI_REAL_GAME_ROOT_SIGLUS is required"
                .into(),
        );
    };
    find_siglus_game_root(&root).ok_or_else(|| {
        "kaifuu.siglus.engine_profile.required_assets_missing: expected Scene.pck, Gameexe.dat, and SiglusEngine.exe"
            .into()
    })
}

fn find_siglus_game_root(root: &Path) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(candidate) = pending.pop() {
        if candidate.join("Scene.pck").is_file()
            && candidate.join("Gameexe.dat").is_file()
            && candidate.join("SiglusEngine.exe").is_file()
        {
            return Some(candidate);
        }
        let Ok(entries) = std::fs::read_dir(&candidate) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            }
        }
    }
    None
}

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
///    compatibility — its synthetic fixture evidence does not replace the
///    profile-gated extract/decrypt/repack pipeline.
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
