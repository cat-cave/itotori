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
            0x09..=0x0b => {
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
