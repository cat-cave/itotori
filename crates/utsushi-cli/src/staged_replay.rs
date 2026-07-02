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
use std::fmt;
use std::fs;
use std::path::Path;

use kaifuu_reallive::{Xor2DecScene, Xor2Report, recover_and_decrypt_archive};
use utsushi_reallive::{
    RealSceneIndex, ReplayEngine, ReplayLog, ReplayOpts, build_scene_store_from_decompressed,
    decompress_all_scenes, replay_scene,
};

/// Typed error surfaced when an archive is `use_xor_2`-eligible
/// (`scenes_eligible > 0`) but the cross-scene key recovery FAILED to
/// validate (`Xor2Report::validated == false`).
///
/// Without this, the still-ciphered `[256, 513)` segments would be
/// folded back and replayed, and the seam would hand back an `Ok`
/// [`ReplayLog`] of mojibake as if it were real decoded text. The
/// staging seam MUST NOT present ciphertext as decoded output, so this
/// branch fails typed instead of silently succeeding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Xor2ValidationFailed {
    /// Eligible (`use_xor_2`) scenes considered for recovery.
    pub scenes_eligible: usize,
    /// Eligible scenes actually decrypted (0 on a validation failure).
    pub scenes_decrypted: usize,
    /// Structured semantic finding from the recovery pass, if any.
    pub finding: Option<String>,
}

impl fmt::Display for Xor2ValidationFailed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "utsushi.cli.staged_replay.xor2_validation_failed: {} xor2-eligible scene(s) but key \
             recovery did not validate (decrypted={}); refusing to replay still-ciphered mojibake",
            self.scenes_eligible, self.scenes_decrypted,
        )?;
        if let Some(finding) = &self.finding {
            write!(f, "; finding={finding}")?;
        }
        Ok(())
    }
}

impl Error for Xor2ValidationFailed {}

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

    // xor2-eligible but key recovery FAILED (`validated == false`): the
    // `[256, 513)` segments are still ciphered; folding them back and
    // replaying would return an `Ok` ReplayLog of mojibake. Fail typed
    // instead — the seam must not present ciphertext as decoded text.
    xor2_staging_guard(&report)?;

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

/// Guard the staging seam against handing back still-ciphered mojibake.
///
/// Returns [`Xor2ValidationFailed`] iff the archive is `use_xor_2`-eligible
/// (`scenes_eligible > 0`) but the cross-scene key recovery did NOT validate
/// (`validated == false`). A non-eligible archive (`scenes_eligible == 0`) and
/// a validated recovery both return `Ok(())` — the eligible-and-validated
/// happy path and the non-xor2 fall-through are unchanged.
fn xor2_staging_guard(report: &Xor2Report) -> Result<(), Xor2ValidationFailed> {
    if report.scenes_eligible > 0 && !report.validated {
        return Err(Xor2ValidationFailed {
            scenes_eligible: report.scenes_eligible,
            scenes_decrypted: report.scenes_decrypted,
            finding: report.finding.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_reallive::compiler_version_uses_xor2;

    /// A `use_xor_2`-eligible archive (compiler `110002`) whose ciphered
    /// segment cannot be recovered drives the REAL `recover_and_decrypt_archive`
    /// pass to `scenes_eligible > 0 && validated == false`. The staging guard
    /// MUST convert that outcome into a typed [`Xor2ValidationFailed`] rather
    /// than let the caller fold ciphertext back and replay `Ok` mojibake.
    #[test]
    fn xor2_validation_failure_surfaces_typed_error() {
        // Eligible compiler version, but random bytecode no candidate key can
        // recover to a clean decode — so recovery cannot validate.
        assert!(compiler_version_uses_xor2(110002));
        let bytecode: Vec<u8> = (0u32..2048)
            .map(|i| (i.wrapping_mul(37) ^ 0x5A) as u8)
            .collect();
        let mut scenes = vec![Xor2DecScene {
            compiler_version: 110002,
            bytecode,
        }];

        // Real recovery path (kaifuu-reallive), not a hand-forged report.
        let report = recover_and_decrypt_archive(&mut scenes);
        assert!(
            report.scenes_eligible > 0,
            "archive must be xor2-eligible: {report:?}"
        );
        assert!(
            !report.validated,
            "unrecoverable ciphertext must NOT validate: {report:?}"
        );

        // The guard turns that report into the typed error.
        let err = xor2_staging_guard(&report)
            .expect_err("eligible-but-unvalidated must surface a typed error, not Ok");
        assert_eq!(err.scenes_eligible, report.scenes_eligible);
        assert_eq!(err.scenes_decrypted, report.scenes_decrypted);
        assert_eq!(
            err.scenes_decrypted, 0,
            "a failed recovery decrypts nothing"
        );
        // The Display carries the refusal diagnostic (no silent mojibake).
        assert!(
            err.to_string()
                .contains("refusing to replay still-ciphered mojibake"),
            "diagnostic must state the refusal: {err}"
        );
    }

    /// Happy path: a validated recovery returns `Ok(())` from the guard — the
    /// eligible-and-validated seam is unchanged.
    #[test]
    fn xor2_validated_report_passes_guard() {
        let report = Xor2Report {
            segment_offset: 256,
            segment_length: 257,
            key_len: 16,
            scenes_total: 3,
            scenes_eligible: 3,
            baseline_clean: 0,
            after_clean: 3,
            scenes_decrypted: 3,
            validated: true,
            key_sha256: Some("deadbeef".to_string()),
            finding: None,
        };
        assert!(
            xor2_staging_guard(&report).is_ok(),
            "a validated recovery must pass the guard unchanged"
        );
    }

    /// Non-xor2 fall-through: `scenes_eligible == 0` returns `Ok(())` — the
    /// guard never fires for a non-`use_xor_2` archive.
    #[test]
    fn non_xor2_report_passes_guard() {
        let report = Xor2Report {
            segment_offset: 256,
            segment_length: 257,
            key_len: 16,
            scenes_total: 4,
            scenes_eligible: 0,
            baseline_clean: 0,
            after_clean: 0,
            scenes_decrypted: 0,
            validated: false,
            key_sha256: None,
            finding: None,
        };
        assert!(
            xor2_staging_guard(&report).is_ok(),
            "a non-xor2 archive (no eligible scenes) must pass the guard"
        );
    }
}
