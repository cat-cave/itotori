//! Env-gated real-bytes proof for the scene **statement / flow decoder**
//! (siglus-10), stacked on the siglus-08 partitioner + siglus-09 expression
//! decoder.
//!
//! Copyrighted title bytes stay outside this repository; the two game roots are
//! supplied via `ITOTORI_REAL_GAME_ROOT_SIGLUS` / `_2` (each a directory — or a
//! path inside one — holding `SiglusEngine.exe` + `Scene.pck`). When either root
//! is absent the test reports a skip and succeeds.
//!
//! With both present it proves, for every scene of both owned titles
//! (karetoshi = 298, gamekoi = 278):
//!   1. **Named coverage** — every instruction decodes to a named statement, so
//!      the family histogram carries **zero** `unknown`, and every listed opcode
//!      family (`text`, `name`, `jump`, `assign`, `arith`, `command`) is present.
//!   2. **Text surfaces** — every `CD_TEXT` / `CD_NAME` surface carries a
//!      concrete string-table **reference** (index) + a payload byte-span
//!      (offset + UTF-16 length) that stays in bounds — the patch-back output.
//!   3. **Resolved jumps** — every `CD_GOTO*` / `CD_GOSUB*` label index resolves
//!      to an in-stream target offset.
//!   4. **Choice units** — the select→conditional-jump dispatch pattern is
//!      recognized and linked (each unit has ≥2 arms binding a choice constant to
//!      a branch target).
//!   5. **Underflow resolution** — the flow layer's straight-line count
//!      reproduces siglus-09's `stack_underflow_count` **exactly** (a cross-layer
//!      invariant), and CFG stack-state propagation resolves the bulk of it: the
//!      entire `CD_POP` (`0x03`) cross-edge class is fully resolved, and the
//!      residual is fully attributed to the documented inter-procedural
//!      (call-frame / indirect-entry) categories — never an unresolved
//!      intra-scene flow edge.
//!   6. **Determinism** — two decodes over the same bytes are byte-identical.
//!
//! Only counts / offsets / indices cross into the assertions — never raw text.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    FlowUnderflowReport, SiglusSecondLayerKey, decode_scene_chunk, decode_scene_expressions,
    decode_scene_flow, parse_scene_pck, recover_exe_angou_key,
};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";
const EXPECTED_SCENE_COUNTS: [usize; 2] = [298, 278];

/// The opcode families that must be present and fully named on both titles.
const REQUIRED_FAMILIES: [&str; 6] = ["text", "name", "jump", "assign", "arith", "command"];

fn title_paths(variable: &str) -> Option<(PathBuf, PathBuf)> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus flow-statements real bytes: {variable} is unset");
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
            "SKIP siglus flow-statements real bytes: {variable} has no SiglusEngine.exe + \
             Scene.pck under {}",
            dir.display()
        );
        None
    }
}

/// Aggregate flow counters for one title's proof + eprintln summary.
#[derive(Default)]
struct TitleTotals {
    scene_count: usize,
    family_histogram: BTreeMap<String, usize>,
    text_runs: usize,
    name_runs: usize,
    jumps: usize,
    choice_units: usize,
    choice_arms: usize,
    underflow: FlowUnderflowReport,
}

fn exercise_title(exe_path: &Path, scene_path: &Path, label: &str) -> TitleTotals {
    let exe_bytes = std::fs::read(exe_path).expect("read real SiglusEngine.exe");
    let scene_bytes = std::fs::read(scene_path).expect("read real Scene.pck");

    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/exe-angou"));
    let recovery = recover_exe_angou_key(&exe_bytes, &key_ref)
        .unwrap_or_else(|error| panic!("{label}: exe-angou key recovery failed: {error}"));

    let index = parse_scene_pck(&scene_bytes).expect("real Scene.pck envelope parses");
    let mut totals = TitleTotals {
        scene_count: index.entries.len(),
        ..TitleTotals::default()
    };

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

        let flow = decode_scene_flow(&payload).unwrap_or_else(|error| {
            panic!("{label}: scene {} flow decode: {error}", entry.scene_id)
        });

        // (1) Named coverage: no unknown statement, one statement per instruction.
        assert_eq!(
            flow.unknown_family_count(),
            0,
            "{label}: scene {} left {} unknown statement(s)",
            entry.scene_id,
            flow.unknown_family_count()
        );
        assert_eq!(
            flow.statements.len(),
            flow.instruction_count,
            "{label}: scene {} statement/instruction count mismatch",
            entry.scene_id
        );

        // (2) Text surfaces: every CD_TEXT / CD_NAME carries a patch-back-ready
        // string-table ref + in-bounds byte-span.
        for surface in &flow.text_surfaces {
            assert!(
                surface.is_patchable(),
                "{label}: scene {} text surface at offset {} lacks a string-table ref + byte-span",
                entry.scene_id,
                surface.site_offset
            );
            let byte_offset = surface.str_byte_offset.expect("patchable byte offset");
            let char_len = surface.str_char_len.expect("patchable char len") as usize;
            assert!(
                byte_offset + char_len * 2 <= payload.len(),
                "{label}: scene {} text surface byte-span runs past the payload",
                entry.scene_id
            );
        }

        // (3) Resolved jumps: every label index resolves to an in-stream target.
        for jump in &flow.jumps {
            assert!(
                jump.target_offset.is_some(),
                "{label}: scene {} jump at offset {} (label {}) did not resolve",
                entry.scene_id,
                jump.site_offset,
                jump.label_index
            );
        }

        // (4) Choice units: each recognized unit links ≥2 arms.
        for unit in &flow.choice_units {
            assert!(
                unit.arms.len() >= 2,
                "{label}: scene {} choice unit at offset {} has {} arm(s)",
                entry.scene_id,
                unit.select_offset,
                unit.arms.len()
            );
        }

        // (5a) Cross-layer invariant: the flow layer's straight-line underflow
        // count reproduces siglus-09's exactly.
        let expr = decode_scene_expressions(&payload).unwrap_or_else(|error| {
            panic!(
                "{label}: scene {} expression decode: {error}",
                entry.scene_id
            )
        });
        assert_eq!(
            flow.underflow.linear_underflow, expr.stack_underflow_count,
            "{label}: scene {} flow linear-underflow disagrees with siglus-09",
            entry.scene_id
        );

        // (5b) Residual is fully attributed to the inter-procedural categories,
        // and the CD_POP (0x03) cross-edge class is fully resolved.
        assert!(
            flow.underflow.residual_fully_attributed(),
            "{label}: scene {} residual underflow is not fully attributed",
            entry.scene_id
        );
        assert!(
            !flow.underflow.residual_by_lead.contains_key("03"),
            "{label}: scene {} left an unresolved CD_POP cross-edge underflow",
            entry.scene_id
        );

        // (6) Determinism.
        let again = decode_scene_flow(&payload).expect("re-decode");
        assert_eq!(
            flow, again,
            "{label}: scene {} flow decode is not reproducible",
            entry.scene_id
        );

        for (family, count) in &flow.family_histogram {
            *totals.family_histogram.entry(family.clone()).or_insert(0) += count;
        }
        totals.text_runs += flow.text_run_count();
        totals.name_runs += flow.name_run_count();
        totals.jumps += flow.jumps.len();
        totals.choice_units += flow.choice_units.len();
        totals.choice_arms += flow
            .choice_units
            .iter()
            .map(|u| u.arms.len())
            .sum::<usize>();
        totals.underflow.merge(&flow.underflow);
    }

    eprintln!(
        "REAL {label}: scenes={} family={:?}",
        totals.scene_count, totals.family_histogram
    );
    eprintln!(
        "REAL {label}: text_runs={} name_runs={} jumps={} choice_units={} choice_arms={}",
        totals.text_runs, totals.name_runs, totals.jumps, totals.choice_units, totals.choice_arms
    );
    eprintln!(
        "REAL {label}: underflow linear={} flow={} resolved={} call_frame={} indirect={} \
         residual_by_lead={:?}",
        totals.underflow.linear_underflow,
        totals.underflow.flow_underflow,
        totals.underflow.resolved,
        totals.underflow.residual_call_frame,
        totals.underflow.residual_indirect,
        totals.underflow.residual_by_lead
    );

    totals
}

fn assert_title_invariants(totals: &TitleTotals, label: &str) {
    // Every listed opcode family is present and named on real bytes.
    for family in REQUIRED_FAMILIES {
        let count = totals.family_histogram.get(family).copied().unwrap_or(0);
        assert!(count > 0, "{label}: family '{family}' absent on real bytes");
    }
    assert_eq!(
        totals.family_histogram.get("unknown").copied().unwrap_or(0),
        0,
        "{label}: unknown statements present across the corpus"
    );

    // Text surfaces exist and every one was patch-back-ready (per-scene asserts).
    assert!(totals.text_runs > 0, "{label}: no text runs decoded");
    assert!(totals.name_runs > 0, "{label}: no speaker names decoded");

    // The choice pattern is recognized + linked where present.
    assert!(
        totals.choice_units > 0,
        "{label}: no select→conditional-jump choice units recognized"
    );
    assert!(
        totals.choice_arms >= totals.choice_units * 2,
        "{label}: choice units are under-linked"
    );

    // Underflow resolution: there was a real cross-edge residual, the flow layer
    // resolved the large majority of it, and the residual is fully attributed.
    let uf = &totals.underflow;
    assert!(
        uf.linear_underflow > 0,
        "{label}: no siglus-09 residual to resolve"
    );
    assert!(
        uf.flow_underflow < uf.linear_underflow,
        "{label}: flow layer resolved nothing"
    );
    assert!(
        uf.resolved * 100 >= uf.linear_underflow * 80,
        "{label}: flow layer resolved only {}/{} underflows (<80%)",
        uf.resolved,
        uf.linear_underflow
    );
    assert!(
        uf.residual_fully_attributed(),
        "{label}: aggregate residual not fully attributed"
    );
    assert!(
        !uf.residual_by_lead.contains_key("03"),
        "{label}: an unresolved CD_POP cross-edge underflow remains"
    );
}

#[test]
fn two_real_siglus_scene_packs_decode_all_statements_and_flow() {
    let Some((first_exe, first_scene)) = title_paths(FIRST_TITLE_ENV) else {
        return;
    };
    let Some((second_exe, second_scene)) = title_paths(SECOND_TITLE_ENV) else {
        return;
    };

    let first = exercise_title(&first_exe, &first_scene, "siglus-title-one");
    let second = exercise_title(&second_exe, &second_scene, "siglus-title-two");

    assert_title_invariants(&first, "siglus-title-one");
    assert_title_invariants(&second, "siglus-title-two");

    let mut observed = [first.scene_count, second.scene_count];
    let mut expected = EXPECTED_SCENE_COUNTS;
    observed.sort_unstable();
    expected.sort_unstable();
    assert_eq!(
        observed, expected,
        "expected the two owned titles' scene counts {EXPECTED_SCENE_COUNTS:?}, got {observed:?}"
    );
}
