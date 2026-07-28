//! Softpal `extract`: disassemble the resolved `SCRIPT.SRC` + `TEXT.DAT` into a
//! localization [`BridgeBundle`] of dialogue + text-bearing-choice units.

use std::collections::BTreeSet;

use kaifuu_core::{
    AdapterWarning, BridgeBundle, BridgeUnit, BridgeUnitContext, BridgeUnitRoute, PatchRef,
    sha256_hash_bytes,
};
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
            context: Some(BridgeUnitContext {
                route: BridgeUnitRoute {
                    scene_id: SCRIPT_SCENE_ID.to_string(),
                },
            }),
            patch_ref: PatchRef {
                asset_id: SCRIPT_ASSET_ID.to_string(),
                write_mode: "replace".to_string(),
                source_unit_key: source_unit_key.clone(),
            },
            source_unit_key,
        }
    }
}

#[cfg(test)]
mod tests {
    use kaifuu_softpal::{
        SCRIPT_MAGIC_PREFIX, TEXT_SHOW_WORD_HI, TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL,
    };

    use super::*;

    fn opcode(id: u16) -> [u8; 4] {
        let mut token = [0; 4];
        token[..2].copy_from_slice(&id.to_le_bytes());
        token[2..].copy_from_slice(&1_u16.to_le_bytes());
        token
    }

    fn word(value: u32) -> [u8; 4] {
        value.to_le_bytes()
    }

    fn target(category: u16, function: u16) -> u32 {
        (u32::from(category) << 16) | u32::from(function)
    }

    /// A minimal, decoded Softpal source pair: the script pushes the real
    /// TEXT.DAT record pointer and invokes TEXT-SHOW.  This deliberately
    /// exercises the production decoder before checking the coordinate.
    fn decoded_source_pair() -> SoftpalScripts {
        let mut textdat = vec![TEXTDAT_FLAG_PLAINTEXT];
        textdat.extend_from_slice(TEXTDAT_MAGIC_TAIL);
        textdat.extend_from_slice(&2_u32.to_le_bytes());
        let text_pointer = textdat.len() as u32;
        textdat.extend_from_slice(&0_u32.to_le_bytes());
        textdat.extend_from_slice(b"decoded line\0");
        let speaker_pointer = textdat.len() as u32;
        textdat.extend_from_slice(&1_u32.to_le_bytes());
        textdat.extend_from_slice(b"decoded speaker\0");

        let mut script = Vec::new();
        script.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        script.extend_from_slice(b"20");
        script.extend_from_slice(&[0; 8]);
        for token in [
            opcode(0x1f),
            word(text_pointer),
            opcode(0x1f),
            word(speaker_pointer),
            opcode(0x1f),
            word(0),
            opcode(0x17),
            word(target(TEXT_SHOW_WORD_HI, 2)),
            word(0),
        ] {
            script.extend_from_slice(&token);
        }

        SoftpalScripts {
            script,
            textdat,
            source_ref: "decoded-test-pair".to_string(),
        }
    }

    #[test]
    fn decoded_script_units_declare_the_structure_script_scene() {
        let (bridge, warnings) =
            SoftpalProfileDetectorAdapter::build_bridge(&decoded_source_pair())
                .expect("decoded Softpal fixture extracts");

        assert!(warnings.is_empty());
        assert_eq!(bridge.units.len(), 1);
        let unit = &bridge.units[0];
        assert_eq!(unit.source_text, "decoded line");
        assert_eq!(unit.source_unit_key, format!("{DIALOGUE_KEY_PREFIX}16"));
        assert_eq!(
            unit.context
                .as_ref()
                .map(|context| context.route.scene_id.as_str()),
            Some(SCRIPT_SCENE_ID),
        );
    }
}
