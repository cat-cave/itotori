#[test]
#[ignore = "real-bytes; requires both staged Softpal corpora"]
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
                        unit.speaker.as_ref().is_none_or(kaifuu_softpal::TextRef::is_resolved),
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
