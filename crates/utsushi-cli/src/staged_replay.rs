//! Utsushi-cli-single-scene-xor2-staging — shared single-scene replay entry
//! that stages the dev-only `use_xor_2` segment-cipher recovery before the
//! bytecode decode, so the `replay-validate` / `render-validate` CLI surfaces
//! decode REAL text (not mojibake) on xor2 titles such as Sweetie HD
//! (compiler `110002`).
//!
//! # Why this exists
//!
//! The pure `utsushi-reallive` decode path owns the first-level AVG32 inflate
//! but NOT the second-level `use_xor_2` segment cipher over `[256, 513)`. That cipher's
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
//! Non-`use_xor_2` titles use the same staged-store construction with no
//! decryption changes.

use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;

use kaifuu_reallive::{Xor2DecScene, Xor2Report, recover_and_decrypt_archive};
use utsushi_reallive::{
    DecompressedScene, RealSceneIndex, ReplayEngine, SceneStoreStats,
    build_scene_store_from_decompressed, decompress_all_scenes,
};

#[derive(Debug)]
pub(crate) struct StagedArchive {
    pub engine: ReplayEngine,
    pub scenes: Vec<DecompressedScene>,
    pub store_stats: SceneStoreStats,
}

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

/// Build a [`ReplayEngine`] from a Seen.txt envelope with the SAME
/// `use_xor_2` staging used by the RealLive port, but hand back the
/// engine itself instead of a single-scene [`ReplayLog`]. This is the
/// entry the render surface uses so it can drive
/// [`ReplayEngine::observe_for_port`] (the real play-order message
/// stream with per-message speaker + colour) and install the Gameexe
/// `#NAMAE`/`#COLOR_TABLE` resolver via
/// [`ReplayEngine::with_namae_resolver`].
///
/// Non-`use_xor_2` titles (`scenes_eligible == 0`) build the store
/// straight from the first-level-inflated bytecode; `use_xor_2` titles
/// fold the recovered plaintext segments back first (and fail typed via
/// [`Xor2ValidationFailed`] when eligible-but-unvalidated.
pub fn staged_engine(seen_path: &Path) -> Result<ReplayEngine, Box<dyn Error>> {
    Ok(staged_archive(seen_path)?.engine)
}

/// Decode the complete archive once and retain the recovered plaintext scenes
/// and store coverage diagnostics alongside the replay engine.
pub(crate) fn staged_archive(seen_path: &Path) -> Result<StagedArchive, Box<dyn Error>> {
    let bytes = fs::read(seen_path).map_err(|err| {
        format!(
            "utsushi.cli.staged_replay.read: {}: {err}",
            seen_path.display()
        )
    })?;

    let mut decompressed = decompress_all_scenes(&bytes)
        .map_err(|err| format!("utsushi.cli.staged_replay.decompress: {err}"))?;

    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let report = recover_and_decrypt_archive(&mut xor2);

    if report.scenes_eligible > 0 {
        // xor2-eligible: refuse to present still-ciphered mojibake, then
        // fold the decrypted segments back into the store input.
        xor2_staging_guard(&report)?;
        for (scene, dec) in decompressed.iter_mut().zip(xor2) {
            scene.bytecode = dec.bytecode;
        }
    }

    let index_len = RealSceneIndex::parse(&bytes)
        .map_err(|err| format!("utsushi.cli.staged_replay.index: {err}"))?
        .entries
        .len();
    let (store, shift_jis, store_stats) =
        build_scene_store_from_decompressed(&decompressed, index_len)
            .map_err(|err| format!("utsushi.cli.staged_replay.store: {err}"))?;
    Ok(StagedArchive {
        engine: ReplayEngine::from_store(store, shift_jis),
        scenes: decompressed,
        store_stats,
    })
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
