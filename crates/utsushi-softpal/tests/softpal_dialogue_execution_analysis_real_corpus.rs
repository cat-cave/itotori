//! Text-free evidence for the dialogue-execution investigation.
//!
//! This test deliberately reports offsets, dispatch keys, state-shape counts,
//! and hashes only.  It must never print private dialogue, speaker, or choice
//! payloads while exercising the staged retail inputs.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{CommandFamily, OpcodeScan, PacArchive, ScriptScan, TextDat};
use utsushi_softpal::{RuntimeTraceEvent, SoftpalScene};

const CORPORA: [&str; 2] = ["/scratch/corpus/softpal-1", "/scratch/corpus/softpal-2"];

struct Inputs {
    archive: Vec<u8>,
    csv_pac: Vec<u8>,
    script: Vec<u8>,
    textdat: Vec<u8>,
    points: Vec<u8>,
    mem_dat: Vec<u8>,
}

fn inputs(root: &Path) -> Option<Inputs> {
    let archive_bytes = fs::read(root.join("data.pac")).ok()?;
    let archive = PacArchive::parse(&archive_bytes).ok()?;
    let extract = |name| {
        archive
            .find(name)
            .and_then(|entry| archive.extract(&archive_bytes, entry).ok())
            .map(ToOwned::to_owned)
    };
    let script = extract("SCRIPT.SRC")?;
    let textdat = extract("TEXT.DAT")?;
    let points = extract("POINT.DAT")?;
    let mem_dat = extract("MEM.DAT")?;
    Some(Inputs {
        archive: archive_bytes,
        csv_pac: fs::read(root.join("csv.pac")).ok()?,
        script,
        textdat,
        points,
        mem_dat,
    })
}

/// POINT.DAT offsets are relative to the 12-byte program header and ordered
/// backwards on disk. This is intentionally a local, read-only decoder: the
/// experiment needs only the CFG edge set, not a new runtime entry surface.
fn point_offsets(bytes: &[u8]) -> Vec<usize> {
    assert!(bytes.len() >= 16);
    assert!(matches!(
        &bytes[..16],
        b"$POINT_LIST_****" | b"_POINT_LIST_****"
    ));
    let encrypted = bytes[0] == b'$'
        && bytes.get(16..20).is_some_and(|word| {
            u32::from_le_bytes(word.try_into().expect("four bytes")) & 0xff00_0000 != 0
        });
    let mut offsets = Vec::new();
    let mut shift = 4_u32;
    for chunk in bytes[16..].chunks_exact(4) {
        let mut raw = u32::from_le_bytes(chunk.try_into().expect("four bytes"));
        if encrypted {
            let mut parts = raw.to_le_bytes();
            parts[0] = parts[0].rotate_left(shift);
            raw = u32::from_le_bytes(parts) ^ 0x084d_f873 ^ 0xff98_7dee;
            shift = (shift + 1) % 8;
        }
        offsets.push(raw as usize + 12);
    }
    offsets.reverse();
    offsets
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ControlState {
    ip: usize,
    returns: Vec<usize>,
    work_process_attached: bool,
}

struct CfgResult {
    states: usize,
    edges: usize,
    max_return_depth: usize,
    reachable_messages: Vec<usize>,
    reachable_selects: Vec<usize>,
    root_returns_after_attachment: usize,
    ends_after_attachment: usize,
    terminals_without_attachment: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CallContract {
    category: u16,
    function: u16,
    stack_depth: usize,
    destination_tag: Option<u8>,
    return_value: Option<i32>,
    bank_writes: Vec<(u8, u32)>,
}

/// Explore only script semantics: branches fork, script calls/returns retain a
/// bounded return stack, and every native call is an opaque *normal return*.
/// An end opcode and a root return have no invented successor. This is
/// precisely the feasibility question: can SCRIPT.SRC itself get to a real
/// message syscall, or does it instead terminate after attaching a native work
/// process that has no script-visible resumption target?
fn script_only_cfg(script: &[u8], points: &[u8]) -> CfgResult {
    let scan = OpcodeScan::parse(script).expect("opcode scan");
    assert!(
        scan.is_exhaustive(),
        "the CFG requires an exhaustive opcode scan"
    );
    let labels = if scan
        .instructions
        .iter()
        .any(|instruction| matches!(instruction.opcode.id(), 0x09..=0x0b))
    {
        point_offsets(points)
    } else {
        Vec::new()
    };
    let by_offset: HashMap<_, _> = scan
        .instructions
        .iter()
        .enumerate()
        .map(|(index, instruction)| (instruction.offset, index))
        .collect();
    let mut queue = VecDeque::from([ControlState {
        ip: 0,
        returns: Vec::new(),
        work_process_attached: false,
    }]);
    let mut seen = HashSet::new();
    let mut edges = 0;
    let mut max_return_depth = 0;
    let mut reachable_messages = BTreeSet::new();
    let mut reachable_selects = BTreeSet::new();
    let mut root_returns_after_attachment = 0;
    let mut ends_after_attachment = 0;
    let mut terminals_without_attachment = 0;
    while let Some(state) = queue.pop_front() {
        if !seen.insert(state.clone()) {
            continue;
        }
        assert!(seen.len() <= 1_000_000, "static CFG state budget exhausted");
        let instruction = scan.instructions[state.ip];
        if matches!(instruction.family, CommandFamily::TextShow { .. }) {
            reachable_messages.insert(instruction.offset);
        }
        if matches!(instruction.family, CommandFamily::Select) {
            reachable_selects.insert(instruction.offset);
        }
        let next = state.ip + 1;
        let mut successors = Vec::new();
        match instruction.opcode.id() {
            0x15 => {
                if state.work_process_attached {
                    ends_after_attachment += 1;
                } else {
                    terminals_without_attachment += 1;
                }
            }
            0x18 => {
                if let Some(return_ip) = state.returns.last().copied() {
                    successors.push(ControlState {
                        ip: return_ip,
                        returns: state.returns[..state.returns.len() - 1].to_vec(),
                        work_process_attached: state.work_process_attached,
                    });
                } else if state.work_process_attached {
                    root_returns_after_attachment += 1;
                } else {
                    terminals_without_attachment += 1;
                }
            }
            0x09 | 0x0a | 0x0b => {
                let label_id = instruction
                    .operands()
                    .first()
                    .expect("control target operand")
                    .raw;
                assert_ne!(label_id, 0, "a CFG label cannot be zero");
                let target_offset = labels[(label_id - 1) as usize];
                let target = by_offset[&target_offset];
                if instruction.opcode.id() == 0x0b {
                    let mut returns = state.returns.clone();
                    returns.push(next);
                    max_return_depth = max_return_depth.max(returns.len());
                    successors.push(ControlState {
                        ip: target,
                        returns,
                        work_process_attached: state.work_process_attached,
                    });
                } else {
                    successors.push(ControlState {
                        ip: target,
                        returns: state.returns.clone(),
                        work_process_attached: state.work_process_attached,
                    });
                    if instruction.opcode.id() == 0x0a {
                        successors.push(ControlState {
                            ip: next,
                            returns: state.returns.clone(),
                            work_process_attached: state.work_process_attached,
                        });
                    }
                }
            }
            _ => {
                let work_process_attached = state.work_process_attached
                    || matches!(
                        instruction.family,
                        CommandFamily::Call { target }
                            if (target.category, target.function) == (0x0011, 0x001c)
                    );
                successors.push(ControlState {
                    ip: next,
                    returns: state.returns.clone(),
                    work_process_attached,
                });
            }
        }
        for successor in successors {
            if successor.ip < scan.instructions.len() {
                edges += 1;
                queue.push_back(successor);
            }
        }
    }
    CfgResult {
        states: seen.len(),
        edges,
        max_return_depth,
        reachable_messages: reachable_messages.into_iter().collect(),
        reachable_selects: reachable_selects.into_iter().collect(),
        root_returns_after_attachment,
        ends_after_attachment,
        terminals_without_attachment,
    }
}

fn synthetic_program(tokens: &[[u8; 4]]) -> Vec<u8> {
    let mut bytes = Vec::from(&b"Sv20"[..]);
    for token in tokens {
        bytes.extend_from_slice(token);
    }
    bytes
}

fn operator(id: u16) -> [u8; 4] {
    let mut token = [0; 4];
    token[..2].copy_from_slice(&id.to_le_bytes());
    token[2..].copy_from_slice(&1_u16.to_le_bytes());
    token
}

#[test]
fn script_only_slice_reports_a_real_message_syscall_when_one_is_reachable() {
    // This is the mutation guard for `script_only_cfg`: a hollow implementation
    // that returns the corpus-shaped empty result would make this test fail.
    // The message target is original script syntax, not a synthetic dialogue
    // result: no text or pointer is resolved or emitted by this feasibility
    // slice.
    let script = synthetic_program(&[
        operator(0x1f),
        0_u32.to_le_bytes(),
        operator(0x1f),
        0x0fff_ffff_u32.to_le_bytes(),
        operator(0x1f),
        0_u32.to_le_bytes(),
        operator(0x17),
        0x0002_0002_u32.to_le_bytes(),
        0_u32.to_le_bytes(),
        operator(0x15),
    ]);

    let result = script_only_cfg(&script, &[]);
    assert_eq!(result.reachable_messages, vec![28]);
    assert!(result.reachable_selects.is_empty());
    assert_eq!(result.root_returns_after_attachment, 0);
    assert_eq!(result.ends_after_attachment, 0);
    assert_eq!(result.terminals_without_attachment, 1);
}

#[test]
fn classifies_script_only_message_feasibility_and_the_pre_halt_call_contract() {
    let mut all_calls = Vec::new();
    for (index, root) in CORPORA.iter().enumerate() {
        let root = PathBuf::from(root);
        let Some(inputs) = inputs(&root) else {
            eprintln!(
                "SKIP corpus {}: missing VM inputs at {}",
                index + 1,
                root.display()
            );
            continue;
        };
        let static_oracle = ScriptScan::parse(&inputs.script)
            .expect("script scan")
            .resolve(&TextDat::parse(&inputs.textdat).expect("text pool"));
        assert!(static_oracle.is_fully_resolved());
        let cfg = script_only_cfg(&inputs.script, &inputs.points);
        assert!(
            cfg.reachable_messages.is_empty(),
            "corpus {} unexpectedly reaches a message call through ordinary script control flow",
            index + 1
        );
        assert!(
            cfg.reachable_selects.is_empty(),
            "corpus {} unexpectedly reaches a choice call through ordinary script control flow",
            index + 1
        );
        assert_eq!(
            cfg.root_returns_after_attachment + cfg.ends_after_attachment,
            1,
            "corpus {} must have exactly one ordinary script terminus after work-process attachment",
            index + 1
        );
        let scene = SoftpalScene::execute_with_points_mem_dat_and_pacs(
            &inputs.script,
            &inputs.textdat,
            Some(&inputs.points),
            Some(&inputs.mem_dat),
            &[&inputs.archive, &inputs.csv_pac],
        )
        .expect("VM input decodes");
        let calls: Vec<CallContract> = scene
            .trace
            .iter()
            .filter_map(|event| match event {
                RuntimeTraceEvent::Call {
                    category,
                    function,
                    stack_depth,
                    destination_tag,
                    return_value,
                    bank_writes,
                    ..
                } => Some(CallContract {
                    category: *category,
                    function: *function,
                    stack_depth: *stack_depth,
                    destination_tag: *destination_tag,
                    return_value: *return_value,
                    bank_writes: bank_writes
                        .iter()
                        .map(|write| (write.destination_tag, write.destination_slot))
                        .collect(),
                }),
                RuntimeTraceEvent::Branch { .. } => None,
            })
            .collect();
        let branches = scene
            .trace
            .iter()
            .filter(|event| matches!(event, RuntimeTraceEvent::Branch { .. }))
            .count();
        let branch_targets = scene
            .trace
            .iter()
            .filter_map(|event| match event {
                RuntimeTraceEvent::Branch { target_offset, .. } => Some(target_offset.is_some()),
                RuntimeTraceEvent::Call { .. } => None,
            })
            .filter(|present| *present)
            .count();
        assert!(!calls.is_empty(), "call tracing must not be hollow");
        assert_eq!(
            branches,
            scene
                .steps
                .iter()
                .filter(|step| matches!(step, utsushi_softpal::SceneStep::Branch { .. }))
                .count(),
            "every visible branch outcome must retain its trace event"
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.destination_tag.is_some())
                .count(),
            calls.len(),
            "every executed native call has a visible destination tag"
        );
        assert!(
            calls
                .iter()
                .all(|call| { call.return_value.is_some() == (call.bank_writes.len() == 1) }),
            "a native call either returns into one script-visible destination or stays visibly unresolved"
        );
        let first_32: Vec<_> = calls
            .iter()
            .take(32)
            .map(|call| (call.category, call.function))
            .collect();
        let final_32: Vec<_> = calls
            .iter()
            .rev()
            .take(32)
            .map(|call| (call.category, call.function))
            .collect();
        let attachment = calls
            .iter()
            .find(|call| (call.category, call.function) == (0x0011, 0x001c))
            .expect("the work-process attachment must remain visible");
        let terminal = OpcodeScan::parse(&inputs.script)
            .expect("opcode scan")
            .instructions
            .into_iter()
            .find(|instruction| instruction.offset == scene.diagnostics[0].offset)
            .expect("diagnostic points at an instruction");
        assert_eq!(terminal.opcode.id(), 0x18, "halt is a root return");
        assert!(
            terminal.operands().is_empty(),
            "root return has no script-visible read"
        );
        eprintln!(
            "[corpus {}] cfg_states={} cfg_edges={} max_return_depth={} reachable_messages={} reachable_selects={} script_termini(root_return_after_attach/end_after_attach/without_attach)={}/{}/{} static_messages={} executed_calls={} call_fields(category/function/stack/destination/return/bank_writes)={}/{}/{}/{}/{}/{} trace_branches={} branch_target_offsets={} attachment={:?} first32={:04x?} final32={:04x?} post_halt_script_reads=0",
            index + 1,
            cfg.states,
            cfg.edges,
            cfg.max_return_depth,
            cfg.reachable_messages.len(),
            cfg.reachable_selects.len(),
            cfg.root_returns_after_attachment,
            cfg.ends_after_attachment,
            cfg.terminals_without_attachment,
            static_oracle.dialogue.len(),
            calls.len(),
            calls.len(),
            calls.len(),
            calls.len(),
            calls
                .iter()
                .filter(|call| call.destination_tag.is_some())
                .count(),
            calls
                .iter()
                .filter(|call| call.return_value.is_some())
                .count(),
            calls
                .iter()
                .filter(|call| !call.bank_writes.is_empty())
                .count(),
            branches,
            branch_targets,
            attachment,
            first_32,
            final_32,
        );
        all_calls.push(calls);
    }
    assert_eq!(
        all_calls.len(),
        2,
        "both staged corpora are required for the differential"
    );
    let shared_prefix = all_calls[0]
        .iter()
        .zip(&all_calls[1])
        .take_while(|(left, right)| left == right)
        .count();
    let shared_target_prefix = all_calls[0]
        .iter()
        .map(|call| (call.category, call.function))
        .zip(
            all_calls[1]
                .iter()
                .map(|call| (call.category, call.function)),
        )
        .take_while(|(left, right)| left == right)
        .count();
    let tail_len = all_calls[0].len().min(all_calls[1].len()).min(32);
    let tail_a = &all_calls[0][all_calls[0].len() - tail_len..];
    let tail_b = &all_calls[1][all_calls[1].len() - tail_len..];
    let shared_tail_full = tail_a
        .iter()
        .zip(tail_b)
        .filter(|(left, right)| left == right)
        .count();
    let shared_tail_targets = tail_a
        .iter()
        .zip(tail_b)
        .filter(|(left, right)| (left.category, left.function) == (right.category, right.function))
        .count();
    let shared_tail_shapes = tail_a
        .iter()
        .zip(tail_b)
        .filter(|(left, right)| {
            (
                left.category,
                left.function,
                left.stack_depth,
                left.destination_tag,
                left.return_value,
            ) == (
                right.category,
                right.function,
                right.stack_depth,
                right.destination_tag,
                right.return_value,
            )
        })
        .count();
    assert_eq!(
        shared_prefix, 15,
        "the observed shared setup contract changed"
    );
    assert_eq!(
        shared_target_prefix, 17,
        "the observed shared setup dispatch-target prefix changed"
    );
    assert_eq!(
        shared_tail_targets, tail_len,
        "the final pre-halt dispatch-target window must stay shared"
    );
    eprintln!(
        "[differential] shared_full_contract_prefix={} first_full_divergence=15 shared_target_prefix={} first_target_divergence=17 final_window={} shared_targets={} shared_shape_without_bank_slots={} shared_full_contracts={} attachment_contract_equal={} post_halt_script_reads=0",
        shared_prefix,
        shared_target_prefix,
        tail_len,
        shared_tail_targets,
        shared_tail_shapes,
        shared_tail_full,
        all_calls[0][0] == all_calls[1][0],
    );
}
