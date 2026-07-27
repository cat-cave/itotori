//! Env-gated execution proof over two private Siglus corpora.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    SiglusExpr, SiglusSecondLayerKey, decode_scene_chunk, decode_scene_flow, decode_scene_syscalls,
    parse_scene_pck, recover_exe_angou_key,
};
use utsushi_siglus::scene_vm::{
    ExecutionOutcome, Moment, SceneProgram, TitleProgram, VmError, VmState,
    execute_title_scene_observed,
};

const FIRST: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

#[derive(Debug, Default, PartialEq, Eq)]
struct Totals {
    scenes: usize,
    static_text: usize,
    instructions: usize,
    text: usize,
    text_nonempty: usize,
    speakers: usize,
    choices: usize,
    choice_options: usize,
    overlap: usize,
    unsupported_syscalls: BTreeMap<(i32, i32), usize>,
    other_terminal_errors: BTreeMap<String, usize>,
    farcall_sites: usize,
    farcall_scene_names: usize,
}

#[test]
fn two_real_corpora_execute_deterministically_and_preserve_static_overlap() {
    let Some(first) = root(FIRST) else { return };
    let Some(second) = root(SECOND) else { return };
    for (label, root) in [("corpus-1", first), ("corpus-2", second)] {
        let one = execute_title(&root, label);
        let two = execute_title(&root, label);
        assert_eq!(one, two, "{label}: execution must be deterministic");
        eprintln!(
            "REAL {label}: scenes={} instructions={} text={} choices={} overlap={} farcall_scene_names={}/{} unsupported_syscalls={:?} other_terminal_errors={:?}",
            one.scenes,
            one.instructions,
            one.text,
            one.choices,
            one.overlap,
            one.farcall_scene_names,
            one.farcall_sites,
            one.unsupported_syscalls,
            one.other_terminal_errors,
        );
        assert!(
            one.instructions > 0,
            "{label}: no real instructions executed"
        );
        assert_eq!(
            one.text, one.overlap,
            "{label}: execution emitted text outside the static sequence"
        );
        assert!(
            !one.unsupported_syscalls.is_empty() || !one.other_terminal_errors.is_empty(),
            "{label}: the VM must report its terminal state rather than silently skipping it"
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
    let mut totals = Totals {
        scenes: index.entries.len(),
        ..Totals::default()
    };
    let mut programs = Vec::with_capacity(index.entries.len());
    let scene_names = index
        .entries
        .iter()
        .filter_map(|entry| entry.scene_name.clone().map(|name| (name, entry.scene_id)))
        .collect::<BTreeMap<_, _>>();
    let mut static_offsets = BTreeMap::new();
    for entry in &index.entries {
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
        for call in decode_scene_syscalls(&payload)
            .expect("decode syscall shapes")
            .calls
            .into_iter()
            .filter(|call| call.target.system_function_id() == Some(5))
        {
            totals.farcall_sites += 1;
            if let [SiglusExpr::Str { index }] = call.args.as_slice()
                && program
                    .string(*index)
                    .is_some_and(|name| scene_names.contains_key(name))
            {
                totals.farcall_scene_names += 1;
            }
        }
        programs.push(program);
        let offsets = decode_scene_flow(&payload)
            .expect("decode static flow")
            .text_surfaces
            .into_iter()
            .filter(|surface| !surface.is_name)
            .map(|surface| surface.site_offset)
            .collect::<Vec<_>>();
        totals.static_text += offsets.len();
        static_offsets.insert(entry.scene_id, offsets);
    }
    let program = TitleProgram::from_scenes_with_names(
        programs,
        scene_names.into_iter().collect(),
        &index.included_commands,
    )
    .expect("validate archive-level function table");
    let mut state = VmState::default();
    for entry in &index.entries {
        match execute_title_scene_observed(&program, entry.scene_id, &mut state)
            .expect("entry scene is present")
        {
            ExecutionOutcome::Complete(report) => record(
                &mut totals,
                report.instructions_executed,
                &report.moments,
                &static_offsets,
            ),
            ExecutionOutcome::Terminal { report, error } => {
                record(
                    &mut totals,
                    report.instructions_executed,
                    &report.moments,
                    &static_offsets,
                );
                match error {
                    VmError::UnsupportedSyscall {
                        function_id,
                        return_form,
                        ..
                    } => {
                        *totals
                            .unsupported_syscalls
                            .entry((function_id, return_form))
                            .or_default() += 1;
                    }
                    other => {
                        *totals
                            .other_terminal_errors
                            .entry(error_key(&other))
                            .or_default() += 1;
                    }
                }
            }
        }
    }
    eprintln!("REAL {label} pass: {totals:?}");
    totals
}

fn record(
    totals: &mut Totals,
    instructions: usize,
    moments: &[Moment],
    static_offsets: &BTreeMap<u32, Vec<usize>>,
) {
    totals.instructions += instructions;
    let mut prior = BTreeMap::new();
    for moment in moments {
        match moment {
            Moment::Text {
                scene_id,
                offset,
                speaker,
                text,
            } => {
                totals.text += 1;
                totals.text_nonempty += usize::from(!text.is_empty());
                totals.speakers += usize::from(speaker.is_some());
                let Some(scene_offsets) = static_offsets.get(scene_id) else {
                    panic!("executed text scene {scene_id} was absent from static walk")
                };
                let Some(position) = scene_offsets
                    .iter()
                    .position(|candidate| candidate == offset)
                else {
                    panic!("executed text offset {offset} was absent from the static walk")
                };
                let prior_offset = prior.entry(*scene_id).or_insert(0);
                assert!(
                    position >= *prior_offset,
                    "executed text regressed in static order"
                );
                *prior_offset = position;
                totals.overlap += 1;
            }
            Moment::Choice { options, .. } => {
                totals.choices += 1;
                totals.choice_options += options.len();
            }
        }
    }
}

fn error_key(error: &VmError) -> String {
    match error {
        VmError::UnsupportedOpcode { lead, .. } => format!("unsupported-opcode-{lead:02x}"),
        VmError::UnsupportedCommandTarget { .. } => "unsupported-command-target".to_string(),
        VmError::UnsupportedScriptFunction { function_id, .. } => {
            format!("unsupported-script-function-{function_id}")
        }
        VmError::UnsupportedOperation { operation, .. } => {
            format!("unsupported-operation-{operation}")
        }
        VmError::StackUnderflow { .. } => "stack-underflow".to_string(),
        VmError::UnresolvedJump { .. } => "unresolved-jump".to_string(),
        VmError::StepLimit { .. } => "step-limit".to_string(),
        VmError::UnsupportedSyscall { .. } => unreachable!("handled separately"),
    }
}
