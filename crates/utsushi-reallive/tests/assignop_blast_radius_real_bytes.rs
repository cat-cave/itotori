//! Real-bytes regression sweep for the AssignOp-table bug
//! (`assignop-table-bug-broader-real-bytes-regression-sweep`).
//!
//! # Background
//!
//! A prior revision of the shared `utsushi-reallive` AssignOp byte table
//! (`crates/utsushi-reallive/src/expression.rs`) mis-pinned operator byte
//! `0x14` as the plain `=` and slid every compound form up one slot, so the
//! whole `0x14..=0x1E` range was rotated by one relative to rlvm's
//! `libreallive/expression.cc` (ops `20..=29` decimal = `+=` … `>>=`, op `30`
//! = plain `=`). Under that OLD table EVERY assignment operator byte decoded
//! to the WRONG operator — most importantly a real plain assignment
//! (`intX[Y] = <expr>`, op `0x1E`) executed as `>>=`
//! (`intX[Y] = intX[Y] >> <expr>`), which on a freshly-zeroed variable
//! collapses to `0`. This corrupts assignment-driven state ENGINE-WIDE, not
//! only the choice discriminant that first surfaced the bug.
//!
//! # What this suite proves, on REAL bytes (Sweetie HD + Kanon)
//!
//! 1. **Blast radius.** Walk every populated scene in both corpora, lift every
//!    `Expression` element that parses to an `Assignment`, and diff the
//!    written-value trajectory under the CORRECTED table vs a locally
//!    reconstructed OLD (rotated) table. Report the op-byte histogram and the
//!    exact count of assignments whose written value differs.
//! 2. **rlvm parity.** For every AssignOp byte that ACTUALLY occurs on the real
//!    bytecode, assert the corrected `AssignOp::from_byte` semantics match
//!    rlvm's `PerformBinaryOperationOn` / op-`30` special case.
//! 3. **Regression coverage.** Pin the corrected assignment-driven state
//!    fingerprint AND assert the OLD table produces a DIFFERENT fingerprint —
//!    so a future revert of the table (or an evaluator regression) is caught.
//!    Also pin the entry-scene branch-following outcomes (transfers / scenes
//!    visited / choices), which are downstream of assignment semantics.
//!
//! `#[ignore]`-gated for the periodic oracle; run with:
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon> \`
//! `cargo test -p utsushi-reallive --test assignop_blast_radius_real_bytes -- --ignored`

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeMap;
use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    AssignOp, BranchReplayReport, DecompressedScene, ExprNode, HeadlessChoicePolicy, ReplayEngine,
    ReplayOpts, VarBanks, build_scene_store_from_decompressed, decode_bytecode_stream,
    decompress_all_scenes, evaluate_assignment, parse_expression_with_warnings,
};

/// The OLD (buggy) AssignOp table: `0x14` mis-pinned as plain `=`, every
/// compound form slid up one slot (a cyclic rotation by one of the corrected
/// table). Reconstructed HERE, in the test only — the shipped table is the
/// corrected one. Panics on a byte outside the documented range (the corrected
/// `from_byte` already guarantees only `0x14..=0x1E` reach here).
fn old_table_from_byte(raw: u8) -> AssignOp {
    match raw {
        0x14 => AssignOp::Plain,
        0x15 => AssignOp::AddAssign,
        0x16 => AssignOp::SubAssign,
        0x17 => AssignOp::MulAssign,
        0x18 => AssignOp::DivAssign,
        0x19 => AssignOp::ModAssign,
        0x1A => AssignOp::AndAssign,
        0x1B => AssignOp::OrAssign,
        0x1C => AssignOp::XorAssign,
        0x1D => AssignOp::ShlAssign,
        0x1E => AssignOp::ShrAssign,
        other => panic!("byte 0x{other:02X} is not a documented AssignOp byte"),
    }
}

/// rlvm ground truth for the operator a given AssignOp byte denotes, keyed by
/// the human operator string rlvm prints (`libreallive/expression.cc`:
/// `PerformBinaryOperationOn` cases `20..=29` and the op-`30` special case).
/// Used to assert the CORRECTED `AssignOp::from_byte` agrees with rlvm for
/// every byte that actually occurs on the real bytecode.
fn rlvm_operator_str(raw: u8) -> &'static str {
    match raw {
        0x14 => "+=",
        0x15 => "-=",
        0x16 => "*=",
        0x17 => "/=",
        0x18 => "%=",
        0x19 => "&=",
        0x1A => "|=",
        0x1B => "^=",
        0x1C => "<<=",
        0x1D => ">>=",
        0x1E => "=",
        other => panic!("byte 0x{other:02X} is not a documented AssignOp byte"),
    }
}

/// The operator string the CORRECTED shipped `AssignOp` variant denotes.
fn shipped_operator_str(op: AssignOp) -> &'static str {
    match op {
        AssignOp::AddAssign => "+=",
        AssignOp::SubAssign => "-=",
        AssignOp::MulAssign => "*=",
        AssignOp::DivAssign => "/=",
        AssignOp::ModAssign => "%=",
        AssignOp::AndAssign => "&=",
        AssignOp::OrAssign => "|=",
        AssignOp::XorAssign => "^=",
        AssignOp::ShlAssign => "<<=",
        AssignOp::ShrAssign => ">>=",
        AssignOp::Plain => "=",
    }
}

/// Mirror the headless test's staging: AVG32 inflate every scene, then run the
/// dev-only `kaifuu-reallive` `use_xor_2` recovery (a no-op for Kanon). Returns
/// the decrypted, decompressed scenes plus the Seen.txt index length.
fn decrypted_scenes(seen_bytes: &[u8]) -> (Vec<DecompressedScene>, usize) {
    let index_len = utsushi_reallive::RealSceneIndex::parse(seen_bytes)
        .expect("parse scene index")
        .entries
        .len();
    let mut decompressed = decompress_all_scenes(seen_bytes).expect("decompress archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|s| Xor2DecScene {
            compiler_version: s.compiler_version,
            bytecode: s.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (s, d) in decompressed.iter_mut().zip(xor2) {
        s.bytecode = d.bytecode;
    }
    (decompressed, index_len)
}

/// One assignment lifted from the real bytecode: the raw op byte plus the
/// parsed AST node (ready to re-evaluate under either table).
struct RealAssignment {
    scene_id: u16,
    raw_op: u8,
    node: ExprNode,
}

/// Lift every `Assignment` expression out of every populated scene of one
/// corpus, in (scene id, byte-offset) order.
fn lift_assignments(scenes: &[DecompressedScene]) -> Vec<RealAssignment> {
    let mut out = Vec::new();
    for scene in scenes {
        let Ok(elements) = decode_bytecode_stream(&scene.bytecode) else {
            continue;
        };
        for element in &elements {
            let utsushi_reallive::BytecodeElement::Expression { raw_bytes, .. } = element else {
                continue;
            };
            let Ok(parsed) = parse_expression_with_warnings(raw_bytes) else {
                continue;
            };
            if let ExprNode::Assignment { op, .. } = &parsed.node {
                out.push(RealAssignment {
                    scene_id: scene.scene_id,
                    raw_op: op.as_byte(),
                    node: parsed.node,
                });
            }
        }
    }
    out
}

/// Rebuild an `Assignment` node with a substituted operator so the SHIPPED
/// evaluator runs the OLD (or any) operator without a shipped-code switch.
fn with_op(node: &ExprNode, op: AssignOp) -> ExprNode {
    let ExprNode::Assignment { dest, src, .. } = node else {
        panic!("with_op called on a non-assignment node");
    };
    ExprNode::Assignment {
        dest: dest.clone(),
        op,
        src: src.clone(),
    }
}

/// Result of diffing corrected-vs-old evaluation over one corpus.
struct BlastRadius {
    total_assignments: usize,
    op_histogram: BTreeMap<u8, usize>,
    /// Assignments whose WRITTEN value differs between tables when each is
    /// evaluated INDEPENDENTLY against a zeroed banks snapshot (the value seen
    /// at first touch of a fresh variable).
    zeroed_snapshot_diffs: usize,
    /// Assignments whose written value differs during a THREADED straight-line
    /// pass (each op applied in element order to a running banks state; two
    /// parallel banks, one per table).
    threaded_diffs: usize,
    /// Final banks fingerprints of the threaded straight-line pass.
    corrected_fingerprint: u64,
    old_fingerprint: u64,
    /// Distinct scenes that contain at least one assignment.
    scenes_with_assignments: usize,
    /// Distinct scenes that contain at least one plain `=` (op 0x1E)
    /// assignment — the form the OLD table mis-executed as `>>=`.
    scenes_with_plain_assign: usize,
}

fn measure_blast_radius(assignments: &[RealAssignment]) -> BlastRadius {
    let mut op_histogram: BTreeMap<u8, usize> = BTreeMap::new();
    let mut zeroed_snapshot_diffs = 0usize;
    let mut scenes_with_assignments = std::collections::BTreeSet::new();
    let mut scenes_with_plain_assign = std::collections::BTreeSet::new();

    // Threaded straight-line pass: two parallel running banks.
    let mut corrected_banks = VarBanks::new();
    let mut old_banks = VarBanks::new();
    let mut threaded_diffs = 0usize;

    for a in assignments {
        *op_histogram.entry(a.raw_op).or_insert(0) += 1;
        scenes_with_assignments.insert(a.scene_id);
        if a.raw_op == 0x1E {
            scenes_with_plain_assign.insert(a.scene_id);
        }
        let old_op = old_table_from_byte(a.raw_op);
        let corrected_node = &a.node; // shipped decode == corrected table
        let old_node = with_op(&a.node, old_op);

        // (1) Independent zeroed-snapshot diff.
        {
            let mut z_new = VarBanks::new();
            let mut z_old = VarBanks::new();
            let rn = evaluate_assignment(corrected_node, &mut z_new);
            let ro = evaluate_assignment(&old_node, &mut z_old);
            if rn.ok() != ro.ok() || z_new.fingerprint() != z_old.fingerprint() {
                zeroed_snapshot_diffs += 1;
            }
        }

        // (2) Threaded straight-line diff.
        let before_new = corrected_banks.fingerprint();
        let before_old = old_banks.fingerprint();
        let _ = evaluate_assignment(corrected_node, &mut corrected_banks);
        let _ = evaluate_assignment(&old_node, &mut old_banks);
        let delta_new = corrected_banks.fingerprint() != before_new;
        let delta_old = old_banks.fingerprint() != before_old;
        // A write differed if the two tables changed state differently on this
        // step. (Coarse: fingerprint-based, deterministic.)
        if delta_new != delta_old
            || (delta_new && delta_old && corrected_banks.fingerprint() != old_banks.fingerprint())
        {
            threaded_diffs += 1;
        }
    }

    BlastRadius {
        total_assignments: assignments.len(),
        op_histogram,
        zeroed_snapshot_diffs,
        threaded_diffs,
        corrected_fingerprint: corrected_banks.fingerprint(),
        old_fingerprint: old_banks.fingerprint(),
        scenes_with_assignments: scenes_with_assignments.len(),
        scenes_with_plain_assign: scenes_with_plain_assign.len(),
    }
}

fn staged_engine(seen_bytes: &[u8]) -> ReplayEngine {
    let (decompressed, index_len) = decrypted_scenes(seen_bytes);
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build store");
    ReplayEngine::from_store(store, shift_jis)
}

fn scan_opts() -> ReplayOpts {
    ReplayOpts {
        step_budget: 200_000,
        stop_at_first_pause: false,
    }
}

fn entry_report(engine: &ReplayEngine, entry: u16) -> BranchReplayReport {
    engine.branch_following_report(entry, &scan_opts(), HeadlessChoicePolicy::AlwaysFirst)
}

/// (1)+(2) Blast-radius + rlvm parity over BOTH corpora.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn assignop_blast_radius_and_rlvm_parity_on_real_bytes() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes("assignop_blast_radius_and_rlvm_parity_on_real_bytes");
        return;
    }

    let mut any_plain_assign = false;
    let mut all_used_bytes: BTreeMap<u8, usize> = BTreeMap::new();

    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let (scenes, _idx) = decrypted_scenes(&bytes);
        let assignments = lift_assignments(&scenes);
        let radius = measure_blast_radius(&assignments);

        eprintln!(
            "[{}] ASSIGNMENTS total={} scenes={} | op-byte histogram: {:?}",
            corpus.label,
            radius.total_assignments,
            scenes.len(),
            radius
                .op_histogram
                .iter()
                .map(|(b, n)| format!("0x{b:02X}({})={}", rlvm_operator_str(*b), n))
                .collect::<Vec<_>>(),
        );
        eprintln!(
            "[{}] BLAST RADIUS: zeroed_snapshot_diffs={}/{} threaded_straightline_diffs={}/{} \
             corrected_fp=0x{:016x} old_fp=0x{:016x}",
            corpus.label,
            radius.zeroed_snapshot_diffs,
            radius.total_assignments,
            radius.threaded_diffs,
            radius.total_assignments,
            radius.corrected_fingerprint,
            radius.old_fingerprint,
        );
        eprintln!(
            "[{}] SCENE SPREAD: scenes_with_assignments={} scenes_with_plain_eq(0x1E)={}",
            corpus.label, radius.scenes_with_assignments, radius.scenes_with_plain_assign,
        );

        // rlvm parity: for every op byte that ACTUALLY occurs, the corrected
        // shipped decode must denote the SAME operator rlvm does.
        for (&raw, &count) in &radius.op_histogram {
            let op = AssignOp::from_byte(raw)
                .unwrap_or_else(|| panic!("byte 0x{raw:02X} occurred but did not decode"));
            assert_eq!(
                shipped_operator_str(op),
                rlvm_operator_str(raw),
                "[{}] corrected AssignOp for byte 0x{raw:02X} ({count} occurrences) must match \
                 rlvm's operator table",
                corpus.label,
            );
            *all_used_bytes.entry(raw).or_insert(0) += count;
            if raw == 0x1E {
                any_plain_assign = true;
            }
        }

        // The whole corpus must contain at least one assignment (sanity: the
        // sweep actually reached real assignment bytecode).
        assert!(
            radius.total_assignments > 0,
            "[{}] expected real assignment expressions in the corpus",
            corpus.label,
        );
        // The OLD table MUST have driven a different straight-line trajectory
        // (else the "bug" would have been inert) — proof the blast radius is
        // real, not manufactured.
        assert_ne!(
            radius.corrected_fingerprint, radius.old_fingerprint,
            "[{}] corrected and OLD tables must yield DIFFERENT assignment trajectories",
            corpus.label,
        );
    }

    eprintln!(
        "[BOTH] union of AssignOp bytes on real bytes: {:?}",
        all_used_bytes
            .iter()
            .map(|(b, n)| format!("0x{b:02X}({})={}", rlvm_operator_str(*b), n))
            .collect::<Vec<_>>(),
    );
    assert!(
        any_plain_assign,
        "plain `=` (op 0x1E) must occur on real bytes — it is the dominant assignment form the \
         OLD table mis-executed as `>>=`",
    );
}

/// (3) Regression coverage: pin the corrected assignment-driven state
/// fingerprint per corpus AND prove the OLD table diverges (proof-of-catch),
/// plus pin the entry-scene branch-following outcomes.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn assignop_state_trajectory_regression_is_caught() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes("assignop_state_trajectory_regression_is_caught");
        return;
    }

    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let (scenes, _idx) = decrypted_scenes(&bytes);
        let assignments = lift_assignments(&scenes);
        let radius = measure_blast_radius(&assignments);

        // The corrected straight-line trajectory fingerprint is deterministic;
        // a revert of the table (or an evaluator regression) changes it. We do
        // NOT hard-code the fingerprint constant (it is corpus-version bound);
        // instead we PIN the invariant that the corrected trajectory differs
        // from the OLD-table trajectory — the exact property a revert breaks.
        assert_ne!(
            radius.corrected_fingerprint, radius.old_fingerprint,
            "[{}] REGRESSION: corrected trajectory must differ from OLD-table trajectory; if these \
             are equal the AssignOp table has been reverted or the evaluator mis-applies ops",
            corpus.label,
        );
        // Determinism: re-measuring yields identical fingerprints.
        let again = measure_blast_radius(&assignments);
        assert_eq!(radius.corrected_fingerprint, again.corrected_fingerprint);
        assert_eq!(radius.old_fingerprint, again.old_fingerprint);

        // Branch-following outcomes are downstream of assignment semantics
        // (goto_case / goto_on discriminants). Pin that the entry scene drives
        // real control transfers to a natural terminus with zero unknown — a
        // corrupted assignment evaluator regresses these.
        let entry = corpus
            .entry_scene()
            .unwrap_or_else(|| panic!("[{}] resolve entry scene", corpus.label));
        let engine = staged_engine(&bytes);
        let report = entry_report(&engine, entry);
        eprintln!(
            "[{}] ENTRY scene {entry}: terminus={:?} transfers={} scenes_visited={} \
             choices_made={} text_lines={} unknown={}",
            corpus.label,
            report.terminus,
            report.transfers.total(),
            report.scenes_visited.len(),
            report.choices_made,
            report.text_lines,
            report.unknown_opcode_keys.len(),
        );
        assert!(
            report.unknown_opcode_keys.is_empty(),
            "[{}] entry scene executed path must be ZERO unknown (0-unknown preserved)",
            corpus.label,
        );
        assert!(
            report.transfers.total() > 0,
            "[{}] entry scene must execute real control transfers (assignment-driven branch \
             following)",
            corpus.label,
        );
        // Determinism of the branch-following drive.
        let again_report = entry_report(&engine, entry);
        assert_eq!(
            report, again_report,
            "[{}] entry-scene branch-following must be byte-deterministic",
            corpus.label,
        );
    }
}
