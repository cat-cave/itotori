//! Real-bytes proof for the Softpal runtime port on the two owned titles.
//!
//! Env-gated on `ITOTORI_SOFTPAL_RESEARCH_ROOT` (the READ-ONLY Softpal research
//! tree, e.g. `/scratch/softpal-research`). When the corpus is absent the test
//! reports a SKIP (eprintln + return) and succeeds; when present it extracts
//! `SCRIPT.SRC` + `TEXT.DAT` from each title's `data.pac` via the kaifuu-softpal
//! PAC reader, EXECUTES the `Sv20` scene-dispatch through the port + `Runner`
//! lifecycle, and asserts the executed dialogue/choice stream matches the
//! recorded disassembly ground truth and that an edge-redacted PNG is captured.
//! No raw copyrighted text lives in this file — only command counts and the
//! PNG magic, which the runtime must reproduce.

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::PacArchive;
use tempfile::TempDir;
use utsushi_core::substrate::{PortRequest, Runner};
use utsushi_core::{RuntimeArtifactRoot, RuntimeOperation};
use utsushi_softpal::{SceneStep, UtsushiSoftpalPort};

const RESEARCH_ROOT_ENV: &str = "ITOTORI_SOFTPAL_RESEARCH_ROOT";

/// One title's recorded scene-dispatch ground truth (measured by the proven
/// kaifuu-softpal disassembler on real bytes).
struct TitleExpectation {
    subdir: &'static str,
    pac_count: usize,
    dialogue_count: usize,
    total_choices: usize,
    text_bearing_choices: usize,
    system_selects: usize,
}

const TITLES: [TitleExpectation; 2] = [
    // v21465 — every SELECT immediate is a text pointer (11 text-bearing choices).
    TitleExpectation {
        subdir: "v21465",
        pac_count: 417,
        dialogue_count: 30165,
        total_choices: 11,
        text_bearing_choices: 11,
        system_selects: 0,
    },
    // v60663 — decoupled-select variant: 16 story choices carry a label, 5 are
    // genuine out-of-pool system selects.
    TitleExpectation {
        subdir: "v60663",
        pac_count: 160,
        dialogue_count: 39832,
        total_choices: 21,
        text_bearing_choices: 16,
        system_selects: 5,
    },
];

fn find_data_pacs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            find_data_pacs(&path, out);
        } else if path.file_name().is_some_and(|name| name == "data.pac") {
            out.push(path);
        }
    }
}

/// Extract one named entry from the title's `data.pac` (selected by entry count).
fn extract_entry(title: &TitleExpectation, root: &Path, name: &str) -> Vec<u8> {
    let title_dir = root.join(title.subdir);
    let mut pacs = Vec::new();
    find_data_pacs(&title_dir, &mut pacs);
    assert!(
        !pacs.is_empty(),
        "no data.pac under {}",
        title_dir.display()
    );
    for pac_path in &pacs {
        let bytes = fs::read(pac_path).expect("read data.pac");
        let Ok(archive) = PacArchive::parse(&bytes) else {
            continue;
        };
        if archive.len() != title.pac_count {
            continue;
        }
        let entry = archive
            .find(name)
            .unwrap_or_else(|| panic!("{name} must be present in {}", pac_path.display()));
        return archive
            .extract(&bytes, entry)
            .expect("extract entry")
            .to_vec();
    }
    panic!(
        "no data.pac under {} parsed to {} entries",
        title_dir.display(),
        title.pac_count
    );
}

#[test]
fn softpal_runtime_executes_and_renders_two_real_titles() {
    let Some(root) = std::env::var_os(RESEARCH_ROOT_ENV).map(PathBuf::from) else {
        eprintln!("SKIP softpal runtime real bytes: {RESEARCH_ROOT_ENV} is unset");
        return;
    };
    if !root.is_dir() {
        eprintln!("SKIP softpal runtime real bytes: {RESEARCH_ROOT_ENV} is not a directory");
        return;
    }

    for title in &TITLES {
        let script = extract_entry(title, &root, "SCRIPT.SRC");
        let textdat = extract_entry(title, &root, "TEXT.DAT");

        let mut port = UtsushiSoftpalPort::with_extracted_scene(script, textdat, title.subdir)
            .with_playthrough_max(4);

        let artifacts = TempDir::new().expect("temp artifact root");
        let artifact_root = RuntimeArtifactRoot::new(artifacts.path().join("runtime-artifacts"));
        let run_id = format!("softpal-{}", title.subdir);
        let request = PortRequest::new(&root, &run_id, RuntimeOperation::Capture)
            .with_artifact_root(&artifact_root);

        let outcome = Runner::new()
            .run_capture(&mut port, &request)
            .expect("real EnginePort execute/render/capture lifecycle");

        // The executed scene matches the recorded disassembly ground truth.
        let scene = port.scene().expect("scene executed during launch");
        assert!(
            scene.stats.opcode_exhaustive,
            "{}: 0-unknown Sv20 walk",
            title.subdir
        );
        assert_eq!(scene.sv_version, *b"20", "{}: Sv20", title.subdir);
        assert_eq!(
            scene.stats.dialogue_count, title.dialogue_count,
            "{}: dialogue lines executed",
            title.subdir
        );
        assert_eq!(
            scene.stats.text_bearing_choice_count, title.text_bearing_choices,
            "{}: text-bearing choices",
            title.subdir
        );
        assert_eq!(
            scene.stats.system_select_count, title.system_selects,
            "{}: system selects",
            title.subdir
        );
        assert_eq!(
            scene.stats.text_bearing_choice_count + scene.stats.system_select_count,
            title.total_choices,
            "{}: every select classified",
            title.subdir
        );

        // Grouped menus account for exactly the recorded selects.
        let menu_options: usize = scene
            .steps
            .iter()
            .filter_map(|step| match step {
                SceneStep::Choice { options, .. } => Some(options.len()),
                SceneStep::Dialogue { .. } => None,
            })
            .sum();
        assert_eq!(
            menu_options, title.total_choices,
            "{}: options across menus",
            title.subdir
        );

        // Text emissions: one line per dialogue + one per text-bearing choice.
        let emitted_text: usize = outcome
            .observations
            .iter()
            .map(|observation| observation.text.len())
            .sum();
        assert_eq!(
            emitted_text,
            title.dialogue_count + title.text_bearing_choices,
            "{}: text lines emitted through the substrate sink",
            title.subdir
        );

        // Rendered a bounded playthrough of edge-redacted frames.
        let emitted_frames: usize = outcome
            .observations
            .iter()
            .map(|observation| observation.frames.len())
            .sum();
        assert_eq!(emitted_frames, 4, "{}: playthrough frames", title.subdir);

        let capture = outcome.capture.expect("capture outcome");
        assert!(
            capture
                .summary
                .as_deref()
                .is_some_and(|summary| summary.contains("redacted=true")),
            "{}: capture reports default redaction",
            title.subdir
        );
        let png =
            fs::read(capture.artifact_path.expect("managed PNG path")).expect("read capture PNG");
        assert_eq!(
            &png[..8],
            b"\x89PNG\r\n\x1a\n",
            "{}: capture is a PNG",
            title.subdir
        );

        eprintln!(
            "[{}] executed instructions={} calls={} control={} dialogue={} menus={} \
             text_choices={} system_selects={} frames={}",
            title.subdir,
            scene.stats.instructions_executed,
            scene.stats.call_count,
            scene.stats.control_count,
            scene.stats.dialogue_count,
            scene.stats.choice_menu_count,
            scene.stats.text_bearing_choice_count,
            scene.stats.system_select_count,
            emitted_frames,
        );
    }
}
