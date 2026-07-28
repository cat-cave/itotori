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
