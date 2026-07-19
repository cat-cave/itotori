//! Softpal `extract`: disassemble the resolved `SCRIPT.SRC` + `TEXT.DAT` into a
//! localization [`BridgeBundle`] of dialogue + text-bearing-choice units.

use std::collections::BTreeSet;

use kaifuu_core::{AdapterWarning, BridgeBundle, BridgeUnit, PatchRef, sha256_hash_bytes};
use kaifuu_softpal::{ScriptScan, TextDat};

use super::*;

impl SoftpalProfileDetectorAdapter {
    /// Disassemble the resolved scripts and assemble the localization
    /// [`BridgeBundle`]: one unit per unique resolved `TEXT.DAT` record for the
    /// dialogue + text-bearing-choice surfaces, keyed by pointer for patch-back.
    pub(crate) fn build_bridge(
        scripts: &SoftpalScripts,
    ) -> KaifuuResult<(BridgeBundle, Vec<AdapterWarning>)> {
        let scan =
            ScriptScan::parse(&scripts.script).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.script.parse: {err}").into()
            })?;
        let textdat =
            TextDat::parse(&scripts.textdat).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.textdat.parse: {err}").into()
            })?;
        let disassembly = scan.resolve(&textdat);

        let mut units: Vec<BridgeUnit> = Vec::new();
        let mut seen: BTreeSet<u32> = BTreeSet::new();
        for dialogue in &disassembly.dialogue {
            let Some(text) = dialogue.text.resolved_text() else {
                continue;
            };
            if !seen.insert(dialogue.text.pointer) {
                continue;
            }
            let speaker = dialogue
                .speaker
                .as_ref()
                .and_then(|s| s.resolved_text())
                .unwrap_or_default()
                .to_string();
            units.push(Self::text_unit(
                DIALOGUE_KEY_PREFIX,
                dialogue.text.pointer,
                text,
                speaker,
                "dialogue",
            ));
        }
        let mut choice_seen: BTreeSet<u32> = BTreeSet::new();
        for choice in &disassembly.choices {
            let Some(text) = choice.text.resolved_text() else {
                continue;
            };
            if !choice_seen.insert(choice.text.pointer) {
                continue;
            }
            units.push(Self::text_unit(
                CHOICE_KEY_PREFIX,
                choice.text.pointer,
                text,
                String::new(),
                "choice_label",
            ));
        }

        // A dangling pointer (inside the pool, off a record boundary) is a
        // decode-integrity failure; on real bytes it is 0. Surface it as a
        // warning rather than silently dropping the affected line.
        let mut warnings = Vec::new();
        let dangling = disassembly.dangling_pointer_count();
        if dangling > 0 {
            warnings.push(AdapterWarning {
                code: "kaifuu.softpal.dangling_pointers".to_string(),
                message: format!(
                    "{dangling} TEXT.DAT pointer(s) fell inside the record pool but missed a \
                     record boundary; those lines were not emitted as units"
                ),
            });
        }

        let bridge = BridgeBundle {
            schema_version: "0.1.0".to_string(),
            bridge_id: deterministic_id("softpal-bridge", units.len()),
            source_bundle_hash: sha256_hash_bytes(&scripts.script),
            source_locale: "ja-JP".to_string(),
            extractor_name: "kaifuu-softpal".to_string(),
            extractor_version: env!("CARGO_PKG_VERSION").to_string(),
            units,
        };
        Ok((bridge, warnings))
    }

    fn text_unit(
        prefix: &str,
        pointer: u32,
        text: &str,
        speaker: String,
        text_surface: &str,
    ) -> BridgeUnit {
        let source_unit_key = format!("{prefix}{pointer}");
        BridgeUnit {
            bridge_unit_id: deterministic_id(&source_unit_key, pointer as usize),
            occurrence_id: source_unit_key.clone(),
            source_hash: content_hash(text),
            source_locale: "ja-JP".to_string(),
            source_text: text.to_string(),
            speaker,
            text_surface: text_surface.to_string(),
            protected_spans: vec![],
            patch_ref: PatchRef {
                asset_id: SCRIPT_ASSET_ID.to_string(),
                write_mode: "replace".to_string(),
                source_unit_key: source_unit_key.clone(),
            },
            source_unit_key,
        }
    }
}
