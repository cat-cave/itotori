//! Env-gated execution proof over two private Siglus corpora.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    SiglusSecondLayerKey, decode_scene_chunk, decode_scene_flow, parse_scene_pck,
    recover_exe_angou_key,
};
use utsushi_siglus::scene_vm::{Moment, SceneProgram, VmError, VmState, execute_scene};

const FIRST: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

#[derive(Debug, Default, PartialEq, Eq)]
struct Totals {
    scenes: usize,
    instructions: usize,
    text: usize,
    choices: usize,
    overlap: usize,
    unsupported_syscalls: BTreeMap<(i32, i32), usize>,
    other_terminal_errors: BTreeMap<String, usize>,
}

#[test]
fn two_real_corpora_execute_deterministically_and_preserve_static_overlap() {
    let Some(first) = root(FIRST) else { return };
    let Some(second) = root(SECOND) else { return };
    for (label, root) in [("corpus-1", first), ("corpus-2", second)] {
        let one = execute_title(&root, label);
        let two = execute_title(&root, label);
        assert_eq!(one, two, "{label}: execution must be deterministic");
        assert!(one.instructions > 0, "{label}: no real instructions executed");
        assert!(one.overlap > 0, "{label}: no executed/static text overlap");
        eprintln!(
            "REAL {label}: scenes={} instructions={} text={} choices={} overlap={} unsupported_syscalls={:?} other_terminal_errors={:?}",
            one.scenes, one.instructions, one.text, one.choices, one.overlap,
            one.unsupported_syscalls, one.other_terminal_errors,
        );
    }
}

fn root(variable: &str) -> Option<PathBuf> {
    let root = std::env::var_os(variable).map(PathBuf::from)?;
    ["Scene.pck", "SiglusEngine.exe"]
        .iter()
        .all(|name| root.join(name).is_file())
        .then_some(root)
}

fn execute_title(root: &Path, label: &str) -> Totals {
    let pack = std::fs::read(root.join("Scene.pck")).expect("read scene pack");
    let executable = std::fs::read(root.join("SiglusEngine.exe")).expect("read executable");
    let index = parse_scene_pck(&pack).expect("parse scene pack");
    let key = recover_exe_angou_key(
        &executable,
        &SiglusSecondLayerKey::from_secret_ref(format!("secret://utsushi/{label}")),
    )
    .expect("recover scene key");
    let mut state = VmState::default();
    let mut totals = Totals { scenes: index.entries.len(), ..Totals::default() };
    for entry in index.entries {
        let start = entry.byte_offset as usize;
        let end = start + entry.byte_len as usize;
        let payload = decode_scene_chunk(
            entry.scene_id,
            &pack[start..end],
            index.extra_key_use,
            index.extra_key_use.then_some(key.material()),
        )
        .expect("decode scene");
        let program = SceneProgram::from_payload(entry.scene_id, &payload).expect("compile scene");
        let static_offsets = decode_scene_flow(&payload)
            .expect("decode static flow")
            .text_surfaces
            .into_iter()
            .filter(|surface| !surface.is_name)
            .map(|surface| surface.site_offset)
            .collect::<Vec<_>>();
        match execute_scene(&program, &mut state) {
            Ok(report) => record(&mut totals, report.instructions_executed, &report.moments, &static_offsets),
            Err(error) => match error {
                VmError::UnsupportedSyscall { function_id, return_form, .. } => {
                    *totals.unsupported_syscalls.entry((function_id, return_form)).or_default() += 1;
                }
                other => *totals.other_terminal_errors.entry(error_key(&other)).or_default() += 1,
            },
        }
    }
    totals
}

fn record(totals: &mut Totals, instructions: usize, moments: &[Moment], static_offsets: &[usize]) {
    totals.instructions += instructions;
    let mut prior = 0;
    for moment in moments {
        match moment {
            Moment::Text { offset, .. } => {
                totals.text += 1;
                let Some(position) = static_offsets.iter().position(|candidate| candidate == offset) else { panic!("executed text offset {offset} was absent from the static walk") };
                assert!(position >= prior, "executed text regressed in static order");
                prior = position;
                totals.overlap += 1;
            }
            Moment::Choice { .. } => totals.choices += 1,
        }
    }
}

fn error_key(error: &VmError) -> String {
    match error {
        VmError::UnsupportedOpcode { lead, .. } => format!("unsupported-opcode-{lead:02x}"),
        VmError::UnsupportedCommandTarget { .. } => "unsupported-command-target".to_string(),
        VmError::UnsupportedOperation { operation, .. } => format!("unsupported-operation-{operation}"),
        VmError::StackUnderflow { .. } => "stack-underflow".to_string(),
        VmError::UnresolvedJump { .. } => "unresolved-jump".to_string(),
        VmError::StepLimit { .. } => "step-limit".to_string(),
        VmError::UnsupportedSyscall { .. } => unreachable!("handled separately"),
    }
}
