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

