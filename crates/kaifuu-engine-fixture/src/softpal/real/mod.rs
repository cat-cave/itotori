//! Real Softpal extract / patch-back / verify, wiring the deterministic
//! `kaifuu-softpal` reader (PAC container + `TEXT.DAT` codec + `SCRIPT.SRC`
//! disassembler + patch-back) into the [`SoftpalProfileDetectorAdapter`] so the
//! registry adapter is a **first-class extract/patch engine**, not identify-only.
//!
//! Scope (config-driven, dialogue + choices — the alpha default): the two
//! text-bearing `SCRIPT.SRC` surfaces the disassembler recovers — TEXT-SHOW
//! (dialogue, with its resolved speaker attached as context) and text-bearing
//! SELECT (choice labels). Every unit keys by its decrypted-`TEXT.DAT` record
//! **pointer** (`softpal:dialogue:<ptr>` / `softpal:choice:<ptr>`), the exact
//! record patch-back rebuilds, so a `PatchExport` round-trips back to the same
//! record with no id drift. Non-text SELECTs (system/branch immediates), the
//! full `Sv20` opcode table, and PAC repack stay out of scope (separate nodes).
//!
//! Real bytes, no shell-outs: everything runs in-process over the extracted
//! `SCRIPT.SRC` / `TEXT.DAT` byte slices via `kaifuu-softpal`. This module owns
//! the shared script **resolution**; the extract / patch / verify / inventory
//! surfaces live in the sibling submodules.

mod extract;
mod inventory;
mod patch;
mod verify;

use std::path::PathBuf;

use kaifuu_softpal::{PacArchive, ScriptScan, TextDat};

use super::*;

/// The `SCRIPT.SRC` + `TEXT.DAT` raw byte pair for a Softpal title, plus a
/// short human-readable note of where they were sourced (a loose pair or the
/// PAC archive that carried them).
pub(crate) struct SoftpalScripts {
    pub script: Vec<u8>,
    pub textdat: Vec<u8>,
    pub source_ref: String,
}

/// `source_unit_key` prefix for a TEXT-SHOW dialogue record.
pub(crate) const DIALOGUE_KEY_PREFIX: &str = "softpal:dialogue:";
/// `source_unit_key` prefix for a text-bearing SELECT (choice label) record.
pub(crate) const CHOICE_KEY_PREFIX: &str = "softpal:choice:";
/// The stable bridge asset id every Softpal text unit patches back through.
pub(crate) const SCRIPT_ASSET_ID: &str = "softpal:SCRIPT.SRC";

impl SoftpalProfileDetectorAdapter {
    /// Resolve the title's `SCRIPT.SRC` + `TEXT.DAT` raw bytes from `game_dir`:
    /// a loose pair if both are present, otherwise the `data.pac` (or any
    /// `.pac` whose table names them). Deterministic; never shells out.
    /// # Errors
    /// [`std::io::Error`] on read failure, or a typed diagnostic when no
    /// Softpal script pair can be located / extracted.
    pub(crate) fn resolve_scripts(game_dir: &Path) -> KaifuuResult<SoftpalScripts> {
        let loose_script =
            case_insensitive_find(game_dir, SOFTPAL_SCRIPT_SRC_NAME).filter(|path| path.is_file());
        let loose_text =
            case_insensitive_find(game_dir, SOFTPAL_TEXT_DAT_NAME).filter(|path| path.is_file());
        if let (Some(script_path), Some(text_path)) = (&loose_script, &loose_text) {
            let script = fs::read(script_path)?;
            let textdat = fs::read(text_path)?;
            // The loose pair only wins when it decodes; otherwise fall through
            // to the PAC (a stray same-named file is never trusted blindly).
            if ScriptScan::parse(&script).is_ok() && TextDat::parse(&textdat).is_ok() {
                return Ok(SoftpalScripts {
                    script,
                    textdat,
                    source_ref: SOFTPAL_SCRIPT_SRC_NAME.to_string(),
                });
            }
        }

        if let Some(scripts) = Self::pac_scripts_bytes(game_dir)? {
            return Ok(scripts);
        }

        Err(Self::diagnostic_error(Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::ContainerAccess,
            "softpal",
            SOFTPAL_DATA_PAC_NAME,
            "no loose SCRIPT.SRC/TEXT.DAT pair and no PAC archive listing them was found",
            "run extract against a Softpal title root containing data.pac (or a loose SCRIPT.SRC + TEXT.DAT)",
        )))
    }

    /// Locate a `.pac` whose file table names both `SCRIPT.SRC` and `TEXT.DAT`,
    /// parse it, and slice the two entries' bytes out. `data.pac` is probed
    /// first. Returns `None` when no PAC carries the script pair.
    fn pac_scripts_bytes(game_dir: &Path) -> KaifuuResult<Option<SoftpalScripts>> {
        for path in Self::sorted_pac_paths(game_dir) {
            let bytes = fs::read(&path)?;
            let Ok(archive) = PacArchive::parse(&bytes) else {
                continue;
            };
            let (Some(script_entry), Some(text_entry)) = (
                archive.find(SOFTPAL_SCRIPT_SRC_NAME),
                archive.find(SOFTPAL_TEXT_DAT_NAME),
            ) else {
                continue;
            };
            let script = archive
                .extract(&bytes, script_entry)
                .map_err(|err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.softpal.pac.extract SCRIPT.SRC: {err}").into()
                })?
                .to_vec();
            let textdat = archive
                .extract(&bytes, text_entry)
                .map_err(|err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.softpal.pac.extract TEXT.DAT: {err}").into()
                })?
                .to_vec();
            let source_ref = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(SOFTPAL_DATA_PAC_NAME)
                .to_string();
            return Ok(Some(SoftpalScripts {
                script,
                textdat,
                source_ref,
            }));
        }
        Ok(None)
    }

    /// Every `.pac` under `game_dir`, `data.pac` first, then lexical order —
    /// the deterministic probe order shared by resolution and inventory.
    pub(super) fn sorted_pac_paths(game_dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(game_dir) else {
            return Vec::new();
        };
        let mut pac_paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_file()
                    && path
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("pac"))
            })
            .collect();
        pac_paths.sort();
        pac_paths.sort_by_key(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(SOFTPAL_DATA_PAC_NAME))
        });
        pac_paths
    }
}
