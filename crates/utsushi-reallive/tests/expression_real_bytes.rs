//! UTSUSHI-205 real-bytes integration test.
//!
//! Drives the UTSUSHI-201 → 202 → 203 → 204 → 205 chain end-to-end
//! against the Sweetie HD corpus, lifts the 20
//! [`utsushi_reallive::BytecodeElement::Expression`] elements out of
//! the scene #0001 decompressed bytecode, and runs
//! [`utsushi_reallive::parse_expression`] over each.
//!
//! The single real RealLive corpus currently staged is Sweetie HD; the
//! test is `#[ignore]`-gated and reads its asset root from
//! `ITOTORI_REAL_GAME_ROOT`. The acceptance bounds match the
//! UTSUSHI-205 spec node: ≥17 of 20 (85 %) of the Expression elements
//! must parse without any [`utsushi_reallive::ExpressionWarning`]; the
//! remaining ≤3 may emit `UnknownOperator` warnings against the
//! documented operator table.
//!
//! Each parsed expression is also evaluated against a zeroed
//! [`utsushi_reallive::VarBanks`] snapshot so the test surfaces any
//! panic / infinite-loop regression at evaluation time. The per-
//! expression AST kinds + evaluation outcomes are emitted via
//! `eprintln!` so CI logs preserve the trace for follow-up nodes.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    AvgDecompressor, BytecodeElement, EvaluationError, ExprNode, ExpressionWarning, RealSceneIndex,
    SCENE_HEADER_BYTE_LEN, SceneHeader, VarBanks, decode_bytecode_stream, evaluate,
    evaluate_assignment, parse_expression_with_warnings,
};

/// Relative path under the Sweetie HD extraction root that holds the
/// raw `Seen.txt` envelope. Mirrors
/// `tests/bytecode_element_real_bytes.rs` so a change to the
/// upstream fixture surfaces in both tests.

/// Documented Expression-element count for scene #0001. Pinned by the
/// UTSUSHI-204 real-bytes test ("20 Expressions" in the per-variant
/// histogram).
const SCENE_ONE_EXPECTED_EXPRESSION_COUNT: usize = 20;

/// Minimum number of expressions that must parse with no warning
/// (acceptance criterion from the UTSUSHI-205 task: ≥17 of 20 = 85 %).
const MIN_CLEAN_PARSE_COUNT: usize = 17;

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scene1_expression_elements_parse_and_evaluate() {
    let Some(seen_path) = real_seen_txt_path() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset; skipping Sweetie HD real-bytes test for \
             utsushi-reallive expression parser/evaluator (no silent pass: re-run with \
             ITOTORI_REAL_GAME_ROOT=/path/to/reallive-game-root)",
        );
        return;
    };

    let bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    // Walk the UTSUSHI-201 → 202 → 203 → 204 chain to recover the
    // decompressed scene-1 bytecode and lex its element stream.
    let index = RealSceneIndex::parse(&bytes)
        .expect("Sweetie HD Seen.txt must parse through the UTSUSHI-201 directory parser");
    let entry = index
        .lookup(1)
        .expect("Sweetie HD must contain a populated scene 1 entry");

    let blob_start =
        usize::try_from(entry.byte_offset).expect("file offset must fit in usize on this platform");
    let blob_end = blob_start
        .checked_add(entry.byte_len as usize)
        .expect("blob end must not overflow usize");
    let blob = &bytes[blob_start..blob_end];
    assert!(
        blob.len() >= SCENE_HEADER_BYTE_LEN,
        "scene 1 blob ({} bytes) must be at least the fixed header length ({})",
        blob.len(),
        SCENE_HEADER_BYTE_LEN,
    );

    let (header, _header_warnings) = SceneHeader::parse(blob)
        .expect("Sweetie HD scene 1 must produce a typed SceneHeader (UTSUSHI-202 anchor)");

    let bytecode_offset = header.bytecode_offset as usize;
    let bytecode_compressed_size = header.bytecode_compressed_size as usize;
    let compressed_end = bytecode_offset
        .checked_add(bytecode_compressed_size)
        .expect("bytecode end must not overflow usize");
    let compressed = &blob[bytecode_offset..compressed_end];

    let (decompressed, _warnings) = AvgDecompressor::new()
        .decompress(
            compressed,
            header.bytecode_uncompressed_size,
            None,
            header.compiler_version,
        )
        .expect("Sweetie HD scene 1 must decompress cleanly (UTSUSHI-203 anchor)");

    let elements = decode_bytecode_stream(&decompressed)
        .expect("Sweetie HD scene 1 decompressed bytes must lex (UTSUSHI-204 anchor)");

    // === UTSUSHI-205 surface under test ===
    let expression_raw_bytes: Vec<(usize, Vec<u8>)> = elements
        .iter()
        .filter_map(|element| match element {
            BytecodeElement::Expression {
                raw_bytes,
                byte_offset,
                ..
            } => Some((*byte_offset, raw_bytes.clone())),
            _ => None,
        })
        .collect();

    eprintln!(
        "[UTSUSHI-205 real-bytes] Sweetie HD scene #0001: found {} Expression elements \
         (expected {})",
        expression_raw_bytes.len(),
        SCENE_ONE_EXPECTED_EXPRESSION_COUNT,
    );
    assert_eq!(
        expression_raw_bytes.len(),
        SCENE_ONE_EXPECTED_EXPRESSION_COUNT,
        "scene #0001 must produce exactly {SCENE_ONE_EXPECTED_EXPRESSION_COUNT} Expression \
         elements (per the UTSUSHI-204 real-bytes histogram); got {}",
        expression_raw_bytes.len(),
    );

    let mut clean_parse_count = 0usize;
    let mut warning_parse_count = 0usize;
    let mut hard_failures: Vec<(usize, String)> = Vec::new();
    let mut variant_histogram: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut evaluation_outcomes: BTreeMap<&'static str, usize> = BTreeMap::new();

    for (idx, (byte_offset, raw)) in expression_raw_bytes.iter().enumerate() {
        let parsed = match parse_expression_with_warnings(raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                hard_failures.push((idx, format!("parse error: {err}")));
                continue;
            }
        };

        let variant = expr_variant_name(&parsed.node);
        *variant_histogram.entry(variant).or_insert(0) += 1;

        if parsed.warnings.is_empty() {
            clean_parse_count += 1;
        } else {
            warning_parse_count += 1;
            let warning_codes: Vec<&'static str> = parsed
                .warnings
                .iter()
                .map(ExpressionWarning::audit_code)
                .collect();
            eprintln!(
                "[UTSUSHI-205 real-bytes] expr #{idx:02} @ byte_offset=0x{byte_offset:04x} \
                 emitted warnings: {warning_codes:?}",
            );
        }

        // Evaluate against a zeroed banks snapshot. The bytes/structure
        // may reference banks; on a zeroed snapshot every memory ref
        // resolves to 0 so the evaluator must always terminate with a
        // finite result or a typed error — never panic or infinite-loop.
        let mut banks = VarBanks::new();
        let outcome = match &parsed.node {
            ExprNode::Assignment { .. } => match evaluate_assignment(&parsed.node, &mut banks) {
                Ok(value) => format!("assign_ok({value})"),
                Err(EvaluationError::BankIndexOutOfRange { .. }) => {
                    "assign_err(bank_index_out_of_range)".to_string()
                }
                Err(EvaluationError::UnknownBank { .. }) => "assign_err(unknown_bank)".to_string(),
                Err(EvaluationError::DivisionByZero) => "assign_err(div_by_zero)".to_string(),
                Err(other) => format!("assign_err({other})"),
            },
            _ => match evaluate(&parsed.node, &banks) {
                Ok(value) => format!("eval_ok({value})"),
                Err(EvaluationError::BankIndexOutOfRange { .. }) => {
                    "eval_err(bank_index_out_of_range)".to_string()
                }
                Err(EvaluationError::UnknownBank { .. }) => "eval_err(unknown_bank)".to_string(),
                Err(EvaluationError::DivisionByZero) => "eval_err(div_by_zero)".to_string(),
                Err(other) => format!("eval_err({other})"),
            },
        };
        // Bucket the outcomes coarsely so the eprintln summary stays
        // useful when the test runs in CI logs.
        let bucket: &'static str = if outcome.starts_with("eval_ok") {
            "eval_ok"
        } else if outcome.starts_with("assign_ok") {
            "assign_ok"
        } else if outcome.contains("bank_index_out_of_range") {
            "bank_index_out_of_range"
        } else if outcome.contains("unknown_bank") {
            "unknown_bank"
        } else if outcome.contains("div_by_zero") {
            "div_by_zero"
        } else {
            "other"
        };
        *evaluation_outcomes.entry(bucket).or_insert(0) += 1;

        eprintln!(
            "[UTSUSHI-205 real-bytes] expr #{idx:02} @ byte_offset=0x{byte_offset:04x} \
             ast={variant} outcome={outcome} raw_len={}",
            raw.len(),
        );
    }

    eprintln!("[UTSUSHI-205 real-bytes] per-variant AST histogram: {variant_histogram:?}",);
    eprintln!("[UTSUSHI-205 real-bytes] evaluation outcome buckets: {evaluation_outcomes:?}",);
    eprintln!(
        "[UTSUSHI-205 real-bytes] clean_parse_count={clean_parse_count} \
         warning_parse_count={warning_parse_count} \
         hard_failures={} (threshold: clean ≥ {MIN_CLEAN_PARSE_COUNT})",
        hard_failures.len(),
    );

    // -- Hard-failure assertion --
    assert!(
        hard_failures.is_empty(),
        "{} expression(s) failed to parse with a hard error — every real-bytes Expression must \
         either parse cleanly OR parse with an UnknownOperator warning (partial recovery): \
         {hard_failures:?}",
        hard_failures.len(),
    );

    // -- Clean-parse rate (acceptance criterion) --
    assert!(
        clean_parse_count >= MIN_CLEAN_PARSE_COUNT,
        "at least {MIN_CLEAN_PARSE_COUNT} of {SCENE_ONE_EXPECTED_EXPRESSION_COUNT} \
         Sweetie HD scene #0001 Expression elements must parse without warnings; got \
         clean={clean_parse_count}, with_warnings={warning_parse_count}",
    );

    // -- Variant distribution sanity --
    let parsed_total: usize = variant_histogram.values().sum();
    assert_eq!(
        parsed_total, SCENE_ONE_EXPECTED_EXPRESSION_COUNT,
        "every Expression must contribute exactly one row to the AST histogram",
    );
}

fn expr_variant_name(node: &ExprNode) -> &'static str {
    match node {
        ExprNode::IntLiteral(_) => "IntLiteral",
        ExprNode::StoreRegister => "StoreRegister",
        ExprNode::MemoryRef { .. } => "MemoryRef",
        ExprNode::BinaryOp { .. } => "BinaryOp",
        ExprNode::UnaryOp { .. } => "UnaryOp",
        ExprNode::Group(_) => "Group",
        ExprNode::Assignment { .. } => "Assignment",
    }
}

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}
