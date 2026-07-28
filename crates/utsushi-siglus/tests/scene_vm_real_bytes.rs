//! Env-gated execution-frontier report over two private Siglus corpora.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    SiglusSecondLayerKey, decode_scene_chunk, decode_scene_flow, parse_scene_pck,
    recover_exe_angou_key,
};
use utsushi_siglus::scene_vm::{
    ExecutionOutcome, Moment, SceneProgram, TitleProgram, VmError, VmState,
    execute_title_scene_observed, execute_title_scene_with_stage_objects_observed,
};

const FIRST: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

#[derive(Debug, Default, PartialEq, Eq)]
struct Totals {
    scenes: usize,
    static_text: usize,
    instructions: usize,
    text: usize,
    choices: usize,
    overlap: usize,
    entered: BTreeSet<u32>,
    entered_from_transfer: BTreeSet<u32>,
    depths: BTreeMap<u32, SceneDepth>,
    blockers: BTreeMap<String, Blocker>,
    stage_slots: usize,
    active_stage_objects: usize,
    identified_stage_objects: usize,
    geometry_stage_objects: usize,
    nondefault_position_stage_objects: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SceneDepth {
    instructions: usize,
    messages: usize,
    terminal: String,
    terminal_offset: Option<usize>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Blocker {
    entry_scenes: BTreeSet<u32>,
    first_stops: usize,
    unreached_instructions: usize,
    unreached_bytes: usize,
    offsets: BTreeMap<usize, usize>,
}

#[test]
fn two_real_corpora_report_the_execution_frontier_and_preserve_static_overlap() {
    let Some(first) = root(FIRST) else { return };
    let Some(second) = root(SECOND) else { return };
    for (label, root) in [("corpus 1", first), ("corpus 2", second)] {
        let one = execute_title(&root, label);
        let two = execute_title(&root, label);
        assert_eq!(
            one, two,
            "{label}: execution frontier must be deterministic"
        );
        assert_eq!(
            one.entered.len(),
            one.scenes,
            "{label}: every archive entry ran"
        );
        assert!(
            one.instructions > 0,
            "{label}: no real instructions executed"
        );
        let expected_instructions = match label {
            "corpus 1" => 66_191,
            "corpus 2" => 75_719,
            _ => unreachable!("fixed real-corpus labels"),
        };
        assert_eq!(
            one.instructions, expected_instructions,
            "{label}: stage state must not alter the pinned narrative execution total"
        );
        assert_eq!(
            one.text, one.overlap,
            "{label}: execution emitted text outside the static sequence"
        );
        assert!(
            !one.blockers.is_empty(),
            "{label}: the VM must report terminal diagnostics rather than silently skipping them"
        );
        assert!(
            one.active_stage_objects > 0,
            "{label}: no active stage object was produced from real bytes"
        );
        assert_eq!(
            one.active_stage_objects, one.identified_stage_objects,
            "{label}: every active stage object needs source identity"
        );
        assert!(
            one.nondefault_position_stage_objects > 0,
            "{label}: real OBJECT.CREATE coordinates must populate at least one active object"
        );
        print_report(label, &one);
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
        let offsets = decode_scene_flow(&payload)
            .expect("decode static flow")
            .text_surfaces
            .into_iter()
            .filter(|surface| !surface.is_name)
            .map(|surface| surface.site_offset)
            .collect::<Vec<_>>();
        totals.static_text += offsets.len();
        static_offsets.insert(entry.scene_id, offsets);
        programs.push(program);
    }
    let program = TitleProgram::from_scenes_with_names(
        programs,
        scene_names.into_iter().collect(),
        &index.included_commands,
    )
    .expect("validate archive-level function table");
    let mut state = VmState::default();
    for entry in &index.entries {
        let outcome = execute_title_scene_observed(&program, entry.scene_id, &mut state)
            .expect("entry scene is present");
        record(
            &mut totals,
            entry.scene_id,
            outcome,
            &program,
            &static_offsets,
        );
    }
    let mut stage_state = VmState::default();
    for entry in &index.entries {
        execute_title_scene_with_stage_objects_observed(&program, entry.scene_id, &mut stage_state)
            .expect("entry scene is present");
    }
    record_stage_objects(&mut totals, &stage_state);
    totals
}

fn record_stage_objects(totals: &mut Totals, state: &VmState) {
    let objects = state
        .stage_objects
        .values()
        .flat_map(|slots| slots.values());
    totals.stage_slots = objects.clone().count();
    let active = objects.filter(|object| object.active).collect::<Vec<_>>();
    totals.active_stage_objects = active.len();
    totals.identified_stage_objects = active
        .iter()
        .filter(|object| object.identity.is_some())
        .count();
    totals.geometry_stage_objects = active.len();
    totals.nondefault_position_stage_objects = active
        .iter()
        .filter(|object| object.geometry.x != 0 || object.geometry.y != 0 || object.geometry.z != 0)
        .count();
}

fn record(
    totals: &mut Totals,
    entry_scene: u32,
    outcome: ExecutionOutcome,
    program: &TitleProgram,
    static_offsets: &BTreeMap<u32, Vec<usize>>,
) {
    let (report, terminal) = match outcome {
        ExecutionOutcome::Complete(report) => (report, None),
        ExecutionOutcome::Terminal { report, error } => (report, Some(diagnostic(&error))),
    };
    totals.entered.extend(report.scenes_entered.iter().copied());
    totals.entered_from_transfer.extend(
        report
            .scenes_entered
            .iter()
            .copied()
            .filter(|scene_id| *scene_id != entry_scene),
    );
    totals.instructions += report.instructions_executed;
    let messages = record_moments(totals, &report.moments, static_offsets);
    let (terminal, terminal_offset) = terminal.map_or_else(
        || ("complete".to_string(), None),
        |(reason, scene_id, offset)| {
            let (instructions, bytes) = program
                .scene(scene_id)
                .expect("terminal scene is in title program")
                .unreached_after(offset);
            let blocker = totals.blockers.entry(reason.clone()).or_default();
            blocker.entry_scenes.insert(entry_scene);
            blocker.first_stops += usize::from(report.instructions_executed == 1);
            blocker.unreached_instructions += instructions;
            blocker.unreached_bytes += bytes;
            *blocker.offsets.entry(offset).or_default() += 1;
            (reason, Some(offset))
        },
    );
    totals.depths.insert(
        entry_scene,
        SceneDepth {
            instructions: report.instructions_executed,
            messages,
            terminal,
            terminal_offset,
        },
    );
}

fn record_moments(
    totals: &mut Totals,
    moments: &[Moment],
    static_offsets: &BTreeMap<u32, Vec<usize>>,
) -> usize {
    let mut messages = 0;
    let mut prior = BTreeMap::new();
    for moment in moments {
        match moment {
            Moment::Text {
                scene_id, offset, ..
            } => {
                messages += 1;
                totals.text += 1;
                let scene_offsets = static_offsets
                    .get(scene_id)
                    .expect("executed text scene was absent from static walk");
                let position = scene_offsets
                    .iter()
                    .position(|candidate| candidate == offset)
                    .expect("executed text offset was absent from static walk");
                let prior_offset = prior.entry(*scene_id).or_insert(0);
                assert!(
                    position >= *prior_offset,
                    "executed text regressed in static order"
                );
                *prior_offset = position;
                totals.overlap += 1;
            }
            Moment::Choice { .. } => totals.choices += 1,
        }
    }
    messages
}

fn diagnostic(error: &VmError) -> (String, u32, usize) {
    match error {
        VmError::UnsupportedOpcode {
            scene_id,
            offset,
            lead,
        } => (format!("unsupported-opcode-{lead:02x}"), *scene_id, *offset),
        VmError::UnsupportedSyscall {
            scene_id,
            offset,
            function_id,
            return_form,
        } => (
            format!("unsupported-syscall-{function_id}-form-{return_form}"),
            *scene_id,
            *offset,
        ),
        VmError::UnsupportedCommandTarget { scene_id, offset } => {
            ("unsupported-command-target".to_string(), *scene_id, *offset)
        }
        VmError::UnsupportedScriptFunction {
            scene_id,
            offset,
            function_id,
        } => (
            format!("unsupported-script-function-{function_id}"),
            *scene_id,
            *offset,
        ),
        VmError::UnsupportedOperation {
            scene_id,
            offset,
            operation,
        } => (
            format!("unsupported-operation-{operation}"),
            *scene_id,
            *offset,
        ),
        VmError::UnsupportedStageObjectProperty {
            scene_id,
            offset,
            property,
        } => (
            format!("unsupported-stage-object-property-{property}"),
            *scene_id,
            *offset,
        ),
        VmError::StackUnderflow { scene_id, offset } => {
            ("stack-underflow".to_string(), *scene_id, *offset)
        }
        VmError::UnresolvedJump {
            scene_id, offset, ..
        } => ("unresolved-jump".to_string(), *scene_id, *offset),
        VmError::StepLimit { scene_id, .. } => ("step-limit".to_string(), *scene_id, 0),
    }
}

fn print_report(label: &str, totals: &Totals) {
    let mut ranked = totals.blockers.iter().collect::<Vec<_>>();
    ranked.sort_by_key(|(_, blocker)| {
        std::cmp::Reverse((blocker.unreached_instructions, blocker.unreached_bytes))
    });
    eprintln!(
        "REAL {label} frontier: direct_scenes_entered={}/{} transfer_scenes_entered={} instructions={} messages={} choices={} overlap={}/{} stage_slots={} active_objects={} identities={}/{} geometry={}/{} nondefault_position={}/{}",
        totals.entered.len(),
        totals.scenes,
        totals.entered_from_transfer.len(),
        totals.instructions,
        totals.text,
        totals.choices,
        totals.overlap,
        totals.static_text,
        totals.stage_slots,
        totals.active_stage_objects,
        totals.identified_stage_objects,
        totals.active_stage_objects,
        totals.geometry_stage_objects,
        totals.active_stage_objects,
        totals.nondefault_position_stage_objects,
        totals.active_stage_objects,
    );
    eprintln!(
        "REAL {label} depth_distribution: instructions={:?} messages={:?}",
        distribution(totals.depths.values().map(|depth| depth.instructions)),
        distribution(totals.depths.values().map(|depth| depth.messages)),
    );
    for (reason, blocker) in ranked {
        eprintln!(
            "REAL {label} blocker={reason} scenes={} first_stops={} unreached_instructions={} unreached_bytes={} offsets={:?}",
            blocker.entry_scenes.len(),
            blocker.first_stops,
            blocker.unreached_instructions,
            blocker.unreached_bytes,
            blocker.offsets,
        );
    }
}

fn distribution(values: impl Iterator<Item = usize>) -> [usize; 4] {
    let mut values = values.collect::<Vec<_>>();
    values.sort_unstable();
    let last = values.len().saturating_sub(1);
    [
        values[0],
        values[last / 2],
        values[last.saturating_mul(9) / 10],
        values[last],
    ]
}
