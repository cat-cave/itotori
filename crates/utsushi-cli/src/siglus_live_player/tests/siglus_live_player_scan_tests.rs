use super::super::*;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

#[test]
fn player_response_reports_the_real_nonbackground_pixel_count() {
    let boundary = RenderedBoundary {
        snapshot: StageSnapshot {
            scene_id: 1,
            offset: 2,
            instruction_pointer: 3,
            moment: Moment::Text {
                scene_id: 1,
                offset: 2,
                speaker: None,
                text: "text".to_string(),
            },
            state: VmState::default(),
        },
        private_path: PathBuf::from("private.png"),
        public_path: PathBuf::from("public.png"),
        private_sha256: "private".to_string(),
        public_sha256: "public".to_string(),
        width: 2,
        height: 1,
        non_background_pixels: non_background_pixel_count(&SiglusCgFrame {
            width: 2,
            height: 1,
            pixels_rgba: vec![0, 0, 0, 255, 1, 2, 3, 255],
        }),
    };
    assert_eq!(
        response(&boundary, 0, true, false)["frame"]["nonBackgroundPixels"],
        1
    );
}

#[test]
fn corpus_two_scene_85_renders_its_authored_bg01a01_text_boundary() {
    let Some(root) = corpus_registry::resolve_identity("siglus/2/encrypted").ok() else {
        return;
    };
    let (title, _, message_window) = load_title(&root).expect("load corpus-two Siglus title");
    let mut state = VmState::default();
    let report = match execute_title_scene_with_stage_snapshots_observed(&title, 85, &mut state)
        .expect("execute SceneList-designated scene 85")
    {
        ExecutionOutcome::Complete(report) => report,
        ExecutionOutcome::Terminal { error, .. } => {
            panic!("scene 85 must not stop at an unimplemented VM operation: {error}")
        }
    };
    let snapshot = report
        .stage_snapshots
        .iter()
        .find(|snapshot| {
            matches!(&snapshot.moment, Moment::Text { text, .. } if !text.is_empty())
                && snapshot
                    .state
                    .stage_objects
                    .get(&0)
                    .and_then(|slots| slots.get(&0))
                    .and_then(|object| object.identity.as_deref())
                    .is_some_and(|identity| identity.eq_ignore_ascii_case("bg01a01"))
        })
        .expect("scene 85 must retain a BG01A01 authored-text stage boundary");
    assert!(
        has_renderable_stage(&root, snapshot),
        "the authored lowercase stage identity must resolve the installed BG01A01.g00 bytes"
    );
    let mut cache = std::collections::HashMap::new();
    let mut frame = render_siglus_stage(&snapshot.state.stage_objects, |identity| {
        load_g00(&root, identity, &mut cache)
    })
    .expect("the executed BG01A01 stage state must composite");
    composite_message_window(&mut frame, &snapshot.moment, message_window)
        .expect("the executed authored text must composite over BG01A01");
    assert_eq!((frame.width, frame.height), (1920, 1080));
    assert!(
        non_background_pixel_count(&frame) > 1_000_000,
        "a real BG01A01 frame must not be a near-black or synthetic success"
    );
}

pub(super) fn scene_background_stats(
    root: &Path,
    snapshots: &[StageSnapshot],
) -> (bool, bool, bool) {
    let backgrounds = snapshots
        .iter()
        .filter_map(|snapshot| {
            snapshot
                .state
                .stage_objects
                .get(&0)?
                .get(&0)?
                .identity
                .as_deref()
        })
        .collect::<BTreeSet<_>>();
    let nonblack = backgrounds.iter().any(|identity| {
        !identity
            .strip_suffix(".g00")
            .unwrap_or(identity)
            .eq_ignore_ascii_case("black")
    });
    let detailed = backgrounds.iter().any(|identity| {
        let name = if identity.to_ascii_lowercase().ends_with(".g00") {
            (*identity).to_string()
        } else {
            format!("{identity}.g00")
        };
        std::fs::read(root.join("g00").join(name))
            .ok()
            .and_then(|bytes| decode_siglus_g00(&bytes).ok())
            .is_some_and(|image| {
                image.pixels_rgba.first_chunk::<4>().is_some_and(|first| {
                    image
                        .pixels_rgba
                        .chunks_exact(4)
                        .any(|pixel| pixel[..3] != first[..3])
                })
            })
    });
    (!backgrounds.is_empty(), nonblack, detailed)
}
