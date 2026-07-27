//! Read-only regression proof for the shipped Softpal structure producer.
//!
//! No retail bytes are committed. When the staged corpora are unavailable the
//! test reports the missing prerequisite and exits cleanly.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde_json::Value;
use tempfile::TempDir;

struct CorpusExpectation {
    root: &'static str,
    messages: usize,
    speakers: usize,
    choices: usize,
}

const CORPORA: [CorpusExpectation; 2] = [
    CorpusExpectation {
        root: "/scratch/corpus/softpal-1",
        messages: 30_165,
        speakers: 19_990,
        choices: 11,
    },
    CorpusExpectation {
        root: "/scratch/corpus/softpal-2",
        messages: 39_832,
        speakers: 28_665,
        choices: 16,
    },
];

#[test]
fn exports_complete_linear_structure_for_each_staged_corpus() {
    let output_root = TempDir::new().expect("temporary output root");
    for (index, corpus) in CORPORA.iter().enumerate() {
        let game_root = Path::new(corpus.root);
        if !game_root.is_dir() {
            eprintln!(
                "SKIP softpal structure corpus {}: staged root is unavailable at {}",
                index + 1,
                game_root.display()
            );
            continue;
        }
        let output = output_root
            .path()
            .join(format!("structure-{}.json", index + 1));
        let command = Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
            .args(["structure", "--engine", "softpal", "--game-root"])
            .arg(game_root)
            .args(["--output"])
            .arg(&output)
            .output()
            .expect("run structure producer");
        assert!(
            command.status.success(),
            "structure producer failed for corpus {}: {}",
            index + 1,
            String::from_utf8_lossy(&command.stderr)
        );

        let structure: Value = serde_json::from_slice(
            &fs::read(&output).expect("structure producer writes an artifact"),
        )
        .expect("structure artifact is JSON");
        let scene = &structure["scenes"][0];
        let messages = scene["messages"].as_array().expect("messages array");
        let speakers = messages
            .iter()
            .filter(|message| message["speaker"].is_string())
            .count();
        let choices = scene["choices"].as_array().expect("choices array");

        assert_eq!(structure["engine"], "softpal");
        assert_eq!(structure["scenes"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            messages.len(),
            corpus.messages,
            "corpus {} messages",
            index + 1
        );
        assert_eq!(speakers, corpus.speakers, "corpus {} speakers", index + 1);
        assert_eq!(
            choices.len(),
            corpus.choices,
            "corpus {} choices",
            index + 1
        );
        eprintln!(
            "softpal structure corpus {}: messages={} speakers={} choices={}",
            index + 1,
            messages.len(),
            speakers,
            choices.len(),
        );
    }
}
