//! utsushi-cli-single-scene-xor2-staging — shared single-scene replay entry
//! that stages the dev-only `use_xor_2` segment-cipher recovery before the
//! bytecode decode, so the `replay-validate` / `render-validate` CLI surfaces
//! decode REAL text (not mojibake) on xor2 titles such as Sweetie HD
//! (compiler `110002`).
//!
//! # Why this exists
//!
//! [`utsushi_reallive::replay_scene`] drives the pure-`utsushi-reallive`
//! decode path, which owns the first-level AVG32 inflate but NOT the
//! second-level `use_xor_2` segment cipher over `[256, 513)`. That cipher's
//! per-game key recovery is a dev-only `kaifuu-reallive` concern (no key
//! material is committed). For a `use_xor_2` title the pure path therefore
//! replays the still-ciphered segment as mojibake, and any
//! observed-translated-text assertion over the emitted `ReplayLog` fails.
//!
//! # What it does
//!
//! This is the SAME staging seam the `full_module_replay_real_bytes`
//! acceptance test uses, lifted into the shipped CLI orchestration layer
//! (the architectural boundary keeps `utsushi-reallive` free of any
//! `kaifuu-reallive` dependency; the top-level binary owns the recovery):
//!
//! 1. [`decompress_all_scenes`] — first-level AVG32 inflate of every
//!    populated scene (owned by `utsushi-reallive`).
//! 2. [`recover_and_decrypt_archive`] — the dev-only `kaifuu-reallive`
//!    cross-scene key recovery + in-place decrypt of the eligible scenes.
//!    A no-op for non-`use_xor_2` titles (e.g. Kanon, compiler `10002`).
//! 3. [`build_scene_store_from_decompressed`] + [`ReplayEngine::from_store`]
//!    — rebuild the multi-scene store from the plaintext bytecode and
//!    replay the requested scene against it.
//!
//! The recovered key never leaves `recover_and_decrypt_archive` (it lives
//! only inside the module-private, zeroize-on-drop `Xor2Key`); this seam
//! sees only the decrypted bytecode and a sanitized `Xor2Report`.
//!
//! Non-`use_xor_2` titles fall straight through to
//! [`utsushi_reallive::replay_scene`] and behave exactly as before.

use std::error::Error;
use std::fs;
use std::path::Path;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    RealSceneIndex, ReplayEngine, ReplayLog, ReplayOpts, build_scene_store_from_decompressed,
    decompress_all_scenes, replay_scene,
};

/// Replay one scene of a Seen.txt envelope, staging the dev-only
/// `use_xor_2` segment-cipher recovery for xor2 titles so the emitted
/// [`ReplayLog`] carries REAL decoded text.
///
/// For a non-`use_xor_2` archive this is byte-for-byte the pre-staging
/// behaviour ([`utsushi_reallive::replay_scene`]).
///
/// # Errors
///
/// Returns a typed error when the envelope cannot be read, the archive
/// cannot be inflated / indexed / staged, or the requested scene did not
/// survive decompress + decode into the staged store.
pub fn replay_scene_staged(
    seen_path: &Path,
    scene_id: u16,
    opts: &ReplayOpts,
) -> Result<ReplayLog, Box<dyn Error>> {
    let bytes = fs::read(seen_path).map_err(|err| {
        format!(
            "utsushi.cli.staged_replay.read: {}: {err}",
            seen_path.display()
        )
    })?;

    // First-level AVG32 inflate of every populated scene.
    let mut decompressed = decompress_all_scenes(&bytes)
        .map_err(|err| format!("utsushi.cli.staged_replay.decompress: {err}"))?;

    // Stage the dev-only `kaifuu-reallive` `use_xor_2` recovery on the
    // decompressed bytecode. `scenes_eligible == 0` means a non-xor2 title
    // (nothing to recover); the recovered key never crosses this boundary.
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let report = recover_and_decrypt_archive(&mut xor2);

    if report.scenes_eligible == 0 {
        // Non-`use_xor_2` title: behave exactly as the pre-staging path.
        return replay_scene(seen_path, scene_id, opts)
            .map_err(|err| format!("utsushi.cli.staged_replay.driver: {err}").into());
    }

    // xor2 title: fold the decrypted segments back and rebuild a store from
    // the plaintext bytecode, then replay the requested scene against it.
    for (scene, dec) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = dec.bytecode;
    }
    let index_len = RealSceneIndex::parse(&bytes)
        .map_err(|err| format!("utsushi.cli.staged_replay.index: {err}"))?
        .entries
        .len();
    let (store, shift_jis, _stats) = build_scene_store_from_decompressed(&decompressed, index_len)
        .map_err(|err| format!("utsushi.cli.staged_replay.store: {err}"))?;
    let engine = ReplayEngine::from_store(store, shift_jis);
    if !engine.scene_ids().contains(&scene_id) {
        return Err(format!(
            "utsushi.cli.staged_replay.scene_not_found: scene {scene_id} did not decode/stage \
             into the store (xor2 eligible={} decrypted={} validated={})",
            report.scenes_eligible, report.scenes_decrypted, report.validated,
        )
        .into());
    }
    Ok(engine.replay_from(scene_id, opts))
}
