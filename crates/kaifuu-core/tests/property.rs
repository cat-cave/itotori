//! UNIV-011 — proptest property tests for the highest-risk kaifuu-core patch
//! logic: patch compatibility and protected-span preservation.
//!
//! # Determinism (fixed PUBLIC seeds + bounded case counts)
//!
//! Every property below drives proptest through a `TestRunner` seeded with a
//! FIXED public ChaCha seed and a BOUNDED case count, both documented as
//! threshold constants in [`kaifuu_core::contracts::proptest_thresholds`].
//! Fixing the seed makes the suite reproducible in CI: a counterexample always
//! shrinks from the same committed seed rather than a per-run random one, and
//! `failure_persistence` is disabled so there is no hidden `.proptest-regressions`
//! side channel — the seed in `contracts.rs` is the single source of truth.
//!
//!   * protected-span preservation:
//!     seed `PROTECTED_SPAN_PRESERVATION_SEED`, `PROTECTED_SPAN_PRESERVATION_CASES` cases.
//!   * patch compatibility:
//!     seed `PATCH_COMPATIBILITY_SEED`, `PATCH_COMPATIBILITY_CASES` cases.
//!
//! # Actionable diagnostics
//!
//! Each `prop_assert*` carries a message that names the invariant under test
//! and the offending generated input, so a failing case reports WHICH property
//! broke and on WHAT input (proptest additionally prints the minimal shrunk
//! counterexample and the fixed seed).

use kaifuu_core::contracts::proptest_thresholds::{
    PATCH_COMPATIBILITY_CASES, PATCH_COMPATIBILITY_SEED, PROTECTED_SPAN_PRESERVATION_CASES,
    PROTECTED_SPAN_PRESERVATION_SEED,
};
use kaifuu_core::{
    ByteSpan, EncodedStringSlot, EncodedStringSlotLayout, EncodedStringSlotProtectedSpan,
    OperationStatus, ProtectedSpanMapping, RedactedContentSummary,
    STRING_SLOT_PROTECTED_SPAN_MUTATION, SourceEncoding,
};
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

/// Build a `TestRunner` pinned to a fixed public seed and a bounded case count.
/// `failure_persistence` is disabled so the committed seed is the ONLY source
/// of reproducibility.
fn seeded_runner(seed: [u8; 32], cases: u32) -> TestRunner {
    TestRunner::new_with_rng(
        Config {
            cases,
            failure_persistence: None,
            ..Config::default()
        },
        TestRng::from_seed(RngAlgorithm::ChaCha, &seed),
    )
}

/// A generated protected-span-preservation scenario: a set of DISTINCT
/// protected tokens, the alphabetic filler between them, and the index of the
/// mapping to drop for the "mutation is caught" half of the property.
#[derive(Debug, Clone)]
struct PreservationInput {
    tokens: Vec<String>,
    fillers: Vec<String>,
    drop_index: usize,
}

fn preservation_input() -> impl Strategy<Value = PreservationInput> {
    (1usize..=6)
        .prop_flat_map(|token_count| {
            (
                proptest::collection::vec("[a-z]{1,4}", token_count),
                proptest::collection::vec("[a-z ]{0,5}", token_count.saturating_sub(1)),
                0usize..token_count,
            )
        })
        .prop_map(|(bodies, fillers, drop_index)| {
            // Index-prefix each token so the tokens are guaranteed DISTINCT and
            // no token is a substring of another; braces keep them disjoint
            // from the (brace-free) filler.
            let tokens = bodies
                .iter()
                .enumerate()
                .map(|(index, body)| format!("{{{index}_{body}}}"))
                .collect();
            PreservationInput {
                tokens,
                fillers,
                drop_index,
            }
        })
}

/// Assemble the target text plus the exact-offset protected-span mappings, and
/// a fixed-width slot whose byte budget cannot overflow (so the only diagnostic
/// that can fire is the protected-span-mutation one under test).
fn build_slot_and_mappings(
    input: &PreservationInput,
) -> (EncodedStringSlot, String, Vec<ProtectedSpanMapping>) {
    let mut target = String::new();
    let mut mappings = Vec::with_capacity(input.tokens.len());
    for (index, token) in input.tokens.iter().enumerate() {
        if index > 0 {
            target.push_str(input.fillers.get(index - 1).map_or("", String::as_str));
        }
        let start = target.len() as u64;
        target.push_str(token);
        let end = target.len() as u64;
        mappings.push(ProtectedSpanMapping::new(token.clone(), start, end));
    }

    let protected_spans = input
        .tokens
        .iter()
        .map(|token| EncodedStringSlotProtectedSpan::new(token.as_str()))
        .collect();
    let slot = EncodedStringSlot {
        slot_id: "univ-011-preservation-slot".to_string(),
        encoding: SourceEncoding::Utf8,
        // Generous budget: encoded target + headroom, so FixedWidth never
        // reports overflow and the protected-span invariant is isolated.
        byte_range: ByteSpan::new(0, target.len() as u64 + 64)
            .expect("non-empty budget for the generated target"),
        layout: EncodedStringSlotLayout::FixedWidth,
        protected_spans,
    };
    (slot, target, mappings)
}

/// Property (protected-span preservation): a fixed-width slot's preflight
/// PRESERVES every protected span iff a matching mapping is present.
///
///   * With the complete, correct mapping set the preflight passes with NO
///     protected-span-mutation diagnostic (preservation holds).
///   * Dropping ANY single mapping is ALWAYS caught: preflight fails with a
///     protected-span-mutation diagnostic that identifies the dropped token
///     by safe content metadata (no surviving mutation).
#[test]
fn property_protected_span_preservation_holds_and_detects_drop() {
    let mut runner = seeded_runner(
        PROTECTED_SPAN_PRESERVATION_SEED,
        PROTECTED_SPAN_PRESERVATION_CASES,
    );
    runner
        .run(&preservation_input(), |input| {
            let (slot, target, mappings) = build_slot_and_mappings(&input);
            let target_summary = RedactedContentSummary::from_text(&target);

            // Half 1: preservation holds for the complete mapping set.
            let complete = slot.preflight(&target, &mappings, None);
            prop_assert_eq!(
                complete.status.clone(),
                OperationStatus::Passed,
                "protected-span preservation: complete mappings must preflight-pass for target {}, got diagnostics {:?}",
                target_summary,
                complete.diagnostics
            );
            prop_assert!(
                complete
                    .diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic.code != STRING_SLOT_PROTECTED_SPAN_MUTATION),
                "protected-span preservation: complete mappings must not emit a protected-span-mutation diagnostic for target {}",
                target_summary
            );

            // Half 2: dropping one mapping is always caught, naming the token.
            let mut dropped = mappings.clone();
            let removed = dropped.remove(input.drop_index);
            let removed_summary = RedactedContentSummary::from_text(&removed.raw);
            let after_drop = slot.preflight(&target, &dropped, None);
            let mutation_diagnostics: Vec<_> = after_drop
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == STRING_SLOT_PROTECTED_SPAN_MUTATION)
                .collect();
            prop_assert!(
                !mutation_diagnostics.is_empty(),
                "protected-span preservation SURVIVOR: dropping the mapping for token {} from target {} was NOT caught",
                removed_summary,
                target_summary
            );
            prop_assert!(
                mutation_diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.message.contains(removed_summary.sha256())),
                "protected-span preservation: the mutation diagnostic must identify the dropped token {}; got {:?}",
                removed_summary,
                mutation_diagnostics
                    .iter()
                    .map(|diagnostic| diagnostic.message.clone())
                    .collect::<Vec<_>>()
            );
            prop_assert_eq!(
                after_drop.status,
                OperationStatus::Failed,
                "protected-span preservation: a dropped mapping must fail preflight for target {}",
                target_summary
            );
            Ok(())
        })
        .expect("protected-span-preservation property holds for the fixed seed");
}

/// A generated patch-compatibility scenario: a protected token, its source
/// span identity (span id + source byte range), and the byte length so the
/// source end stays strictly after the start.
#[derive(Debug, Clone)]
struct CompatibilityInput {
    raw: String,
    span_id: String,
    source_start: u64,
    source_end: u64,
}

fn compatibility_input() -> impl Strategy<Value = CompatibilityInput> {
    ("[a-z]{1,6}", "[a-z0-9]{4,12}", 0u64..1000, 1u64..500).prop_map(
        |(body, span_body, source_start, source_len)| CompatibilityInput {
            raw: format!("{{{body}}}"),
            span_id: format!("span-{span_body}"),
            source_start,
            source_end: source_start + source_len,
        },
    )
}

/// Property (patch compatibility): a protected-span mapping carrying full
/// source identity is compatible with EXACTLY the source span it was built
/// from, and REJECTS any single-field drift (raw / span id / start / end) — the
/// core check that keeps a translated patch from binding to a drifted source.
/// Also covers target-text compatibility round-tripping.
#[test]
fn property_patch_compatibility_matches_source_identity_and_rejects_drift() {
    let mut runner = seeded_runner(PATCH_COMPATIBILITY_SEED, PATCH_COMPATIBILITY_CASES);
    runner
        .run(&compatibility_input(), |input| {
            let CompatibilityInput {
                raw,
                span_id,
                source_start,
                source_end,
            } = input;

            let mapping = ProtectedSpanMapping::new(raw.as_str(), 0, raw.len() as u64)
                .with_source_identity(Some(span_id.as_str()), source_start, source_end);

            // Compatible with the exact source identity it was built from.
            prop_assert!(
                mapping.matches_source_span(
                    &raw,
                    Some(source_start),
                    Some(source_end),
                    Some(span_id.as_str())
                ),
                "patch compatibility: mapping must match its own source identity (raw {:?}, span {:?}, {}..{})",
                raw,
                span_id,
                source_start,
                source_end
            );

            // Rejects drift in each identity field individually.
            let drifted_raw = format!("{raw}X");
            prop_assert!(
                !mapping.matches_source_span(
                    &drifted_raw,
                    Some(source_start),
                    Some(source_end),
                    Some(span_id.as_str())
                ),
                "patch-compatibility SURVIVOR: raw drift {:?}->{:?} was accepted",
                raw,
                drifted_raw
            );
            let drifted_span = format!("{span_id}X");
            prop_assert!(
                !mapping.matches_source_span(
                    &raw,
                    Some(source_start),
                    Some(source_end),
                    Some(drifted_span.as_str())
                ),
                "patch-compatibility SURVIVOR: span-id drift {:?}->{:?} was accepted",
                span_id,
                drifted_span
            );
            prop_assert!(
                !mapping.matches_source_span(
                    &raw,
                    Some(source_start + 1),
                    Some(source_end),
                    Some(span_id.as_str())
                ),
                "patch-compatibility SURVIVOR: source-start drift {}->{} was accepted",
                source_start,
                source_start + 1
            );
            prop_assert!(
                !mapping.matches_source_span(
                    &raw,
                    Some(source_start),
                    Some(source_end + 1),
                    Some(span_id.as_str())
                ),
                "patch-compatibility SURVIVOR: source-end drift {}->{} was accepted",
                source_end,
                source_end + 1
            );

            // Target-text compatibility round-trip: a mapping located in a
            // target matches that target and its slice equals the raw, but does
            // NOT match an unrelated target.
            let target = format!("pre {raw} post");
            let located = ProtectedSpanMapping::first_in_target(&raw, &target)
                .expect("raw is present in the constructed target");
            prop_assert!(
                located.matches_target_text(&target),
                "patch compatibility: located mapping must match its target {:?}",
                target
            );
            prop_assert!(
                !located.matches_target_text("x"),
                "patch-compatibility SURVIVOR: located mapping for {:?} matched an unrelated target",
                raw
            );
            Ok(())
        })
        .expect("patch-compatibility property holds for the fixed seed");
}
