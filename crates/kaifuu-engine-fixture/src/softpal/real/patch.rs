//! Softpal `patch`: map a `PatchExport` back to `TEXT.DAT` record pointers,
//! rebuild `TEXT.DAT` + repoint `SCRIPT.SRC` via `kaifuu-softpal`, and drop the
//! two rebuilt files as loose bytes into the output directory. That directory is
//! deployed as the game's `data\` override directory, which the PAL engine
//! resolves in preference to the `data.pac` archive (validated native-engine
//! behaviour — see `kaifuu_softpal::patchback`), so no PAC repack is needed.

use std::collections::BTreeSet;

use kaifuu_core::sha256_hash_bytes;
use kaifuu_softpal::{TextDat, TranslationMap, patchback};

use super::*;

impl SoftpalProfileDetectorAdapter {
    /// Parse a `softpal:dialogue:<ptr>` / `softpal:choice:<ptr>` unit key back to
    /// its `TEXT.DAT` record pointer.
    fn pointer_from_key(source_unit_key: &str) -> Option<u32> {
        source_unit_key
            .strip_prefix(DIALOGUE_KEY_PREFIX)
            .or_else(|| source_unit_key.strip_prefix(CHOICE_KEY_PREFIX))
            .and_then(|rest| rest.parse::<u32>().ok())
    }

    /// Run the real dialogue/choice patch-back: map every `PatchExport` entry
    /// back to its `TEXT.DAT` record pointer, rebuild `TEXT.DAT` + repoint
    /// `SCRIPT.SRC` via `kaifuu-softpal`, and drop both as loose files into
    /// `output_dir` (deployed as the engine's `data\` override directory, which
    /// the PAL engine loads in preference to `data.pac`). Unknown/stale entries
    /// are typed failures, never silent.
    pub(crate) fn run_patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let patch_export_id = request.patch_export.patch_export_id.clone();
        let scripts = Self::resolve_scripts(request.game_dir)?;
        let textdat =
            TextDat::parse(&scripts.textdat).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.textdat.parse: {err}").into()
            })?;
        let valid_offsets: BTreeSet<u32> = textdat
            .records
            .iter()
            .filter_map(|record| u32::try_from(record.offset).ok())
            .collect();

        let failed = |failures: Vec<AdapterFailure>| PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-patch", 12),
            patch_export_id: patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: content_hash(SOFTPAL_SUPPORT_BOUNDARY),
            failures,
        };

        let mut translations = TranslationMap::new();
        let mut failures = Vec::new();
        for entry in &request.patch_export.entries {
            match Self::pointer_from_key(&entry.source_unit_key) {
                Some(pointer) if valid_offsets.contains(&pointer) => {
                    translations.insert(pointer, entry.target_text.clone());
                }
                _ => failures.push(Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    "softpal",
                    entry.source_unit_key.clone(),
                    "PatchExportEntry sourceUnitKey does not resolve to a TEXT.DAT record pointer in this title",
                    "re-extract the bridge bundle before re-applying this patch",
                )),
            }
        }
        if !failures.is_empty() {
            return Ok(failed(failures));
        }

        let produced = match patchback(&scripts.textdat, &scripts.script, &translations) {
            Ok(produced) => produced,
            Err(err) => {
                return Ok(failed(vec![Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    "softpal",
                    SOFTPAL_SCRIPT_SRC_NAME,
                    format!("kaifuu.softpal.patchback failed: {err}"),
                    "verify every replacement encodes in cp932/Shift-JIS",
                )]));
            }
        };
        produced.write_loose_files(request.output_dir).map_err(
            |err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.patchback.write: {err}").into()
            },
        )?;

        let mut hash_input = produced.textdat.clone();
        hash_input.extend_from_slice(&produced.script);
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-patch", 12),
            patch_export_id,
            status: OperationStatus::Passed,
            output_hash: sha256_hash_bytes(&hash_input),
            failures: vec![],
        })
    }
}
