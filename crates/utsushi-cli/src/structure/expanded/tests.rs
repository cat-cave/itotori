//! Synthetic regression coverage for the Bridge v0.2 → v2 choice join
//! (`choice_units_by_command`). The real-bytes proof lives in the periodic
//! oracle (`structure_real_sweetie_hd.rs`); these tests pin the join contract
//! on a minimal `module_sel` fixture so the 69 MB archive is never needed.
//!
//! Root cause these tests guard: a select block's options each live at their
//! OWN scene byte offset. A pre-#219 kaifuu anchored every option at the
//! Choice COMMAND opener instead, so all options in a `select` collided on one
//! offset — the join is offset-keyed and (correctly) fails loud on that
//! ambiguity. `#219` fixed the extraction to stamp per-option offsets; the two
//! tests below pin BOTH halves: the well-formed join threads distinct offsets,
//! and the stale-shape collision still fails loud (never silently drops a real
//! translatable option).

use super::*;
use crate::structure::bridge::ChoiceRef;
use serde_json::json;

/// A standalone `module_sel` select command: an 8-byte command header, then a
/// `{ … }` SelectElement block with two options "A" and "B", each followed by
/// its `\n`+i16 line marker. `decode_select` anchors each option at the byte
/// offset of its own text (9 and 13 here), never the command opener (0).
fn select_block_bytecode() -> Vec<u8> {
    let mut bytecode = vec![0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00];
    bytecode.push(b'{');
    bytecode.push(b'A');
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]);
    bytecode.push(b'B');
    bytecode.extend_from_slice(&[0x0a, 0x07, 0x00]);
    bytecode.push(b'}');
    bytecode
}

fn choice_unit(id: &str, byte_start: u64, byte_end: u64, option_index: u16) -> BridgeUnit {
    BridgeUnit {
        id: id.to_string(),
        source_unit_key: format!("reallive:scene-0001#{option_index:04}"),
        surface_kind: "choice_label".to_string(),
        source_text: String::new(),
        source_asset: json!({ "assetId": "asset-test" }),
        byte_start,
        byte_end,
        character_id: None,
        color: None,
        choice: Some(ChoiceRef {
            group_id: "group-1".to_string(),
            choice_id: format!("choice-{option_index}"),
            option_index,
        }),
    }
}

fn decoded_choices(bytecode: &[u8]) -> Vec<kaifuu_reallive::CommandArg> {
    parse_real_bytecode_spans(bytecode)
        .expect("select block decodes")
        .iter()
        .find_map(|(opcode, _)| match opcode {
            RealLiveOpcode::Choice { choices } => Some(choices.clone()),
            _ => None,
        })
        .expect("bytecode carries a Choice command")
}

#[test]
fn choice_join_threads_distinct_per_option_offsets() {
    let bytecode = select_block_bytecode();
    let choices = decoded_choices(&bytecode);
    assert_eq!(choices.len(), 2, "select block decodes to two options");
    // The #219 contract: each option is anchored at its OWN byte offset, not
    // the shared command opener — this is what makes the offset-keyed join
    // unambiguous.
    assert_ne!(
        choices[0].byte_offset, choices[1].byte_offset,
        "distinct per-option offsets"
    );

    let units = vec![
        choice_unit(
            "unit-0",
            choices[0].byte_offset,
            choices[0].byte_offset + choices[0].bytes.len() as u64,
            0,
        ),
        choice_unit(
            "unit-1",
            choices[1].byte_offset,
            choices[1].byte_offset + choices[1].bytes.len() as u64,
            1,
        ),
    ];

    let groups = choice_units_by_command(&bytecode, &units).expect("well-formed choice join");
    assert_eq!(groups.len(), 1, "one select command => one group");
    let group = groups.values().next().expect("the single group");
    let ordered: Vec<(u16, &str)> = group
        .iter()
        .map(|unit| {
            (
                unit.choice.as_ref().expect("choice ref").option_index,
                unit.id.as_str(),
            )
        })
        .collect();
    assert_eq!(
        ordered,
        vec![(0, "unit-0"), (1, "unit-1")],
        "both options matched, ordered by option_index"
    );
}

#[test]
fn choice_join_rejects_shared_offset_the_stale_bridge_shape() {
    // A pre-#219 bridge anchored every select option at the Choice command
    // opener, so two options shared one byte offset. The offset-keyed join
    // must FAIL LOUD on that ambiguity — never silently drop or merge a real
    // translatable option.
    let bytecode = select_block_bytecode();
    let shared = decoded_choices(&bytecode)[0].byte_offset;
    let units = vec![
        choice_unit("unit-0", shared, shared + 2, 0),
        choice_unit("unit-1", shared, shared + 2, 1),
    ];

    let err = choice_units_by_command(&bytecode, &units)
        .expect_err("shared offset must be rejected, not silently merged");
    assert!(
        err.contains(&format!("share byte offset {shared}"))
            && err.contains("unit-0")
            && err.contains("unit-1"),
        "diagnostic must name the offset and both colliding units: {err}"
    );
}
