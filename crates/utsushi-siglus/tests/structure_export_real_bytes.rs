//! Optional real-byte proof for the Siglus common structure projection.
//!
//! The corpus is private and read-only. CI without it emits a clean skip;
//! configured runs must exercise two independent installations.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use utsushi_siglus::build_siglus_structure;

const FIRST_CORPUS_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_CORPUS_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

#[test]
fn exports_nontrivial_structure_for_two_real_siglus_corpora() {
    let Some(first) = corpus_root(FIRST_CORPUS_ENV) else {
        return;
    };
    let Some(second) = corpus_root(SECOND_CORPUS_ENV) else {
        return;
    };

    assert_nontrivial_structure(&first, "corpus-1");
    assert_nontrivial_structure(&second, "corpus-2");
}

fn corpus_root(variable: &str) -> Option<PathBuf> {
    let Some(value) = std::env::var_os(variable) else {
        eprintln!("SKIP Siglus structure real bytes: {variable} is unset");
        return None;
    };
    let candidate = PathBuf::from(value);
    let root = if candidate.is_dir() {
        candidate
    } else {
        candidate.parent().map(Path::to_path_buf)?
    };
    for required in ["Scene.pck", "Gameexe.dat", "SiglusEngine.exe"] {
        if !root.join(required).is_file() {
            eprintln!("SKIP Siglus structure real bytes: {variable} lacks {required}");
            return None;
        }
    }
    Some(root)
}

fn assert_nontrivial_structure(root: &Path, label: &str) {
    let structure = build_siglus_structure(&root.join("Scene.pck"), &root.join("Gameexe.dat"))
        .unwrap_or_else(|error| panic!("{label}: structure export failed: {error}"));
    let scenes = structure["scenes"]
        .as_array()
        .unwrap_or_else(|| panic!("{label}: scenes is not an array"));
    let message_count: usize = scenes
        .iter()
        .map(|scene| scene["messages"].as_array().map_or(0, Vec::len))
        .sum();
    let choice_count: usize = scenes
        .iter()
        .map(|scene| scene["choices"].as_array().map_or(0, Vec::len))
        .sum();
    if label == "corpus-1" {
        assert_eq!(scenes.len(), 298, "{label}: scene coverage regressed");
        assert_eq!(
            message_count, 57_323,
            "{label}: static message coverage regressed"
        );
    }
    let resolved_speakers: Vec<_> = scenes
        .iter()
        .flat_map(|scene| scene["messages"].as_array().into_iter().flatten())
        .filter_map(|message| message["speaker"].as_str())
        .collect();
    let distinct_speakers = resolved_speakers.iter().copied().collect::<BTreeSet<_>>();

    assert!(scenes.len() > 1, "{label}: structure has too few scenes");
    assert!(message_count > 1, "{label}: structure has too few messages");
    assert!(choice_count > 0, "{label}: structure has no choices");
    assert!(
        !resolved_speakers.is_empty(),
        "{label}: CD_NAME labels were not joined onto dialogue"
    );
    assert!(
        !distinct_speakers.is_empty(),
        "{label}: speaker join has no distinct display names"
    );
    assert!(
        distinct_speakers.len() < message_count,
        "{label}: speaker join produced an implausible display name per message"
    );
    let samples: Vec<_> = scenes
        .iter()
        .flat_map(|scene| scene["messages"].as_array().into_iter().flatten())
        .filter_map(|message| Some((message["speaker"].as_str()?, message["text"].as_str()?)))
        .take(5)
        .collect();
    eprintln!(
        "REAL {label}: messages={message_count} choices={choice_count} speaker_non_null={} speaker_distinct={} samples={samples:?}",
        resolved_speakers.len(),
        distinct_speakers.len(),
    );
    for scene in scenes {
        let choices = scene["choices"]
            .as_array()
            .unwrap_or_else(|| panic!("{label}: choices is not an array"));
        let indices = choices
            .iter()
            .filter_map(|choice| choice["optionIndex"].as_u64())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            indices.len(),
            choices.len(),
            "{label}: repeated choice index"
        );
    }
}
