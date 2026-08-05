use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use kaifuu_core::{sha256_hash_bytes, write_json};

use super::opcode_gate::{
    UnknownOpcodeGate, evaluate_unknown_opcode_gate, unknown_opcode_tuples_json,
};
use super::paths::{
    read_gameexe_inventory_bytes, resolve_reallive_game_root_via_vault, resolve_reallive_layout,
};
use crate::{flag, flag_optional, flag_present};

use super::run_scope::parse_requested_scope;

pub(crate) fn run_extract_reallive_bundle(
    args: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_reallive::{
        BridgeOpts, BridgeSceneInput, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        compiler_version_uses_xor2, decompress_archive_scenes, decompress_avg32,
        gameexe::parse_gameexe_inventory, parse_archive, parse_real_bytecode,
        produce_scoped_seen_bundle, recover_and_decrypt_archive, unrecognized_opcode_histogram,
    };

    let game_id = required_reallive_metadata_flag(args, "--game-id")?;
    let game_version = required_reallive_metadata_flag(args, "--game-version")?;
    let source_profile_id = required_reallive_metadata_flag(args, "--source-profile-id")?;
    let source_locale = required_reallive_metadata_flag(args, "--source-locale")?;
    let bundle_output = PathBuf::from(flag(args, "--bundle-output")?);
    let requested_scope = parse_requested_scope(args)?;
    // Alpha sourcing route (production): resolve the corpus BY-ID through the
    // read-only vault adapter (`kaifuu-vault-source`). `--game-root` /
    // A raw source is always explicit. Durable private roots belong in the
    // platform inventory; this command consumes the selected path as an arg.
    let layout = if let Some(canonical_id) = flag_optional(args, "--vault-canonical-id") {
        let tree_root = resolve_reallive_game_root_via_vault(canonical_id)?;
        resolve_reallive_layout(&tree_root)?
    } else {
        let game_root = PathBuf::from(flag_optional(args, "--game-root").ok_or(
            "--vault-canonical-id <ID> (vault by-id sourcing) or --game-root <PATH> required",
        )?);
        resolve_reallive_layout(&game_root)?
    };
    let resolved_game_root = layout.game_root.clone();
    let seen_path = layout.seen_txt.clone();
    let seen_bytes = fs::read(&seen_path).map_err(|err| -> Box<dyn std::error::Error> {
        format!("failed to read {}: {err}", seen_path.display()).into()
    })?;
    if (seen_bytes.len() as u64) < REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN {
        return Err(format!(
            "Seen.txt is shorter than the fixed 10,000-slot directory ({REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN}); refusing to parse"
        )
        .into());
    }

    let index = parse_archive(&seen_bytes).map_err(|err| -> Box<dyn std::error::Error> {
        format!("kaifuu.reallive.archive_parse: {err:?}").into()
    })?;

    let gameexe_path = layout.gameexe_ini.clone();
    let gameexe_bytes = read_gameexe_inventory_bytes(&gameexe_path)?;
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);

    let opts = BridgeOpts {
        game_id,
        game_version,
        source_profile_id,
        source_locale,
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: 0,
    };

    {
        let mut decoded_scenes = Vec::new();
        let mut total_opcodes = 0usize;
        let mut unknown_opcodes = 0usize;
        // `(module_type, module_id, opcode) -> count` of every opcode that
        // failed `is_recognized`, accumulated across the whole SEEN so the
        // report/gate name the exact un-catalogued tuples rather than a bare
        // aggregate count.
        let mut unknown_signatures: BTreeMap<(u8, u8, u16), usize> = BTreeMap::new();

        let mut xor2_corpus = if index
            .entries
            .iter()
            .filter(|entry| requested_scope.includes_scene(entry.scene_id))
            .any(|entry| {
                let Ok((_, _, header)) = reallive_scene_slices(&seen_bytes, entry.scene_id, &index)
                else {
                    return false;
                };
                compiler_version_uses_xor2(header.compiler_version)
            }) {
            let mut corpus = decompress_archive_scenes(&seen_bytes, &index);
            let report = recover_and_decrypt_archive(&mut corpus.scenes);
            if !report.validated {
                return Err(format!(
                    "kaifuu.reallive.xor2.decrypt_failed: whole-SEEN extract found xor_2 scenes \
                     but no per-game xor_2 key validated over the archive: {}",
                    report
                        .finding
                        .as_deref()
                        .unwrap_or("no eligible scene reached the xor_2 segment"),
                )
                .into());
            }
            Some(corpus)
        } else {
            None
        };

        for entry in &index.entries {
            if !requested_scope.includes_scene(entry.scene_id) {
                continue;
            }
            let (scene_blob, compressed, header) =
                reallive_scene_slices(&seen_bytes, entry.scene_id, &index)?;
            let decompressed = if compiler_version_uses_xor2(header.compiler_version) {
                let corpus = xor2_corpus
                    .as_mut()
                    .expect("xor2 corpus must be available for xor2 scene");
                let idx = corpus.position_of(entry.scene_id).ok_or_else(
                    || -> Box<dyn std::error::Error> {
                        format!(
                            "kaifuu.reallive.whole_seen.scene_missing_after_xor2: scene {} vanished during xor_2 recovery",
                            entry.scene_id
                        )
                        .into()
                    },
                )?;
                corpus.scenes[idx].bytecode.clone()
            } else {
                decompress_avg32(compressed, header.bytecode_uncompressed_size as usize).map_err(
                    |err| -> Box<dyn std::error::Error> {
                        format!(
                            "kaifuu.reallive.whole_seen.decompress_failed: scene {}: {err}",
                            entry.scene_id
                        )
                        .into()
                    },
                )?
            };
            let opcodes = parse_real_bytecode(&decompressed).map_err(
                |err| -> Box<dyn std::error::Error> {
                    format!(
                        "kaifuu.reallive.whole_seen.bytecode_parse_failed: scene {}: {err}",
                        entry.scene_id
                    )
                    .into()
                },
            )?;
            total_opcodes += opcodes.len();
            unknown_opcodes += opcodes.iter().filter(|op| !op.is_recognized()).count();
            for (signature, count) in unrecognized_opcode_histogram(&opcodes) {
                *unknown_signatures.entry(signature).or_insert(0) += count;
            }
            decoded_scenes.push(DecodedRealliveScene {
                scene_id: entry.scene_id,
                scene_blob,
                decompressed,
                kidoku_count: header.kidoku_count,
            });
        }

        let scene_inputs: Vec<BridgeSceneInput<'_>> = decoded_scenes
            .iter()
            .map(|scene| BridgeSceneInput {
                scene_id: scene.scene_id,
                scene_bytes: scene.scene_blob,
                decompressed_bytecode: &scene.decompressed,
                scene_kidoku_count: scene.kidoku_count,
            })
            .collect();
        let produced = produce_scoped_seen_bundle(
            &seen_bytes,
            &scene_inputs,
            requested_scope.bridge_scope(),
            &gameexe_inventory,
            &opts,
        )
        .map_err(|err| -> Box<dyn std::error::Error> {
            format!("kaifuu.reallive.scoped.bridge: {err}").into()
        })?;
        write_json(&bundle_output, &produced.json)?;

        // `kaifuu extract --whole-seen` produces the BRIDGE only (pure kaifuu
        // decode). The replay-derived narrative structure / `sceneDispatchOrder`
        // is NOT kaifuu's concern — deriving it needs the Utsushi replay runtime,
        // and kaifuu must never depend on utsushi (deps flow utsushi → kaifuu).
        // That artifact is produced on the Utsushi side (`utsushi-cli structure`)
        // and fed to the whole-game localize driver as a SEPARATE input.

        if let Some(report_path) = flag_optional(args, "--decompile-report-output") {
            let source_seen_sha256 = sha256_hash_bytes(&seen_bytes);
            let report = serde_json::json!({
                "schemaVersion": "itotori.kaifuu.decompile-report.v0",
                "engine": "reallive",
                "gameId": opts.game_id,
                "gameVersion": opts.game_version,
                "scope": requested_scope.report_scope(),
                "sceneCount": decoded_scenes.len(),
                "totalOpcodes": total_opcodes,
                "recognizedOpcodes": total_opcodes - unknown_opcodes,
                "unknownOpcodes": unknown_opcodes,
                // Full `(module_type, module_id, opcode) -> count` tuple list of
                // every un-recognised opcode — not just the aggregate above —
                // so a caller can triage the exact un-catalogued commands.
                "unknownOpcodeTuples": unknown_opcode_tuples_json(&unknown_signatures),
                "sourceSeenSha256": source_seen_sha256,
                "resolvedGameRoot": resolved_game_root.display().to_string(),
                "resolvedLayout": layout.kind.as_str(),
                "resolvedSeenPath": seen_path.display().to_string(),
            });
            write_json(&PathBuf::from(report_path), &report)?;
        }
        // DECODE-HONESTY gate: a non-zero unknown count means the SEEN did NOT
        // fully decode. Fail loud (non-zero exit) with the tuple list by
        // default; `--allow-unknown-opcodes` / `--exploratory` downgrades to a
        // prominent warning for exploratory decode of a new/unseen title.
        let allow_unknown =
            flag_present(args, "--allow-unknown-opcodes") || flag_present(args, "--exploratory");
        match evaluate_unknown_opcode_gate(unknown_opcodes, &unknown_signatures, allow_unknown) {
            UnknownOpcodeGate::Clean => {}
            UnknownOpcodeGate::Warn(message) => eprintln!("{message}"),
            UnknownOpcodeGate::Fail(message) => return Err(message.into()),
        }
        Ok(())
    }
}

#[derive(Debug)]
struct DecodedRealliveScene<'a> {
    scene_id: u16,
    scene_blob: &'a [u8],
    decompressed: Vec<u8>,
    kidoku_count: u32,
}

/// The two borrowed byte slices (scene blob + decompressed body region) and the
/// parsed header a decoded RealLive scene yields — factored out to keep
/// `reallive_scene_slices`' signature under clippy's type-complexity threshold.
type RealliveSceneSlices<'a> = (&'a [u8], &'a [u8], kaifuu_reallive::SceneHeader);

fn reallive_scene_slices<'a>(
    seen_bytes: &'a [u8],
    scene_id: u16,
    index: &kaifuu_reallive::RealLiveSceneIndex,
) -> Result<RealliveSceneSlices<'a>, Box<dyn std::error::Error>> {
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == scene_id)
        .ok_or_else(|| -> Box<dyn std::error::Error> {
            format!("scene {scene_id} not present in archive directory").into()
        })?;
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    if blob_end > seen_bytes.len() {
        return Err(format!(
            "scene {scene_id} blob (offset={blob_start}, len={}) runs past archive length",
            entry.byte_len
        )
        .into());
    }
    let scene_blob = &seen_bytes[blob_start..blob_end];
    let header = kaifuu_reallive::SceneHeader::parse(scene_blob).map_err(
        |err| -> Box<dyn std::error::Error> {
            format!("kaifuu.reallive.scene_header_parse: scene {scene_id}: {err}").into()
        },
    )?;
    let bytecode_start = header.bytecode_offset as usize;
    let bytecode_end = bytecode_start + header.bytecode_compressed_size as usize;
    if bytecode_end > scene_blob.len() {
        return Err(format!(
            "scene {scene_id} declared bytecode_offset={bytecode_start} + size={} past blob end",
            header.bytecode_compressed_size
        )
        .into());
    }
    Ok((
        scene_blob,
        &scene_blob[bytecode_start..bytecode_end],
        header,
    ))
}

fn required_reallive_metadata_flag<'a>(
    args: &'a [String],
    name: &str,
) -> Result<&'a str, Box<dyn std::error::Error>> {
    let value = flag_optional(args, name).ok_or_else(|| {
        format!("missing RealLive bridge metadata flag {name}; pass --game-id, --game-version, --source-profile-id, and --source-locale")
    })?;
    if value.trim().is_empty() || value.starts_with("--") {
        return Err(
            format!("RealLive bridge metadata flag {name} must have a non-empty value").into(),
        );
    }
    Ok(value)
}
