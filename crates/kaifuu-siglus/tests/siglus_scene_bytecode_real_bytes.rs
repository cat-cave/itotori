//! Env-gated real-bytes proof for the scene-bytecode **partitioner** skeleton.
//!
//! Copyrighted title bytes stay outside this repository, so the two game roots
//! are supplied via `ITOTORI_REAL_GAME_ROOT_SIGLUS` / `_2` (each a directory —
//! or a path inside one — holding `SiglusEngine.exe` + `Scene.pck`). When either
//! root is absent the test reports a skip and succeeds.
//!
//! When both are present it proves, for every scene of both owned titles
//! (karetoshi = 298, gamekoi = 278):
//!   1. the decompressed scene payload partitions into a fully-covering,
//!      exactly-offset instruction stream with **no panic** (fuzz-safe walking);
//!   2. a per-opcode histogram is produced (counts + Unknown count/positions);
//!      Unknown spans are permitted and reported — here they are zero and every
//!      label anchor lands on an instruction boundary; and
//!   3. the partition is **deterministic**: two runs over the same bytes yield
//!      byte-identical offsets.
//!
//! Only counts / offsets cross into the assertions — never raw scene bytes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    SiglusSecondLayerKey, decode_scene_chunk, parse_scene_pck, partition_scene,
    recover_exe_angou_key,
};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

/// The two owned titles' expected scene counts (order-independent).
const EXPECTED_SCENE_COUNTS: [usize; 2] = [298, 278];

fn title_paths(variable: &str) -> Option<(PathBuf, PathBuf)> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus scene-bytecode real bytes: {variable} is unset");
        None
    })?;
    let root = PathBuf::from(value);
    let dir = if root.is_dir() {
        root
    } else {
        root.parent().map(Path::to_path_buf).unwrap_or(root)
    };
    let exe = dir.join("SiglusEngine.exe");
    let scene = dir.join("Scene.pck");
    if exe.is_file() && scene.is_file() {
        Some((exe, scene))
    } else {
        eprintln!(
            "SKIP siglus scene-bytecode real bytes: {variable} has no SiglusEngine.exe + Scene.pck \
             under {}",
            dir.display()
        );
        None
    }
}

/// Partition every scene of one title and return `(scene_count, aggregate
/// per-opcode histogram counts, total Unknown span count)`.
fn exercise_title(exe_path: &Path, scene_path: &Path, label: &str) -> usize {
    let exe_bytes = std::fs::read(exe_path).expect("read real SiglusEngine.exe");
    let scene_bytes = std::fs::read(scene_path).expect("read real Scene.pck");

    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/exe-angou"));
    let recovery = recover_exe_angou_key(&exe_bytes, &key_ref)
        .unwrap_or_else(|error| panic!("{label}: exe-angou key recovery failed: {error}"));

    let index = parse_scene_pck(&scene_bytes).expect("real Scene.pck envelope parses");
    let scene_count = index.entries.len();

    let mut aggregate: BTreeMap<String, usize> = BTreeMap::new();
    let mut aggregate_unknown_leads: BTreeMap<String, usize> = BTreeMap::new();
    let mut total_unknown = 0usize;
    let mut total_instructions = 0usize;
    let mut total_bytecode = 0usize;

    for entry in &index.entries {
        let start = entry.byte_offset as usize;
        let chunk = &scene_bytes[start..start + entry.byte_len as usize];
        let payload = decode_scene_chunk(
            entry.scene_id,
            chunk,
            index.extra_key_use,
            Some(recovery.material()),
        )
        .unwrap_or_else(|error| panic!("{label}: scene {} decode failed: {error}", entry.scene_id));

        // (1) Partition — must not panic and must fully cover the bytecode.
        let part = partition_scene(&payload)
            .unwrap_or_else(|error| panic!("{label}: scene {} partition: {error}", entry.scene_id));
        let covered: usize = part.instructions.iter().map(|i| i.len).sum();
        assert_eq!(
            covered, part.bytecode_len,
            "{label}: scene {} instructions must cover every bytecode byte",
            entry.scene_id
        );
        // Offsets are contiguous and in-bounds.
        let mut cursor = 0usize;
        for instruction in &part.instructions {
            assert_eq!(
                instruction.byte_offset, cursor,
                "{label}: scene {} has a non-contiguous instruction offset",
                entry.scene_id
            );
            assert!(instruction.len >= 1);
            cursor += instruction.len;
        }
        assert_eq!(cursor, part.bytecode_len);

        // Skeleton acceptance: every anchor aligns and (on these titles) the
        // scene partitions with zero Unknown spans.
        assert!(
            part.anchors_aligned,
            "{label}: scene {} has a label anchor off an instruction boundary",
            entry.scene_id
        );
        assert!(
            part.fully_partitioned,
            "{label}: scene {} did not fully partition ({} Unknown spans at {:?})",
            entry.scene_id,
            part.histogram.unknown_count,
            &part.histogram.unknown_offsets[..part.histogram.unknown_offsets.len().min(8)]
        );

        // (2) Histogram is produced.
        assert!(
            !part.histogram.counts.is_empty(),
            "{label}: scene {} produced an empty histogram",
            entry.scene_id
        );
        for (opcode, count) in &part.histogram.counts {
            *aggregate.entry(opcode.clone()).or_insert(0) += count;
        }
        for (lead, count) in &part.histogram.unknown_lead_counts {
            *aggregate_unknown_leads.entry(lead.clone()).or_insert(0) += count;
        }
        total_unknown += part.histogram.unknown_count;
        total_instructions += part.instruction_count;
        total_bytecode += part.bytecode_len;

        // (3) Determinism: a second partition is byte-identical.
        let again = partition_scene(&payload).expect("re-partition");
        assert_eq!(
            part, again,
            "{label}: scene {} partition is not reproducible",
            entry.scene_id
        );
    }

    eprintln!(
        "REAL {label}: scenes={scene_count} bytecode_bytes={total_bytecode} \
         instructions={total_instructions} unknown_spans={total_unknown} \
         distinct_opcodes={} unknown_leads={:?}",
        aggregate.len(),
        aggregate_unknown_leads
    );
    let mut summary: Vec<(String, usize)> = aggregate.into_iter().collect();
    summary.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    eprintln!("REAL {label}: per-opcode histogram (lead -> count): {summary:?}");

    scene_count
}

#[test]
fn two_real_siglus_scene_packs_partition_all_scenes() {
    let Some((first_exe, first_scene)) = title_paths(FIRST_TITLE_ENV) else {
        return;
    };
    let Some((second_exe, second_scene)) = title_paths(SECOND_TITLE_ENV) else {
        return;
    };
    let first_count = exercise_title(&first_exe, &first_scene, "siglus-title-one");
    let second_count = exercise_title(&second_exe, &second_scene, "siglus-title-two");

    let mut observed = [first_count, second_count];
    let mut expected = EXPECTED_SCENE_COUNTS;
    observed.sort_unstable();
    expected.sort_unstable();
    assert_eq!(
        observed, expected,
        "expected the two owned titles' scene counts {EXPECTED_SCENE_COUNTS:?}, got {observed:?}"
    );
}
