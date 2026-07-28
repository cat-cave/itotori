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
