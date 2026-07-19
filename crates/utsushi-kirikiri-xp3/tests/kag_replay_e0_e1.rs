//! KAG plaintext replay evidence over the committed CC0 corpus manifest.
//!
//! The bridge extractor is a test-only oracle: the emitted trace must use its
//! actual ids for the same manifest-declared source files. The test never
//! contains an id literal and obtains corpus membership only from the manifest
//! file path below.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use kaifuu_kirikiri::parse_ks;
use serde_json::Value;
use utsushi_kirikiri_xp3::{KagReplayInput, emit_kag_replay_e0_e1_trace};

const CORPUS_MANIFEST_PATH: &str = "fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json";
const SNAPSHOT_PATH: &str = "fixtures/kag-corpus-e0-e1-trace.json";
const STAGED_CORPUS_ROOT_ENV: &str = "UTSUSHI_KAG_CORPUS_ROOT";

struct CorpusScript {
    source_file: String,
    bytes: Vec<u8>,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load_corpus(root: &Path) -> Vec<CorpusScript> {
    let manifest_path = root.join(CORPUS_MANIFEST_PATH);
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", manifest_path.display())),
    )
    .expect("corpus manifest is JSON");
    manifest["files"]
        .as_array()
        .expect("corpus manifest files array")
        .iter()
        .map(|entry| {
            let relative_path = entry["path"].as_str().expect("corpus file path");
            let source_file = Path::new(relative_path)
                .file_name()
                .expect("corpus file name")
                .to_string_lossy()
                .into_owned();
            CorpusScript {
                source_file,
                bytes: std::fs::read(root.join(relative_path))
                    .unwrap_or_else(|error| panic!("read {relative_path}: {error}")),
            }
        })
        .collect()
}

fn emit(corpus: &[CorpusScript]) -> String {
    let inputs: Vec<KagReplayInput<'_>> = corpus
        .iter()
        .map(|script| KagReplayInput {
            source_file: &script.source_file,
            bytes: &script.bytes,
        })
        .collect();
    emit_kag_replay_e0_e1_trace(&inputs)
        .to_deterministic_json()
        .expect("trace JSON")
}

fn extracted_bridge_ids(corpus: &[CorpusScript]) -> BTreeSet<String> {
    corpus
        .iter()
        .flat_map(|script| parse_ks(&script.source_file, &script.bytes).units)
        .map(|unit| unit.bridge_unit_id)
        .collect()
}

fn assert_trace_bridge_links(corpus: &[CorpusScript], rendered: &str) {
    let trace: Value = serde_json::from_str(rendered).expect("emitted trace JSON");
    assert_eq!(trace["engine_family"], "kirikiri_xp3");
    assert_eq!(trace["runtime"], "kag-plaintext");
    assert_eq!(trace["source_evidence_tier"], "E0");
    assert_eq!(trace["evidence_tier"], "E1");

    let real_ids = extracted_bridge_ids(corpus);
    let events = trace["events"].as_array().expect("trace events array");
    let text_ids: Vec<&str> = events
        .iter()
        .filter(|event| event["event_type"] == "text_event")
        .filter_map(|event| event["bridge_unit_id"].as_str())
        .collect();
    let label_jump_ids: Vec<&str> = events
        .iter()
        .filter(|event| event["event_type"] == "label_jump_event")
        .filter_map(|event| event["bridge_unit_id"].as_str())
        .collect();

    assert!(
        !text_ids.is_empty(),
        "trace must contain at least one bridge-linked text_event"
    );
    assert!(
        !label_jump_ids.is_empty(),
        "trace must contain at least one bridge-linked label_jump_event"
    );
    for id in text_ids.into_iter().chain(label_jump_ids) {
        assert!(
            real_ids.contains(id),
            "trace bridge id {id} is absent from {CORPUS_MANIFEST_PATH}",
        );
    }
}

#[test]
fn replay_emits_deterministic_bridge_linked_e0_e1_trace_for_manifest_corpus() {
    let corpus = load_corpus(&repo_root());
    let first = emit(&corpus);
    let second = emit(&corpus);
    assert_eq!(first, second, "replay trace must not include volatile data");
    let snapshot_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(SNAPSHOT_PATH);
    let snapshot = std::fs::read_to_string(&snapshot_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", snapshot_path.display()));
    assert_eq!(format!("{first}\n"), snapshot, "trace snapshot drift");
    assert_trace_bridge_links(&corpus, &first);
}

#[test]
fn configured_corpus_replay_skips_when_root_is_not_staged() {
    let Some(root) = std::env::var_os(STAGED_CORPUS_ROOT_ENV).map(PathBuf::from) else {
        eprintln!("SKIP: {STAGED_CORPUS_ROOT_ENV} not staged");
        return;
    };
    if !root.is_dir() {
        eprintln!("SKIP: {} not staged", root.display());
        return;
    }
    let corpus = load_corpus(&root);
    assert_trace_bridge_links(&corpus, &emit(&corpus));
}
