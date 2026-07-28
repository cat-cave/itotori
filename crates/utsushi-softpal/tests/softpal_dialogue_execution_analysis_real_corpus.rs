//! Text-free evidence for the dialogue-execution investigation.
//!
//! This test deliberately reports offsets, dispatch keys, state-shape counts,
//! and hashes only.  It must never print private dialogue, speaker, or choice
//! payloads while exercising the staged retail inputs.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{CommandFamily, OpcodeScan, PacArchive, ScriptScan, TextDat};
use utsushi_softpal::{RuntimeTraceEvent, SceneStep, SoftpalScene};

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

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
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

/// A byte-designated location the engine can enter without inventing an
/// instruction offset. `POINT.DAT` owns the label targets; a literal argument
/// to the recovered `set_last_process` native dispatch is an additional
/// dispatch witness for the corresponding point id.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum EntryDesignation {
    Root,
    PointTable,
    SetLastProcess,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LegalEntry {
    offset: usize,
    designations: BTreeSet<EntryDesignation>,
}

/// A route score never assumes a native call succeeded. `unimplemented_calls`
/// counts call *occurrences* on the static route that the current VM would
/// visibly stop at. It is therefore a lower-bound proof obligation: a score of
/// zero is executable without adding a native handler; a nonzero score is not.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct RouteScore {
    unimplemented_calls: usize,
    distance: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EntryReachability {
    entry: LegalEntry,
    reachable_messages: BTreeMap<usize, RouteScore>,
    reachable_selects: BTreeMap<usize, RouteScore>,
}

// The existing real root slice observes a maximum script return depth of 3.
// Rank-13 searches one frame beyond that observed contract; a recursive path
// deeper than this is not silently called reachable and cannot win a
// lowest-dependency proof target here.
const RANKING_MAX_RETURN_DEPTH: usize = 4;

fn is_vm_implemented_call(category: u16, function: u16) -> bool {
    matches!(
        (category, function),
        (0x0011, 0x001c)
            | (0x000f, 0x0005)
            | (0x000d, 0x0015)
            | (0x000d, 0x0016)
            | (0x000f, 0x0004)
            | (0x0012, 0x000f)
            | (0x0012, 0x0006)
            | (0x0012, 0x001e)
            | (0x0012, 0x001f)
            | (0x0012, 0x0022)
            | (0x0012, 0x0023)
            | (0x0012, 0x0021)
            | (0x0012, 0x0005)
            | (0x0009, 0x0034)
            | (0x0009, 0x0002)
            | (0x000c, 0x0001)
            | (0x000c, 0x0000)
            | (0x0009, 0x0000)
            | (0x0009, 0x000e)
            | (0x0011, 0x0003)
            | (0x0003, 0x0005)
    )
}

fn legal_entries(script: &[u8], points: &[u8]) -> Vec<LegalEntry> {
    let scan = OpcodeScan::parse(script).expect("opcode scan");
    let point_offsets = point_offsets(points);
    let mut entries = BTreeMap::<usize, BTreeSet<EntryDesignation>>::new();
    entries
        .entry(12)
        .or_default()
        .insert(EntryDesignation::Root);
    for offset in &point_offsets {
        entries
            .entry(*offset)
            .or_default()
            .insert(EntryDesignation::PointTable);
    }
    for (index, instruction) in scan.instructions.iter().enumerate() {
        let CommandFamily::Call { target } = instruction.family else {
            continue;
        };
        if (target.category, target.function) != (0x0012, 0x0023) {
            continue;
        }
        // This is deliberately narrower than symbolic stack evaluation. A
        // literal point id immediately pushed by SCRIPT.SRC is a dispatch
        // designation; any computed/opaque stack value remains unproven.
        let Some(push) = index
            .checked_sub(1)
            .and_then(|previous| scan.instructions.get(previous))
            .filter(|previous| previous.opcode.id() == 0x1f)
        else {
            continue;
        };
        let Some(point_id) = push.operands().first().map(|operand| operand.raw) else {
            continue;
        };
        if point_id == 0 {
            continue;
        }
        if let Some(offset) = point_offsets.get((point_id - 1) as usize) {
            entries
                .entry(*offset)
                .or_default()
                .insert(EntryDesignation::SetLastProcess);
        }
    }
    entries
        .into_iter()
        .map(|(offset, designations)| LegalEntry {
            offset,
            designations,
        })
        .collect()
}

/// Score every text/choice syscall reachable from every byte-designated entry.
/// The search intentionally forks conditionals and treats native calls as an
/// opaque normal return only for *control-flow feasibility*. Each unsupported
/// call is charged to the route, so this analysis cannot turn a missing native
/// handler into an executable route.
fn rank_legal_entries(script: &[u8], points: &[u8]) -> Vec<EntryReachability> {
    let scan = OpcodeScan::parse(script).expect("opcode scan");
    assert!(
        scan.is_exhaustive(),
        "the ranking requires an exhaustive opcode scan"
    );
    let labels = point_offsets(points);
    let by_offset: HashMap<_, _> = scan
        .instructions
        .iter()
        .enumerate()
        .map(|(index, instruction)| (instruction.offset, index))
        .collect();
    legal_entries(script, points)
        .into_iter()
        .filter_map(|entry| {
            let start = by_offset.get(&entry.offset).copied()?;
            let mut pending = BinaryHeap::new();
            let mut best = BTreeMap::<ControlState, RouteScore>::new();
            let initial = ControlState {
                ip: start,
                returns: Vec::new(),
                work_process_attached: false,
            };
            pending.push(Reverse((
                RouteScore {
                    unimplemented_calls: 0,
                    distance: 0,
                },
                initial,
            )));
            let mut reachable_messages = BTreeMap::<usize, RouteScore>::new();
            let mut reachable_selects = BTreeMap::<usize, RouteScore>::new();
            while let Some(Reverse((score, state))) = pending.pop() {
                if best.get(&state).is_some_and(|prior| *prior <= score) {
                    continue;
                }
                best.insert(state.clone(), score);
                assert!(best.len() <= 1_000_000, "ranking state budget exhausted");
                let instruction = scan.instructions[state.ip];
                if matches!(instruction.family, CommandFamily::TextShow { .. }) {
                    reachable_messages
                        .entry(instruction.offset)
                        .and_modify(|prior| *prior = (*prior).min(score))
                        .or_insert(score);
                }
                if matches!(instruction.family, CommandFamily::Select) {
                    reachable_selects
                        .entry(instruction.offset)
                        .and_modify(|prior| *prior = (*prior).min(score))
                        .or_insert(score);
                }
                let next = state.ip + 1;
                let unsupported = match instruction.family {
                    CommandFamily::Call { target }
                        if !is_vm_implemented_call(target.category, target.function) =>
                    {
                        1
                    }
                    _ => 0,
                };
                let successor_score = RouteScore {
                    unimplemented_calls: score.unimplemented_calls + unsupported,
                    distance: score.distance + 1,
                };
                let mut successors = Vec::new();
                match instruction.opcode.id() {
                    0x15 => {}
                    0x18 => {
                        if let Some(return_ip) = state.returns.last().copied() {
                            successors.push(ControlState {
                                ip: return_ip,
                                returns: state.returns[..state.returns.len() - 1].to_vec(),
                                work_process_attached: state.work_process_attached,
                            });
                        }
                    }
                    0x09 | 0x0a | 0x0b => {
                        let label_id = instruction.operands().first()?.raw;
                        let target_offset = *labels.get((label_id - 1) as usize)?;
                        let target = *by_offset.get(&target_offset)?;
                        if instruction.opcode.id() == 0x0b {
                            if state.returns.len() >= RANKING_MAX_RETURN_DEPTH {
                                continue;
                            }
                            let mut returns = state.returns.clone();
                            returns.push(next);
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
                        pending.push(Reverse((successor_score, successor)));
                    }
                }
            }
            Some(EntryReachability {
                entry,
                reachable_messages,
                reachable_selects,
            })
        })
        .collect()
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

fn full_synthetic_program(tokens: &[[u8; 4]]) -> Vec<u8> {
    let mut bytes = Vec::from(&b"Sv20"[..]);
    bytes.extend_from_slice(&[0; 8]);
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
fn ranks_a_point_table_designated_message_without_promoting_the_root() {
    // Mutation guard for the rank-13 experiment: deleting the actual entry
    // enumeration or shortest-route walk makes the designated message vanish,
    // while the root correctly remains unable to reach it.
    let script = full_synthetic_program(&[
        operator(0x15),
        operator(0x17),
        0x0002_0002_u32.to_le_bytes(),
        0_u32.to_le_bytes(),
        operator(0x15),
    ]);
    let mut points = Vec::from(&b"_POINT_LIST_****"[..]);
    // The sole entry is script offset 16, stored relative to the 12-byte
    // program header. It is a real point-table designation, not an arbitrary
    // offset injected by the test.
    points.extend_from_slice(&4_u32.to_le_bytes());

    let ranked = rank_legal_entries(&script, &points);
    assert_eq!(ranked.len(), 2);
    let root = ranked
        .iter()
        .find(|entry| entry.entry.designations.contains(&EntryDesignation::Root))
        .expect("root entry");
    assert!(root.reachable_messages.is_empty());
    let point = ranked
        .iter()
        .find(|entry| entry.entry.offset == 16)
        .expect("point-table entry");
    assert!(
        point
            .entry
            .designations
            .contains(&EntryDesignation::PointTable)
    );
    assert_eq!(
        point.reachable_messages.get(&16),
        Some(&RouteScore {
            unimplemented_calls: 0,
            distance: 0,
        })
    );
}

#[test]
fn ranks_every_byte_designated_entry_without_emitting_private_text() {
    for (index, root) in CORPORA.iter().enumerate() {
        let root = PathBuf::from(root);
        let Some(inputs) = inputs(&root) else {
            panic!("missing staged corpus {} at {}", index + 1, root.display());
        };
        let disassembly = ScriptScan::parse(&inputs.script)
            .expect("script scan")
            .resolve(&TextDat::parse(&inputs.textdat).expect("text pool"));
        assert!(disassembly.is_fully_resolved());
        let message_resolution: BTreeMap<_, _> = disassembly
            .dialogue
            .iter()
            .map(|unit| {
                (
                    unit.command_offset + 24,
                    (
                        unit.text.is_resolved(),
                        unit.speaker.as_ref().is_none_or(|s| s.is_resolved()),
                    ),
                )
            })
            .collect();
        let ranked = rank_legal_entries(&inputs.script, &inputs.points);
        let root_entry = ranked
            .iter()
            .find(|entry| entry.entry.designations.contains(&EntryDesignation::Root))
            .expect("normal root is a legal entry");
        assert!(
            root_entry.reachable_messages.is_empty(),
            "the rank-13 root result must agree with the existing post-attach CFG slice"
        );
        let point_entries = ranked
            .iter()
            .filter(|entry| {
                entry
                    .entry
                    .designations
                    .contains(&EntryDesignation::PointTable)
            })
            .count();
        let transition_entries = ranked
            .iter()
            .filter(|entry| {
                entry
                    .entry
                    .designations
                    .contains(&EntryDesignation::SetLastProcess)
            })
            .count();
        let entries_with_messages = ranked
            .iter()
            .filter(|entry| !entry.reachable_messages.is_empty())
            .count();
        let reachable_messages: BTreeMap<_, _> = ranked
            .iter()
            .flat_map(|entry| entry.reachable_messages.iter())
            .fold(
                BTreeMap::<usize, RouteScore>::new(),
                |mut all, (offset, score)| {
                    all.entry(*offset)
                        .and_modify(|prior| *prior = (*prior).min(*score))
                        .or_insert(*score);
                    all
                },
            );
        let fully_resolved_messages = reachable_messages
            .keys()
            .filter(|offset| {
                message_resolution
                    .get(offset)
                    .is_some_and(|(text, speaker)| *text && *speaker)
            })
            .count();
        assert_eq!(
            fully_resolved_messages,
            reachable_messages.len(),
            "a ranked message must retain a fully resolved byte-backed text and optional speaker pointer"
        );
        let lowest = ranked
            .iter()
            .flat_map(|entry| {
                entry.reachable_messages.iter().map(move |(offset, score)| {
                    (
                        *score,
                        *offset,
                        entry.entry.offset,
                        entry.entry.designations.clone(),
                    )
                })
            })
            .min_by_key(|(score, offset, entry_offset, _)| (*score, *offset, *entry_offset));
        let zero_dependency_messages = reachable_messages
            .values()
            .filter(|score| score.unimplemented_calls == 0)
            .count();
        let zero_dependency_entries = ranked
            .iter()
            .filter(|entry| {
                entry
                    .reachable_messages
                    .values()
                    .any(|score| score.unimplemented_calls == 0)
            })
            .count();
        let (proof_score, proof_message_offset, proof_entry_offset, proof_designations) = lowest
            .clone()
            .expect("ranked point entries reach at least one resolved message");
        assert_eq!(proof_score.unimplemented_calls, 0);
        assert_eq!(proof_score.distance, 4);
        assert_eq!(
            proof_designations,
            BTreeSet::from([EntryDesignation::PointTable])
        );
        let point_id = point_offsets(&inputs.points)
            .iter()
            .position(|offset| *offset == proof_entry_offset)
            .and_then(|index| u32::try_from(index + 1).ok())
            .expect("proof entry has a one-based POINT.DAT id");
        let scene = SoftpalScene::execute_from_point_with_points_mem_dat_and_pacs(
            &inputs.script,
            &inputs.textdat,
            &inputs.points,
            Some(&inputs.mem_dat),
            &[&inputs.archive, &inputs.csv_pac],
            point_id,
        )
        .expect("the exact point-table proof entry executes");
        let observed: Vec<_> = scene
            .steps
            .iter()
            .filter_map(|step| match step {
                SceneStep::Dialogue { command_offset, .. } => Some(*command_offset),
                _ => None,
            })
            .collect();
        let expected: Vec<_> = disassembly
            .dialogue
            .iter()
            .map(|unit| unit.command_offset)
            .collect();
        assert_eq!(
            observed.first().copied(),
            Some(proof_message_offset - 24),
            "the first emitted text is the ranked byte-resolved call, not a default-state substitute"
        );
        let mut expected_cursor = 0;
        let mut ordered_overlap = 0;
        for observed_offset in &observed {
            let Some(relative) = expected[expected_cursor..]
                .iter()
                .position(|expected_offset| expected_offset == observed_offset)
            else {
                break;
            };
            ordered_overlap += 1;
            expected_cursor += relative + 1;
        }
        assert_eq!(
            ordered_overlap,
            observed.len(),
            "executed point-entry text must be an ordered subsequence of the static byte oracle"
        );
        let prefix_overlap = observed
            .iter()
            .zip(&expected)
            .take_while(|(observed, expected)| observed == expected)
            .count();
        let emitted_speakers = scene
            .dialogue_lines()
            .filter(|(speaker, _)| speaker.is_some())
            .count();
        let static_speakers = observed
            .iter()
            .filter(|observed_offset| {
                disassembly
                    .dialogue
                    .iter()
                    .find(|unit| unit.command_offset == **observed_offset)
                    .is_some_and(|unit| unit.speaker.is_some())
            })
            .count();
        assert_eq!(
            emitted_speakers, static_speakers,
            "an emitted speaker is present exactly when the decoded command carries one"
        );
        let terminal_signature = scene
            .diagnostics
            .first()
            .map(|diagnostic| diagnostic.signature.as_str());
        eprintln!(
            "[rank13 corpus {}] legal_entries={} point_table_entries={} set_last_process_entries={} entries_with_messages={} root_messages={} reachable_messages={} resolved_messages={} zero_dependency_messages={} zero_dependency_entries={} lowest(score/message_offset/entry_offset/designations)={:?} proof(point_id/instructions/moments/text/speaker/static_speaker/choice/branch/diagnostics/terminal/ordered_overlap/prefix_overlap/static)={}/{}/{}/{}/{}/{}/{}/{}/{}/{:?}/{}/{}/{} root_validates(executed_prefix_messages/moments)=0/{}",
            index + 1,
            ranked.len(),
            point_entries,
            transition_entries,
            entries_with_messages,
            root_entry.reachable_messages.len(),
            reachable_messages.len(),
            fully_resolved_messages,
            zero_dependency_messages,
            zero_dependency_entries,
            lowest,
            point_id,
            scene.stats.instructions_executed,
            scene.steps.len(),
            scene.stats.dialogue_count,
            emitted_speakers,
            static_speakers,
            scene.stats.text_bearing_choice_count,
            scene.stats.branch_count,
            scene.diagnostics.len(),
            terminal_signature,
            ordered_overlap,
            prefix_overlap,
            expected.len(),
            [134, 986][index],
        );
    }
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
