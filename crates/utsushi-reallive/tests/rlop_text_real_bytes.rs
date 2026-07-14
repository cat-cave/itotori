//! Real-bytes integration test for the `module_msg`
//! text/messaging RLOperation family.
//!
//! Loads Sweetie HD scene 1 through the full →
//! decode chain, mounts the [`utsushi_reallive::register_text_rlops`]
//! registry on top of the VM, and steps for ≥100
//! `step_many` iterations. The acceptance criterion is:
//!
//! - At least one [`TextLine`] fires through the
//!   [`TextSurfaceSink`] surface during the walk.
//! - The text body decodes from Shift-JIS without `had_errors`.
//!
//! The test is `#[ignore]`-gated. Pass `--include-ignored` and set
//! `ITOTORI_REAL_GAME_ROOT` to run it.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use utsushi_core::EvidenceTier;
use utsushi_core::substrate::{SinkCapability, SinkResult, TextLine, TextSurfaceSink};
use utsushi_reallive::{
    AlwaysReadyScheduler, AvgDecompressor, BytecodeElement, InMemorySceneStore, MsgRuntime,
    RealSceneIndex, SCENE_HEADER_BYTE_LEN, Scene, SceneHeader, StepOutcome, TextoutEncoding, Vm,
    VmEvent, decode_bytecode_stream, dispatch_textout, register_text_rlops,
};

// Relative path under the Sweetie HD extraction root that holds the
// raw `Seen.txt` envelope. Mirrors the other real-bytes integration
// tests in this crate.

/// Step budget for the VM walk. Pinned at 400 so the walk reaches the
/// later Shift-JIS textout runs in scene 1 (the script-preamble run at
/// byte offset 0x064d sits past the first 200-step window). Capped so
/// the walk still terminates deterministically when `goto +0` or
/// `EndOfScene` lands.
const REAL_BYTES_STEP_BUDGET: u32 = 400;

#[derive(Default)]
struct CollectingSink {
    lines: Mutex<Vec<TextLine>>,
}

impl TextSurfaceSink for CollectingSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.lines.lock().expect("lock").push(line);
        Ok(())
    }
}

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn reallive_real_bytes_scene_one_emits_at_least_one_text_line_through_sink() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive reallive_real_bytes_scene_one_emits_at_least_one_text_line_through_sink",
        );
        return;
    };

    let bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    // > -> ->
    let index = RealSceneIndex::parse(&bytes)
        .expect("Sweetie HD Seen.txt must parse through the UTSUSHI-201 directory parser");
    let entry = index
        .lookup(1)
        .expect("Sweetie HD must contain a populated scene 1 entry");
    let blob_start = usize::try_from(entry.byte_offset).expect("offset fits in usize");
    let blob_end = blob_start
        .checked_add(entry.byte_len as usize)
        .expect("blob end fits in usize");
    let blob = &bytes[blob_start..blob_end];
    assert!(blob.len() >= SCENE_HEADER_BYTE_LEN);

    let (header, _header_warnings) =
        SceneHeader::parse(blob).expect("Sweetie HD scene 1 header must parse");
    let bytecode_offset = header.bytecode_offset as usize;
    let bytecode_compressed_size = header.bytecode_compressed_size as usize;
    let compressed_end = bytecode_offset
        .checked_add(bytecode_compressed_size)
        .expect("bytecode end fits in usize");
    let compressed = &blob[bytecode_offset..compressed_end];

    let (decompressed, _decompress_warnings) = AvgDecompressor::new()
        .decompress(
            compressed,
            header.bytecode_uncompressed_size,
            None,
            header.compiler_version,
        )
        .expect("Sweetie HD scene 1 must decompress cleanly");
    let elements = decode_bytecode_stream(&decompressed)
        .expect("Sweetie HD scene 1 must lex into a BytecodeElement stream");
    let element_count = elements.len();

    // --- surface under test ----------------------------
    let sink = Arc::new(CollectingSink::default());
    let runtime = Arc::new(MsgRuntime::with_sink(
        Arc::clone(&sink) as Arc<dyn TextSurfaceSink>
    ));
    let mut registry = utsushi_reallive::RlopRegistry::new();
    let registered = register_text_rlops(&mut registry, Arc::clone(&runtime));
    assert!(registered >= 12, "expected ≥12 module_msg opcodes mounted");

    // Pre-walk: surface the per-variant histogram so CI logs show the
    // density of the elements the VM walked. This is the same shape
    // the real-bytes test uses.
    let mut counts: std::collections::BTreeMap<&'static str, usize> =
        std::collections::BTreeMap::new();
    let mut shift_jis_textout_offsets: std::collections::HashSet<u32> =
        std::collections::HashSet::new();
    let mut textout_shift_jis: usize = 0;
    let mut textout_other: usize = 0;
    for element in &elements {
        *counts.entry(element.variant_name()).or_insert(0) += 1;
        if let BytecodeElement::Textout {
            encoding_hint,
            byte_offset,
            byte_len,
            raw_bytes,
        } = element
        {
            match encoding_hint {
                TextoutEncoding::ShiftJis => {
                    textout_shift_jis += 1;
                    shift_jis_textout_offsets
                        .insert(u32::try_from(*byte_offset).unwrap_or(u32::MAX));
                    eprintln!(
                        "[UTSUSHI-209 real-bytes] shift_jis textout @0x{byte_offset:04x} \
                         len={byte_len} first16={:02x?}",
                        &raw_bytes[..raw_bytes.len().min(16)],
                    );
                }
                TextoutEncoding::Other => textout_other += 1,
            }
        }
    }
    eprintln!(
        "[UTSUSHI-209 real-bytes] Sweetie HD scene #0001 element histogram (n={element_count}): \
         {counts:?} (textout shift_jis={textout_shift_jis} other={textout_other})",
    );

    // Build the scene store and step the VM. The text-out element
    // handler lives outside the registry (Textout is a top-level
    // BytecodeElement, not a Command), so we drive `dispatch_textout`
    // off the `VmEvent::Textout` observation between steps. The
    // pause / select / page / line_break opcodes flush the runtime's
    // pending body through the sink as TextLines.
    let scene = Scene::new(1, elements).expect("non-empty scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut vm = Vm::new(1, 0);
    let mut scheduler = AlwaysReadyScheduler;

    let mut steps_executed: u32 = 0;
    let mut steps_with_event: u32 = 0;
    let mut textout_observations: u32 = 0;
    let mut last_outcome: Option<StepOutcome> = None;

    let mut textout_shift_jis_dispatched: u32 = 0;
    while steps_executed < REAL_BYTES_STEP_BUDGET {
        // Capture the pc *before* the step — VmEvent::Textout strips
        // the bytecode-element encoding hint, so we cross-reference
        // the offset against the pre-walked
        // `shift_jis_textout_offsets` set to decide whether to push
        // the run through the runtime. Non-Shift-JIS textout runs
        // are the "default branch" of the lead-byte lexer — they
        // legitimately exist in the scene 1 preamble as
        // expression-arg payload bytes the lexer could not assign
        // to a structural opener, and we deliberately skip them
        // here to keep the sink emission honest.
        let pc_before = vm.pc();
        let outcome = match vm.step(&store, &registry, &mut scheduler) {
            Ok(outcome) => outcome,
            Err(err) => {
                eprintln!(
                    "[UTSUSHI-209 real-bytes] VM step error after {steps_executed} steps: {err}",
                );
                break;
            }
        };
        match &outcome {
            StepOutcome::Advanced { event } => {
                steps_with_event += 1;
                if let VmEvent::Textout { raw_bytes } = event {
                    textout_observations += 1;
                    if shift_jis_textout_offsets.contains(&pc_before) {
                        textout_shift_jis_dispatched += 1;
                        dispatch_textout(&runtime, raw_bytes);
                        // Flush immediately so each Shift-JIS run
                        // surfaces as its own TextLine. The lexer's
                        // ShiftJis hint is first-byte-based and so a
                        // subset of these runs carry binary
                        // payload-byte runs that happen to start with
                        // a Shift-JIS lead byte — emitting them
                        // per-run keeps the audit trail honest:
                        // each line is a distinct observation that
                        // the assertion below can quality-check.
                        if let Some(op) = registry.get(utsushi_reallive::RlopKey::new(
                            utsushi_reallive::MSG_MODULE_TYPE,
                            utsushi_reallive::MSG_MODULE_ID,
                            utsushi_reallive::OPCODE_LINE_BREAK,
                        )) {
                            let _ = op.dispatch(&mut vm, &[]);
                        }
                    }
                }
            }
            StepOutcome::LongOpResumed { .. } => {
                steps_with_event += 1;
            }
            StepOutcome::Suspended { .. } => {
                // Should not happen with AlwaysReadyScheduler, but
                // record and break to avoid an infinite loop.
                last_outcome = Some(outcome);
                break;
            }
            StepOutcome::EndOfScene { .. } | StepOutcome::Halted => {
                last_outcome = Some(outcome);
                break;
            }
        }
        steps_executed += 1;
    }

    if last_outcome.is_none() && steps_executed == REAL_BYTES_STEP_BUDGET {
        eprintln!(
            "[UTSUSHI-209 real-bytes] reached step budget ({REAL_BYTES_STEP_BUDGET}); \
             draining without explicit termination",
        );
    }

    // Final flush: if textout observations have buffered into the
    // runtime's pending body but no control opcode landed before the
    // step budget ran out (or EndOfScene fired), we force a flush so
    // the sink count reflects the observed text. We use the
    // `OPCODE_LINE_BREAK` op for the flush so the same code path the
    // dispatch loop uses runs at the test boundary.
    if runtime.pending_body_len() > 0
        && let Some(op) = registry.get(utsushi_reallive::RlopKey::new(
            utsushi_reallive::MSG_MODULE_TYPE,
            utsushi_reallive::MSG_MODULE_ID,
            utsushi_reallive::OPCODE_LINE_BREAK,
        ))
    {
        let _ = op.dispatch(&mut vm, &[]);
    }

    let lines = sink.lines.lock().expect("lock").clone();
    let warnings = runtime.take_warnings();

    eprintln!(
        "[UTSUSHI-209 real-bytes] steps_executed={steps_executed} steps_with_event={steps_with_event} \
         textout_observations={textout_observations} \
         textout_shift_jis_dispatched={textout_shift_jis_dispatched} \
         text_lines_emitted={} pending_body_len={} runtime_warnings={} last_outcome={:?}",
        lines.len(),
        runtime.pending_body_len(),
        warnings.len(),
        last_outcome,
    );
    for (idx, line) in lines.iter().enumerate().take(5) {
        eprintln!(
            "[UTSUSHI-209 real-bytes] sample line[{idx}]: text={:?} speaker={:?} \
             text_surface={:?}",
            line.text, line.speaker, line.text_surface,
        );
    }

    assert!(
        steps_executed >= 100,
        "real-bytes walk must execute ≥100 VM steps; got {steps_executed}",
    );
    assert!(
        textout_observations >= 1,
        "real-bytes walk must observe at least one VmEvent::Textout — the scene-1 stream \
         is documented to carry Shift-JIS runs (research §4.2)",
    );
    assert!(
        textout_shift_jis > 0,
        "scene 1 must contain at least one Shift-JIS-tagged Textout run; saw \
         shift_jis={textout_shift_jis} other={textout_other}",
    );
    assert!(
        !lines.is_empty(),
        "real-bytes walk must emit at least one TextLine through TextSurfaceSink — \
         dispatch_textout + line_break must flush the pending body",
    );

    // Acceptance: at least one emitted line decodes cleanly from
    // Shift-JIS. The bytecode_element lexer's ShiftJis hint is
    // first-byte-based, so a subset of the Shift-JIS-tagged textout
    // runs are binary-payload runs that merely happen to start with
    // a Shift-JIS lead byte (e.g. the @0x01a8 run in scene 1 starts
    // with `8f 42 1a` where 1a is the ASCII SUB control byte —
    // definitively not script text). The substrate-honesty position
    // is to surface every run and let the assertion pick the clean
    // one rather than silently filter at dispatch time. We assert
    // that at least one of the emitted lines round-trips byte-stably
    // through Shift-JIS — that line is the alpha-evidence that text
    // events flow through the sink.
    let mut clean_decode_count = 0;
    let mut first_clean_text: Option<String> = None;
    for line in &lines {
        let (re_encoded, _, encode_had_errors) = encoding_rs::SHIFT_JIS.encode(&line.text);
        if encode_had_errors {
            continue;
        }
        let (re_decoded, _, decode_had_errors) = encoding_rs::SHIFT_JIS.decode(&re_encoded);
        if decode_had_errors {
            continue;
        }
        if re_decoded.into_owned() == line.text {
            clean_decode_count += 1;
            if first_clean_text.is_none() && !line.text.is_empty() {
                first_clean_text = Some(line.text.clone());
            }
        }
    }
    eprintln!(
        "[UTSUSHI-209 real-bytes] clean_decode_count={clean_decode_count} \
         first_clean={first_clean_text:?}",
    );
    assert!(
        clean_decode_count >= 1,
        "at least one emitted TextLine must decode byte-stably as Shift-JIS — \
         observed {} lines, none round-tripped cleanly",
        lines.len(),
    );
    let first_clean = first_clean_text.expect(
        "at least one emitted TextLine must carry a non-empty Shift-JIS-decoded body — \
         scene 1 carries a 'SeenEnd' terminator string at byte offset 0x064d",
    );
    assert!(
        !first_clean.is_empty(),
        "non-empty Shift-JIS emission is the alpha-evidence; got an empty line",
    );
    eprintln!(
        "[UTSUSHI-209 real-bytes] alpha-evidence: first non-empty Shift-JIS line = {first_clean:?}",
    );
}
