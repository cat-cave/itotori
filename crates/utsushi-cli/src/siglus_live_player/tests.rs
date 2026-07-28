use super::*;
use kaifuu_siglus::GameexeDatEntry;
#[path = "tests/siglus_live_player_scan_tests.rs"]
mod scan;

fn opaque_black_frame() -> SiglusCgFrame {
    SiglusCgFrame {
        width: 800,
        height: 600,
        pixels_rgba: [0, 0, 0, 255].repeat(800 * 600),
    }
}

#[test]
fn authored_boundary_text_changes_the_composited_stage_frame() {
    let mut first = opaque_black_frame();
    let mut second = opaque_black_frame();
    composite_message_window(
        &mut first,
        &Moment::Text {
            scene_id: 7,
            offset: 11,
            speaker: None,
            text: "最初の実行済みメッセージ".to_string(),
        },
        MessageWindowProjection::default(),
    )
    .expect("the authored text boundary must rasterise onto its real stage frame");
    composite_message_window(
        &mut second,
        &Moment::Text {
            scene_id: 7,
            offset: 12,
            speaker: None,
            text: "次の実行済みメッセージ".to_string(),
        },
        MessageWindowProjection::default(),
    )
    .expect("a later authored text boundary must rasterise onto its real stage frame");

    assert_ne!(
        first.pixels_rgba, second.pixels_rgba,
        "deleting message-window compositing makes distinct authored boundaries produce the same stage-only frame"
    );
}

#[test]
fn decoded_mwnd_template_controls_message_projection() {
    let projection = MessageWindowProjection::from_gameexe(&[
        GameexeDatEntry {
            key: "SCREEN_SIZE".to_string(),
            value: "1280, 720".to_string(),
        },
        GameexeDatEntry {
            key: "MWND.000.WINDOW_POS".to_string(),
            value: "100, 500".to_string(),
        },
        GameexeDatEntry {
            key: "MWND.000.MESSAGE_POS".to_string(),
            value: "30, 40".to_string(),
        },
        GameexeDatEntry {
            key: "MWND.000.MOJI_SIZE".to_string(),
            value: "32".to_string(),
        },
    ]);

    assert_eq!(projection.message_rect(2560, 1440).0, 260);
    assert_eq!(projection.message_rect(2560, 1440).1, 1080);
    assert_eq!(projection.moji_size, 32);
}

#[test]
fn real_siglus_positioned_message_boundary_is_measured() {
    let Some(root) = std::env::var_os("ITOTORI_REAL_GAME_ROOT_SIGLUS").map(PathBuf::from) else {
        return;
    };
    let (title, scene_ids, _) = load_title(&root).expect("load real Siglus title");
    let mut text_scenes = 0usize;
    let mut positioned_scenes = 0usize;
    let mut renderable_scenes = 0usize;
    let mut positioned_renderable_scenes = 0usize;
    let mut text_boundaries = 0usize;
    let mut background_scenes = 0usize;
    let mut nonblack_background_text_scenes = 0usize;
    let mut detailed_background_text_scenes = 0usize;
    let mut positioned_boundaries = 0usize;
    let mut renderable_boundaries = 0usize;
    let mut positioned_renderable_boundary_count = 0usize;
    let mut positioned_renderable_boundaries = Vec::new();
    for scene_id in scene_ids {
        let mut state = VmState::default();
        let snapshots =
            match execute_title_scene_with_stage_snapshots_observed(&title, scene_id, &mut state)
                .expect("execute title scene")
            {
                ExecutionOutcome::Complete(report) | ExecutionOutcome::Terminal { report, .. } => {
                    report.stage_snapshots
                }
            };
        if snapshots.is_empty() {
            continue;
        }
        text_scenes += 1;
        text_boundaries += snapshots.len();
        let (has_background, nonblack, detailed) = scan::scene_background_stats(&root, &snapshots);
        background_scenes += usize::from(has_background);
        nonblack_background_text_scenes += usize::from(nonblack);
        detailed_background_text_scenes += usize::from(detailed);
        let positioned = snapshots.iter().any(has_nondefault_stage_position);
        let renderable = snapshots
            .iter()
            .any(|snapshot| has_renderable_stage(&root, snapshot));
        positioned_scenes += usize::from(positioned);
        renderable_scenes += usize::from(renderable);
        positioned_renderable_scenes += usize::from(positioned && renderable);
        let boundary_count = snapshots
            .iter()
            .filter(|snapshot| {
                has_nondefault_stage_position(snapshot) && has_renderable_stage(&root, snapshot)
            })
            .count();
        positioned_boundaries += snapshots
            .iter()
            .filter(|snapshot| has_nondefault_stage_position(snapshot))
            .count();
        renderable_boundaries += snapshots
            .iter()
            .filter(|snapshot| has_renderable_stage(&root, snapshot))
            .count();
        positioned_renderable_boundary_count += boundary_count;
        if boundary_count > 0 {
            positioned_renderable_boundaries.push((scene_id, boundary_count));
        }
    }
    eprintln!(
        "REAL siglus player boundaries: text_scenes={text_scenes} background_scenes={background_scenes} nonblack_background_text_scenes={nonblack_background_text_scenes} detailed_background_text_scenes={detailed_background_text_scenes} positioned_scenes={positioned_scenes} renderable_scenes={renderable_scenes} positioned_renderable_scenes={positioned_renderable_scenes} text_boundaries={text_boundaries} positioned_boundaries={positioned_boundaries} renderable_boundaries={renderable_boundaries} positioned_renderable_boundary_count={positioned_renderable_boundary_count} positioned_renderable_boundaries={positioned_renderable_boundaries:?}"
    );
    assert!(
        positioned_scenes > 0,
        "real title must retain positioned text boundaries"
    );
}
