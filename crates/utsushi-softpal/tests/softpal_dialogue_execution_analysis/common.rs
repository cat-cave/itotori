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
        (0x0011, 0x001c | 0x0003)
            | (0x000f | 0x0012 | 0x0003, 0x0005)
            | (0x000d, 0x0015 | 0x0016)
            | (0x000f, 0x0004)
            | (0x0012, 0x000f | 0x0006 | 0x001e | 0x001f | 0x0022 | 0x0023 | 0x0021)
            | (0x0009, 0x0034 | 0x0002 | 0x0000 | 0x000e)
            | (0x000c, 0x0001 | 0x0000)
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
                    0x09..=0x0b => {
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
