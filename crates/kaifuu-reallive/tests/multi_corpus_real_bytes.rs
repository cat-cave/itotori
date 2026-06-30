//! FIX-4 multi-game-validation real-bytes harness.
//!
//! Project law (`docs/orchestration-operating-model.md`,
//! multi-game-validation): RealLive engine-family behaviour must validate
//! against **>= 2 real RealLive games**. On main only Oshioki Sweetie HD was
//! staged; FIX-4 sources a second genuine RealLive title (Kanon, a 1.2.6.8
//! fan-patched / rlBabel tree) and exposes it to this harness via
//! [`real_corpus::REAL_GAME_ROOT_2_ENV`] (`ITOTORI_REAL_GAME_ROOT_2`).
//!
//! # What this test proves (and what it deliberately does NOT)
//!
//! This is the *availability + validation-runs* gate, not a 100%-decompile
//! gate. It asserts:
//! - each staged corpus resolves, is a real RealLive SEEN archive with >= 1
//!   populated scene;
//! - when two corpora are staged their SEEN archives have **distinct
//!   sha256** (audit-focus: "2nd corpus actually Sweetie HD again" — caught
//!   here);
//! - the merged decompiler **runs** over every scene of every corpus without
//!   panicking and recognises non-trivial real structure.
//!
//! It then prints a sanitized per-corpus decompiler-coverage report (clean /
//! parse-failed / unknown-command scene counts, opcode histogram, and the
//! unrecognised `(module_type, module_id, opcode)` signatures with
//! frequencies). **No raw copyrighted bytes or text are emitted — counts,
//! offsets, opcode signatures and sha256 only.**
//!
//! # Honest 100%-decompilation status (the FIX-4 finding)
//!
//! Per the 100%-decompilation law, the bar is ZERO unknown opcodes / ZERO
//! parse failures on real bytes. This harness records the measured coverage
//! and does **not** relax any floor. Full-archive 100% decompilation is
//! **not yet proven on either corpus**, but the layers are now separable:
//!
//! - **Expression grammar (`reallive-expr-eval-bank-refs`) — DONE.** The
//!   ExpressionPiece evaluator implements the full RealLive reference grammar;
//!   `malformed_expression_scenes` is asserted ZERO across the whole corpus-2
//!   (Kanon) archive (was 66). corpus-1 (Sweetie HD) carries additional
//!   `goto_case` command framing and embedded-binary / Shift-JIS-text Textout
//!   framing whose desync surfaces residual malformed spans — owned by other
//!   nodes, so its count is reported, not asserted-zero.
//! - **Command-module catalogue / text framing — OPEN.** Across the full
//!   archives many scenes still bucket commands as `Unknown` or hit
//!   command/text framing `parse_failures`. The per-signature frequencies
//!   printed here are the input the orchestrator uses to scope those
//!   follow-up nodes.
//!
//! This test's contract is corpus availability + harness execution + the
//! expression-grammar zero-malformed bar, NOT full decompilation completeness.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeMap;
use std::fs;

use kaifuu_reallive::{
    RealLiveOpcode, RealLiveParseError, SceneHeader, decompress_avg32, parse_archive,
    parse_real_bytecode,
};

use real_corpus::RealCorpus;

/// Sanitized per-corpus decompiler coverage. Counts/offsets/signatures only.
struct CoverageReport {
    label: &'static str,
    seen_sha256: String,
    populated_scenes: usize,
    clean_scenes: usize,
    scenes_with_unknown: usize,
    parse_failures: usize,
    /// Of `parse_failures`, the count whose first decode error is a
    /// `MalformedExpression` — i.e. the ExpressionPiece evaluator was handed
    /// a byte that is not a valid expression token. This is the metric the
    /// `reallive-expr-eval-bank-refs` node drives to zero: a complete
    /// expression-reference grammar produces none of these.
    malformed_expression_scenes: usize,
    total_opcodes: usize,
    total_unknown: usize,
    histogram: BTreeMap<&'static str, usize>,
    unknown_signatures: BTreeMap<(u8, u8, u16), usize>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    // Minimal dependency-free SHA-256 so the harness can prove the two
    // corpora are distinct games without pulling a hashing crate into the
    // test target.
    sha256::digest_hex(bytes)
}

fn decompile_corpus(corpus: &RealCorpus) -> CoverageReport {
    let bytes = fs::read(&corpus.seen_txt)
        .unwrap_or_else(|err| panic!("read {}: {err}", corpus.seen_txt.display()));
    let index = parse_archive(&bytes).unwrap_or_else(|diag| {
        panic!(
            "{} SEEN archive must parse as a RealLive 10,000-slot envelope; got {diag:?}",
            corpus.label
        )
    });

    let mut report = CoverageReport {
        label: corpus.label,
        seen_sha256: sha256_hex(&bytes),
        populated_scenes: index.entries.len(),
        clean_scenes: 0,
        scenes_with_unknown: 0,
        parse_failures: 0,
        malformed_expression_scenes: 0,
        total_opcodes: 0,
        total_unknown: 0,
        histogram: BTreeMap::new(),
        unknown_signatures: BTreeMap::new(),
    };

    for entry in &index.entries {
        let off = entry.byte_offset as usize;
        let end = off + entry.byte_len as usize;
        if end > bytes.len() {
            report.parse_failures += 1;
            continue;
        }
        let blob = &bytes[off..end];
        let Ok(header) = SceneHeader::parse(blob) else {
            report.parse_failures += 1;
            continue;
        };
        let bo = header.bytecode_offset as usize;
        let bc = header.bytecode_compressed_size as usize;
        let bu = header.bytecode_uncompressed_size as usize;
        if bo + bc > blob.len() {
            report.parse_failures += 1;
            continue;
        }
        let Ok(decompressed) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            report.parse_failures += 1;
            continue;
        };
        let opcodes = match parse_real_bytecode(&decompressed) {
            Ok(opcodes) => opcodes,
            Err(err) => {
                report.parse_failures += 1;
                if matches!(err, RealLiveParseError::MalformedExpression { .. }) {
                    report.malformed_expression_scenes += 1;
                }
                continue;
            }
        };

        let total = opcodes.len();
        let unknown = opcodes.iter().filter(|op| !op.is_recognized()).count();
        report.total_opcodes += total;
        report.total_unknown += unknown;
        if unknown == 0 {
            report.clean_scenes += 1;
        } else {
            report.scenes_with_unknown += 1;
        }
        for op in &opcodes {
            *report.histogram.entry(op.label()).or_insert(0) += 1;
            if let RealLiveOpcode::Unknown { opcode, raw_bytes } = op
                && *opcode == 0x23
                && raw_bytes.len() >= 5
            {
                let sig = (
                    raw_bytes[1],
                    raw_bytes[2],
                    u16::from_le_bytes([raw_bytes[3], raw_bytes[4]]),
                );
                *report.unknown_signatures.entry(sig).or_insert(0) += 1;
            }
        }
    }

    report
}

fn print_report(report: &CoverageReport) {
    eprintln!(
        "[{}] seen_sha256={} populated_scenes={} clean(0-unknown)={} \
         scenes_with_unknown={} parse_failures={} malformed_expression_scenes={} \
         total_opcodes={} total_unknown={}",
        report.label,
        report.seen_sha256,
        report.populated_scenes,
        report.clean_scenes,
        report.scenes_with_unknown,
        report.parse_failures,
        report.malformed_expression_scenes,
        report.total_opcodes,
        report.total_unknown,
    );
    eprintln!("[{}] opcode histogram (label -> count):", report.label);
    for (label, count) in &report.histogram {
        eprintln!("    {label}: {count}");
    }
    if !report.unknown_signatures.is_empty() {
        eprintln!(
            "[{}] UNRECOGNISED command (module_type, module_id, opcode) -> count:",
            report.label
        );
        for ((mt, mid, oc), count) in &report.unknown_signatures {
            eprintln!("    ({mt:>3}, {mid:>3}, {oc:>5}): {count}");
        }
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (+ ITOTORI_REAL_GAME_ROOT_2 for multi-game)"]
fn multi_game_validation_runs_against_two_distinct_reallive_corpora() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::skip_or_require_real_bytes(
            "multi_game_validation_runs_against_two_distinct_reallive_corpora \
             (set ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_GAME_ROOT_2)",
        );
        return;
    }

    let reports: Vec<CoverageReport> = corpora.iter().map(decompile_corpus).collect();
    for report in &reports {
        print_report(report);

        // Each staged corpus must be a real RealLive SEEN archive with real
        // populated scenes (no silent zero-state).
        assert!(
            report.populated_scenes > 0,
            "[{}] SEEN archive parsed but has zero populated scenes",
            report.label
        );
        // The merged decompiler must actually engage the real bytes: at
        // least one scene must decode into recognised structure. (This is
        // an availability/execution check, NOT a 100%-recognition floor.)
        assert!(
            report.total_opcodes > 0,
            "[{}] decompiler ran but produced no opcodes for any scene",
            report.label
        );
        assert!(
            report.clean_scenes + report.scenes_with_unknown > 0,
            "[{}] no scene decoded at all (every scene hit a hard parse failure)",
            report.label
        );
    }

    // ---- reallive-expr-eval-bank-refs: expression-grammar completeness ----
    //
    // The ExpressionPiece evaluator now implements the full RealLive
    // reference grammar — integer banks (`$ <bank> [ <index> ]`), string
    // banks, store register (`0xC8` / `$ 0xC8`), array indexing, complex and
    // special (`0x61`) parameters, and bare / `"`-quoted string constants
    // (including the `"[…]"` form the old "byte-before-`[`" heuristic
    // misread). The bar (project law: NO floor relaxed) is ZERO
    // `MalformedExpression` on a full real archive.
    //
    // corpus-2 (Kanon) is the clean-command-framing second RealLive title
    // that isolates the expression grammar: it is asserted to ZERO malformed
    // expressions across its WHOLE archive (was 66 before this node). corpus-1
    // (Sweetie HD) additionally carries `goto_case`-class command framing and
    // embedded-binary / Shift-JIS-text Textout framing whose desync surfaces
    // residual malformed-expression spans; those are owned by the command-
    // module-catalogue and text-framing nodes, NOT the expression evaluator,
    // so corpus-1's count is reported (not asserted-zero) here. Sweetie HD's
    // expression grammar is independently pinned malformed-free on scene 1 by
    // `scene_1_dispatch_real_bytes`.
    for report in &reports {
        eprintln!(
            "[{}] MALFORMED-EXPRESSION scenes: {}",
            report.label, report.malformed_expression_scenes
        );
        if report.label == "corpus-2" {
            assert_eq!(
                report.malformed_expression_scenes, 0,
                "[{}] expression-reference grammar incomplete: {} scene(s) still \
                 fail with MalformedExpression on the full archive (the bar is zero; \
                 no floor may be relaxed)",
                report.label, report.malformed_expression_scenes
            );
        }
    }

    // Multi-game-validation core assertion: when two corpora are staged they
    // must be DIFFERENT games. Directly defeats the FIX-4 audit-focus
    // "2nd corpus actually Sweetie HD again".
    if reports.len() >= 2 {
        assert_ne!(
            reports[0].seen_sha256, reports[1].seen_sha256,
            "multi-game validation requires two DISTINCT RealLive titles; both \
             corpus roots resolved to the same SEEN archive (sha256 match)"
        );
    } else {
        // With ITOTORI_REQUIRE_REAL_BYTES=1 the operator demanded the full
        // multi-game run; a single corpus is then a hard failure.
        assert!(
            !real_corpus::require_real_bytes(),
            "{}=1 demands multi-game coverage, but only one RealLive corpus \
             resolved; set {} to a second, distinct RealLive title",
            real_corpus::REQUIRE_REAL_BYTES_ENV,
            real_corpus::REAL_GAME_ROOT_2_ENV,
        );
    }

    // Honest 100%-decompilation status line (NOT an assertion — the floor is
    // never relaxed, and completeness is owned by a follow-up extension node).
    for report in &reports {
        let pct_clean = if report.populated_scenes > 0 {
            (report.clean_scenes as f64) / (report.populated_scenes as f64) * 100.0
        } else {
            0.0
        };
        eprintln!(
            "[{}] 100%-DECOMPILE STATUS: {}/{} scenes fully recognised ({pct_clean:.1}%); \
             {} parse failures, {} scenes with unknown commands -> {}",
            report.label,
            report.clean_scenes,
            report.populated_scenes,
            report.parse_failures,
            report.scenes_with_unknown,
            if report.parse_failures == 0 && report.total_unknown == 0 {
                "PROVEN (zero unknowns, zero parse failures)"
            } else {
                "NEEDS DECOMPILER EXTENSION (see signatures above)"
            },
        );
    }
}

/// Dependency-free SHA-256 for corpus distinctness checks.
mod sha256 {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    pub fn digest_hex(data: &[u8]) -> String {
        let mut h: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
            0x5be0cd19,
        ];
        let mut msg = data.to_vec();
        let bit_len = (data.len() as u64) * 8;
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bit_len.to_be_bytes());

        for chunk in msg.chunks_exact(64) {
            let mut w = [0u32; 64];
            for (i, word) in w.iter_mut().enumerate().take(16) {
                let j = i * 4;
                *word = u32::from_be_bytes([chunk[j], chunk[j + 1], chunk[j + 2], chunk[j + 3]]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16]
                    .wrapping_add(s0)
                    .wrapping_add(w[i - 7])
                    .wrapping_add(s1);
            }
            let mut v = h;
            for i in 0..64 {
                let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
                let ch = (v[4] & v[5]) ^ ((!v[4]) & v[6]);
                let t1 = v[7]
                    .wrapping_add(s1)
                    .wrapping_add(ch)
                    .wrapping_add(K[i])
                    .wrapping_add(w[i]);
                let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
                let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
                let t2 = s0.wrapping_add(maj);
                v[7] = v[6];
                v[6] = v[5];
                v[5] = v[4];
                v[4] = v[3].wrapping_add(t1);
                v[3] = v[2];
                v[2] = v[1];
                v[1] = v[0];
                v[0] = t1.wrapping_add(t2);
            }
            for (hi, vi) in h.iter_mut().zip(v.iter()) {
                *hi = hi.wrapping_add(*vi);
            }
        }

        let mut out = String::with_capacity(64);
        for word in h {
            out.push_str(&format!("{word:08x}"));
        }
        out
    }

    #[test]
    fn sha256_known_vector() {
        // FIPS-180 "abc" test vector.
        assert_eq!(
            digest_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            digest_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
