//! Synthetic acceptance for `utsushi-reallive-jump-resume`.
//!
//! Proves the ENGINE-GENERAL positional-seek path of the jump/resume
//! capability without touching real game bytes: given a synthetic scene
//! store, [`ReplayEngine::jump_to`] resolves a `(scene, line)` target from the
//! decoded structure and lands DETERMINISTICALLY on it, and the reviewer
//! address seam round-trips. The real-bytes counterpart
//! (`jump_resume_real_bytes.rs`) exercises the frame fast-forward on Sweetie HD
//! Kanon.

use utsushi_reallive::{
    BytecodeElement, InMemorySceneStore, JumpError, JumpTarget, ReplayEngine, ReplayOpts, Scene,
};

/// A two-line synthetic scene: two `MetaLine` markers, byte-aligned. The
/// decode-derived source lines a `JumpTarget::Line` resolves against.
fn synthetic_scene(id: u16) -> Scene {
    let elements = vec![
        BytecodeElement::MetaLine {
            line_number: 5,
            byte_offset: 0,
            byte_len: 3,
        },
        BytecodeElement::MetaLine {
            line_number: 42,
            byte_offset: 3,
            byte_len: 3,
        },
    ];
    Scene::new(id, elements).expect("scene builds")
}

fn engine_with_scene(id: u16) -> ReplayEngine {
    let mut store = InMemorySceneStore::new();
    store.insert(synthetic_scene(id));
    ReplayEngine::from_store(store, std::collections::HashSet::new())
}

#[test]
fn scene_target_lands_at_scene_start_deterministically() {
    let engine = engine_with_scene(100);
    let opts = ReplayOpts::default();
    let target = JumpTarget::Scene { scene: 100 };

    let a = engine.jump_to(&target, &opts).expect("scene jump lands");
    let b = engine.jump_to(&target, &opts).expect("scene jump lands");

    assert_eq!(a.scene, 100);
    assert_eq!(a.pc, 0, "a Scene target lands at pc 0");
    assert_eq!(
        a.frame_index, None,
        "positional seek carries no frame index"
    );
    // Determinism: the same target lands on an identical frame/state.
    assert_eq!(a, b, "jumping to the same target lands identically");
}

#[test]
fn line_target_resolves_marker_pc_from_the_decode() {
    let engine = engine_with_scene(2031);
    let opts = ReplayOpts::default();

    // Line 42's MetaLine marker sits at byte offset 3 in the decode — the pc
    // the jump resolves, WITHOUT a hardcoded offset.
    let target = JumpTarget::Line {
        scene: 2031,
        line_number: 42,
    };
    let landing = engine.jump_to(&target, &opts).expect("line jump lands");
    assert_eq!(landing.scene, 2031);
    assert_eq!(landing.pc, 3, "line 42 resolves to its marker byte offset");

    // Determinism across runs.
    let again = engine.jump_to(&target, &opts).expect("line jump lands");
    assert_eq!(landing, again);

    // A different line lands on a DIFFERENT deterministic state.
    let other = engine
        .jump_to(
            &JumpTarget::Line {
                scene: 2031,
                line_number: 5,
            },
            &opts,
        )
        .expect("line 5 lands");
    assert_eq!(other.pc, 0);
    assert_ne!(
        landing.control_fingerprint, other.control_fingerprint,
        "distinct positions fold to distinct state fingerprints"
    );
}

#[test]
fn missing_scene_and_line_surface_typed_errors() {
    let engine = engine_with_scene(1);
    let opts = ReplayOpts::default();

    assert_eq!(
        engine.jump_to(&JumpTarget::Scene { scene: 999 }, &opts),
        Err(JumpError::SceneNotFound(999)),
    );
    assert_eq!(
        engine.jump_to(
            &JumpTarget::Line {
                scene: 1,
                line_number: 999
            },
            &opts,
        ),
        Err(JumpError::LineNotFound {
            scene: 1,
            line_number: 999,
        }),
    );
}

#[test]
fn reviewer_address_seam_round_trips_to_the_same_landing() {
    let engine = engine_with_scene(7);
    let opts = ReplayOpts::default();
    let target = JumpTarget::Line {
        scene: 7,
        line_number: 42,
    };

    let landing = engine.jump_to(&target, &opts).expect("jump lands");
    // A reviewer persists the address; a later session parses it back and
    // re-lands on the identical state.
    let address = landing.target.address();
    let reparsed = JumpTarget::from_address(&address).expect("address parses");
    let relanding = engine.jump_to(&reparsed, &opts).expect("re-land");
    assert_eq!(
        landing, relanding,
        "address round-trip re-lands identically"
    );
    // The annotation anchor is stable + reproducible.
    assert_eq!(landing.anchor(), relanding.anchor());
    assert!(landing.anchor().starts_with("reallive://scene/7/line/42@"));
}
