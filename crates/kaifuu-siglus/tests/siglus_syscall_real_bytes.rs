//! Env-gated real-bytes proof for the siglus-11 `CD_COMMAND` decoder.
//!
//! The two roots are private local inputs. The assertions and summaries carry
//! only function ids, counts, offsets, and string-table references — never
//! decoded title text or retail filenames.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    SiglusSecondLayerKey, SiglusSyscallDiagnostic, decode_scene_chunk, decode_scene_flow,
    decode_scene_syscalls, parse_scene_pck, recover_exe_angou_key,
};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";
const EXPECTED_SCENE_COUNTS: [usize; 2] = [298, 278];

fn title_paths(variable: &str) -> Option<(PathBuf, PathBuf)> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus syscall real bytes: {variable} is unset");
        None
    })?;
    let root = PathBuf::from(value);
    let dir = if root.is_dir() {
        root
    } else {
        root.parent().map(Path::to_path_buf).unwrap_or(root)
    };
    let exe = dir.join("SiglusEngine.exe");
    let scene = dir.join("Scene.pck");
    if exe.is_file() && scene.is_file() {
        Some((exe, scene))
    } else {
        eprintln!("SKIP siglus syscall real bytes: {variable} has no SiglusEngine.exe + Scene.pck");
        None
    }
}

#[derive(Default)]
struct TitleTotals {
    scene_count: usize,
    typed_calls: usize,
    selections: usize,
    options: usize,
    unknown_arg_shapes: BTreeMap<i32, usize>,
    unknown_target_shapes: usize,
}

fn reported_unknown_shapes(decode: &kaifuu_siglus::SceneSyscallDecode) -> BTreeMap<i32, usize> {
    decode
        .diagnostics
        .iter()
        .filter_map(|diagnostic| match diagnostic {
            SiglusSyscallDiagnostic::UnknownSyscallArgShape { function_id, count } => {
                Some((*function_id, *count))
            }
            _ => None,
        })
        .collect()
}

fn reported_unknown_target_count(decode: &kaifuu_siglus::SceneSyscallDecode) -> usize {
    decode
        .diagnostics
        .iter()
        .find_map(|diagnostic| match diagnostic {
            SiglusSyscallDiagnostic::UnknownSyscallTargetShape { count } => Some(*count),
            _ => None,
        })
        .unwrap_or(0)
}

fn exercise_title(exe_path: &Path, scene_path: &Path, label: &str) -> TitleTotals {
    let exe_bytes = std::fs::read(exe_path).expect("read real SiglusEngine.exe");
    let scene_bytes = std::fs::read(scene_path).expect("read real Scene.pck");
    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/exe-angou"));
    let recovery = recover_exe_angou_key(&exe_bytes, &key_ref)
        .unwrap_or_else(|error| panic!("{label}: exe-angou key recovery failed: {error}"));
    let index = parse_scene_pck(&scene_bytes).expect("real Scene.pck envelope parses");
    let mut totals = TitleTotals {
        scene_count: index.entries.len(),
        ..TitleTotals::default()
    };

    for entry in &index.entries {
        let start = entry.byte_offset as usize;
        let chunk = &scene_bytes[start..start + entry.byte_len as usize];
        let payload = decode_scene_chunk(
            entry.scene_id,
            chunk,
            index.extra_key_use,
            Some(recovery.material()),
        )
        .unwrap_or_else(|error| panic!("{label}: scene {} decode failed: {error}", entry.scene_id));
        let decode = decode_scene_syscalls(&payload).unwrap_or_else(|error| {
            panic!(
                "{label}: scene {} syscall decode failed: {error}",
                entry.scene_id
            )
        });
        let flow = decode_scene_flow(&payload).unwrap_or_else(|error| {
            panic!(
                "{label}: scene {} flow decode failed: {error}",
                entry.scene_id
            )
        });

        assert!(
            decode.commands_fully_typed(),
            "{label}: scene {} left command operand bytes opaque ({}/{})",
            entry.scene_id,
            decode.typed_command_operand_bytes,
            decode.total_command_operand_bytes
        );
        assert_eq!(
            decode.calls.len(),
            flow.family_count("command"),
            "{label}: scene {} missed a CD_COMMAND site",
            entry.scene_id
        );
        assert_eq!(
            decode,
            decode_scene_syscalls(&payload).expect("re-decode"),
            "{label}: scene {} syscall decode is not deterministic",
            entry.scene_id
        );

        assert_eq!(
            reported_unknown_shapes(&decode),
            decode.unknown_arg_shape_counts,
            "{label}: scene {} has an unreported unknown function shape",
            entry.scene_id
        );
        let actual_unknown_targets = decode
            .calls
            .iter()
            .filter(|call| call.target.system_function_id().is_none())
            .count();
        assert_eq!(
            reported_unknown_target_count(&decode),
            actual_unknown_targets,
            "{label}: scene {} has an unreported non-system call target",
            entry.scene_id
        );
        assert!(
            !decode.diagnostics.iter().any(|diagnostic| matches!(
                diagnostic,
                SiglusSyscallDiagnostic::UnresolvedSelOptionStringRef { .. }
            )),
            "{label}: scene {} left an unresolved sel option string reference",
            entry.scene_id
        );

        for selection in &decode.selections {
            assert!(
                !selection.options.is_empty(),
                "{label}: scene {} sel at {} has no extractable options",
                entry.scene_id,
                selection.call_offset
            );
            if let Some(structural_index) = selection.structural_choice_index {
                let option_arm_count = flow.choice_units[structural_index]
                    .arms
                    .iter()
                    .filter(|arm| arm.compare_value > 0)
                    .count();
                assert_eq!(
                    selection
                        .options
                        .iter()
                        .filter(|option| option.structural_arm_index.is_some())
                        .count(),
                    option_arm_count,
                    "{label}: scene {} sel at {} did not link every structural option arm",
                    entry.scene_id,
                    selection.call_offset
                );
            }
            for option in &selection.options {
                assert!(
                    option.text.byte_offset + option.text.char_len as usize * 2 <= payload.len(),
                    "{label}: scene {} sel option span is out of bounds",
                    entry.scene_id
                );
            }
        }

        totals.typed_calls += decode.calls.len();
        totals.selections += decode.selections.len();
        totals.options += decode
            .selections
            .iter()
            .map(|selection| selection.options.len())
            .sum::<usize>();
        totals.unknown_target_shapes += actual_unknown_targets;
        for (function_id, count) in &decode.unknown_arg_shape_counts {
            *totals.unknown_arg_shapes.entry(*function_id).or_insert(0) += count;
        }
    }

    eprintln!(
        "REAL {label}: typed_calls={} sel_calls={} sel_options={} unknown_arg_shapes={:?} unknown_target_shapes={}",
        totals.typed_calls,
        totals.selections,
        totals.options,
        totals.unknown_arg_shapes,
        totals.unknown_target_shapes
    );
    totals
}

#[test]
fn two_real_siglus_scene_packs_decode_all_system_calls() {
    let Some((first_exe, first_scene)) = title_paths(FIRST_TITLE_ENV) else {
        return;
    };
    let Some((second_exe, second_scene)) = title_paths(SECOND_TITLE_ENV) else {
        return;
    };
    let first = exercise_title(&first_exe, &first_scene, "siglus-title-one");
    let second = exercise_title(&second_exe, &second_scene, "siglus-title-two");

    for (label, totals) in [("siglus-title-one", &first), ("siglus-title-two", &second)] {
        assert!(totals.typed_calls > 0, "{label}: no typed CD_COMMAND calls");
        assert!(totals.selections > 0, "{label}: no System{{76}} sel calls");
        assert!(totals.options > 0, "{label}: no sel option references");
    }
    let mut observed = [first.scene_count, second.scene_count];
    let mut expected = EXPECTED_SCENE_COUNTS;
    observed.sort_unstable();
    expected.sort_unstable();
    assert_eq!(observed, expected, "unexpected real scene counts");
}
