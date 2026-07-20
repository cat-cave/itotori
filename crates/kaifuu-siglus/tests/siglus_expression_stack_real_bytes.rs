//! Env-gated real-bytes proof for the scene **expression / stack decoder**
//! (siglus-09), stacked on the siglus-08 partitioner.
//!
//! Copyrighted title bytes stay outside this repository, so the two game roots
//! are supplied via `ITOTORI_REAL_GAME_ROOT_SIGLUS` / `_2` (each a directory —
//! or a path inside one — holding `SiglusEngine.exe` + `Scene.pck`). When either
//! root is absent the test reports a skip and succeeds.
//!
//! When both are present it proves, for every scene of both owned titles
//! (karetoshi = 298, gamekoi = 278):
//!   1. every instruction's operand bytes decode to a typed operand, consuming
//!      **exactly** the span the partition assigned — zero unparsed operand
//!      bytes (`typed_operand_bytes == total_operand_bytes`, scene-wide);
//!   2. every operand stream folds into typed [`SiglusExpr`] trees, and the
//!      operator histogram is **complete** — zero `UnsupportedOperator` bytes
//!      across both games (the strict acceptance, mirroring siglus-08's zero
//!      `Unknown` opcodes); and
//!   3. the decode is **deterministic**: two runs over the same bytes are
//!      byte-identical.
//!
//! Only counts / offsets / operator labels cross into the assertions — never
//! raw scene text (`str` literals travel as their table index only).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    SiglusOperatorHistogram, SiglusSecondLayerKey, decode_scene_chunk, decode_scene_expressions,
    parse_scene_pck, recover_exe_angou_key,
};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

const EXPECTED_SCENE_COUNTS: [usize; 2] = [298, 278];

fn title_paths(variable: &str) -> Option<(PathBuf, PathBuf)> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus expression-stack real bytes: {variable} is unset");
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
            "SKIP siglus expression-stack real bytes: {variable} has no SiglusEngine.exe + \
             Scene.pck under {}",
            dir.display()
        );
        None
    }
}

/// Decode every scene's expressions for one title, asserting the per-scene
/// invariants and returning `(scene_count, aggregate underflow-by-lead map)`.
fn exercise_title(
    exe_path: &Path,
    scene_path: &Path,
    label: &str,
) -> (usize, BTreeMap<String, usize>) {
    let exe_bytes = std::fs::read(exe_path).expect("read real SiglusEngine.exe");
    let scene_bytes = std::fs::read(scene_path).expect("read real Scene.pck");

    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/exe-angou"));
    let recovery = recover_exe_angou_key(&exe_bytes, &key_ref)
        .unwrap_or_else(|error| panic!("{label}: exe-angou key recovery failed: {error}"));

    let index = parse_scene_pck(&scene_bytes).expect("real Scene.pck envelope parses");
    let scene_count = index.entries.len();

    let mut operators = SiglusOperatorHistogram::default();
    let mut push_int = 0usize;
    let mut push_str = 0usize;
    let mut push_other: BTreeMap<i32, usize> = BTreeMap::new();
    let mut element_chains = 0usize;
    let mut gosubs = 0usize;
    let mut commands = 0usize;
    let mut roots = 0usize;
    let mut underflow = 0usize;
    let mut underflow_by_lead: BTreeMap<String, usize> = BTreeMap::new();
    let mut nonempty_final_stacks = 0usize;
    let mut total_operand_bytes = 0usize;

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

        let decode = decode_scene_expressions(&payload).unwrap_or_else(|error| {
            panic!(
                "{label}: scene {} expression decode: {error}",
                entry.scene_id
            )
        });

        // (1) Zero unparsed operand bytes: every operand byte is typed.
        assert_eq!(
            decode.typed_operand_bytes, decode.total_operand_bytes,
            "{label}: scene {} left unparsed operand bytes",
            entry.scene_id
        );

        // (2) Complete operator coverage: no operator byte outside the tables.
        assert!(
            decode.operators.unsupported.is_empty(),
            "{label}: scene {} has {} unsupported operator byte(s): {:?}",
            entry.scene_id,
            decode.operators.unsupported.len(),
            &decode.operators.unsupported[..decode.operators.unsupported.len().min(8)]
        );
        assert!(
            decode.is_fully_typed(),
            "{label}: scene {} did not fully type its expressions",
            entry.scene_id
        );

        // (3) Determinism: a second decode is byte-identical.
        let again = decode_scene_expressions(&payload).expect("re-decode");
        assert_eq!(
            decode, again,
            "{label}: scene {} expression decode is not reproducible",
            entry.scene_id
        );

        operators.merge(&decode.operators);
        push_int += decode.push_int_count;
        push_str += decode.push_str_count;
        for (form, count) in &decode.push_other_forms {
            *push_other.entry(*form).or_insert(0) += count;
        }
        element_chains += decode.element_chain_count;
        gosubs += decode.gosub_count;
        commands += decode.command_count;
        roots += decode.roots.len();
        underflow += decode.stack_underflow_count;
        for (lead, count) in &decode.stack_underflow_by_lead {
            *underflow_by_lead.entry(lead.clone()).or_insert(0) += count;
        }
        total_operand_bytes += decode.total_operand_bytes;
        if decode.final_stack_depth != 0 {
            nonempty_final_stacks += 1;
        }
    }

    eprintln!(
        "REAL {label}: scenes={scene_count} operand_bytes={total_operand_bytes} \
         push_int={push_int} push_str={push_str} push_other_forms={push_other:?} \
         element_chains={element_chains} gosubs={gosubs} commands={commands} roots={roots} \
         stack_underflows={underflow} underflow_by_lead={underflow_by_lead:?} \
         nonempty_final_stacks={nonempty_final_stacks}"
    );
    eprintln!(
        "REAL {label}: operator histogram unary={:?} binary={:?} unsupported={}",
        operators.unary,
        operators.binary,
        operators.unsupported.len()
    );

    (scene_count, underflow_by_lead)
}

#[test]
fn two_real_siglus_scene_packs_decode_all_expressions() {
    let Some((first_exe, first_scene)) = title_paths(FIRST_TITLE_ENV) else {
        return;
    };
    let Some((second_exe, second_scene)) = title_paths(SECOND_TITLE_ENV) else {
        return;
    };
    let (first_count, first_uf) = exercise_title(&first_exe, &first_scene, "siglus-title-one");
    let (second_count, second_uf) = exercise_title(&second_exe, &second_scene, "siglus-title-two");

    // The operator opcodes (CD_OPERATE_1 = 0x21, CD_OPERATE_2 = 0x22) must never
    // underflow: every unary / binary expression finds its operands locally, so
    // every operator subtree is a complete typed tree. Any residual underflow is
    // confined to the statement-level consumers that reach across control-flow
    // edges (Pop 0x03 / Property 0x05 / Assign 0x20 / Command 0x30) — the
    // siglus-10 flow layer resolves those cross-block operands.
    let flow_consumers = ["03", "05", "20", "30"];
    for uf in [&first_uf, &second_uf] {
        for (lead, count) in uf {
            assert!(
                flow_consumers.contains(&lead.as_str()),
                "expression operator opcode {lead} underflowed {count} time(s): every \
                 operator subtree must be locally complete"
            );
        }
    }

    let mut observed = [first_count, second_count];
    let mut expected = EXPECTED_SCENE_COUNTS;
    observed.sort_unstable();
    expected.sort_unstable();
    assert_eq!(
        observed, expected,
        "expected the two owned titles' scene counts {EXPECTED_SCENE_COUNTS:?}, got {observed:?}"
    );
}
