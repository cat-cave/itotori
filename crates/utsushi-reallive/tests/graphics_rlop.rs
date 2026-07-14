//! Integration tests for the graphics RLOperation family
//! (`module_grp` + `module_obj_management` + `module_obj_fg_bg`).
//!
//! Pins the alpha-tier acceptance criteria from the spec:
//!
//! 1. Synthetic: every opcode produces an observable mutation through
//!    [`GraphicsRuntime::state_snapshot`]. The per-op assertions live
//!    in the in-crate unit tests; this file pins the end-to-end
//!    "registry mounts the full alpha-tier opcode union" surface and
//!    the layer-ordering audit-focus pin against the real headless
//!    render pipeline.
//! 2. Real-bytes gated: `grp_openbg_bg01a1_registers_bg_plane` reads
//!    Sweetie HD's `$GAME/REALLIVEDATA/g00/BG01A1.g00` through a
//!    typed [`AssetPackage`] and pins that the `openBg` opcode
//!    registers the bg plane background with a typed
//!    `(width=1280, height=720)` canvas.
//!
//! # Multi-game posture
//!
//! Per the itotori operating model, a parser that targets a real
//! engine substrate must be exercised against at least two real corpora
//! before its node is merged-complete. Sweetie HD is the only RealLive
//! title currently staged. This
//! crate's sibling parsers landed under the
//! same single-corpus posture, and the spec node explicitly accepts
//! the multi-game gap. The commit message records the single-corpus
//! posture explicitly.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};

use utsushi_reallive::{
    ExprValue, GRP_MODULE_ID, GraphicsObjectKind, GraphicsPlane, GraphicsRuntime, GrpOp,
    GrpRenderOp, OBJ_FG_CREATION_ID, OBJ_FG_SETTER_ID, ObjCreateOp, ObjSetOp, ObjSetProp,
    RLOperation, RenderPass, RlopKey, RlopRegistry, SCREEN_DC_SLOT, Vm, WipeColour,
    register_render_rlops,
};

const BG01A1_FILENAME: &str = "BG01A1.g00";
const BG01A1_WIDTH: u32 = 1280;
const BG01A1_HEIGHT: u32 = 720;

fn real_g00_dir() -> Option<PathBuf> {
    real_corpus::reallivedata_subdir("g00")
}

/// Synthetic [`AssetPackage`] that resolves `g00/<NAME>.g00` against a
/// real on-disk directory. Only used by the gated real-bytes test —
/// the substrate-honest VFS surface gets exercised end-to-end without
/// dragging in a Sweetie-specific composite package.
#[derive(Debug)]
struct OnDiskG00Package {
    g00_dir: PathBuf,
}

impl OnDiskG00Package {
    fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }
}

impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "utsushi-215-on-disk-g00"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: "utsushi-215-on-disk-g00".to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName("utsushi-215-on-disk-g00".to_string()),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        Ok(path.exists())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let meta = fs::metadata(&path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(meta.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let bytes = fs::read(&path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

fn strip_g00_prefix(logical: &str) -> &str {
    logical.strip_prefix("g00/").unwrap_or(logical)
}

fn runtime_with_registry() -> (Arc<GraphicsRuntime>, RlopRegistry) {
    let runtime = Arc::new(GraphicsRuntime::new());
    let mut registry = RlopRegistry::new();
    register_render_rlops(&mut registry, Arc::clone(&runtime));
    (runtime, registry)
}

fn int(v: i32) -> ExprValue {
    ExprValue::Int(v)
}

fn bytes(v: &[u8]) -> ExprValue {
    ExprValue::Bytes(v.to_vec())
}

#[test]
fn render_family_mounts_real_opcode_numbers_under_all_lattice_types() {
    let (_rt, registry) = runtime_with_registry();
    // The real render family fires on every observed compiler lattice type.
    for module_type in [0u8, 1, 2] {
        // grp.openBg (73), grp.grpBuffer (70), grp.grpDisplay (72).
        for op in [70u16, 72, 73] {
            assert!(
                registry
                    .get(RlopKey::new(module_type, GRP_MODULE_ID, op))
                    .is_some(),
                "grp opcode {op} must resolve at module_type {module_type}",
            );
        }
        // objOfFile (1000) creation + objMove (1000) / objAlpha (1003) setters.
        assert!(
            registry
                .get(RlopKey::new(module_type, OBJ_FG_CREATION_ID, 1000))
                .is_some(),
            "objOfFile must resolve at module_type {module_type}",
        );
        assert!(
            registry
                .get(RlopKey::new(module_type, OBJ_FG_SETTER_ID, 1003))
                .is_some(),
            "objAlpha must resolve at module_type {module_type}",
        );
    }
    // The catalog Advance stub is NOT what fires now: the render family is
    // mounted first, so these keys carry real semantics.
    assert!(registry.len() >= 200);
}

#[test]
fn obj_layer_observably_reorders_render_pass_output() {
    // Two foreground OBJECT wipes: create via objOfFile then overwrite the
    // slot with a coloured wipe (objOfFile makes an Image; we assert on the
    // layer_order ordering through the real render pass). We instead drive
    // the layer op directly: create two objects, then use objLayer to
    // reorder and observe the render output flip.
    let (runtime, _registry) = runtime_with_registry();
    // Place two coloured wipes on the Foreground plane directly (the render
    // pass paints them); then drive objLayer through the registry.
    runtime.with_stack_mut(|stack| {
        let mut black = utsushi_reallive::GraphicsObject::wipe(WipeColour::BLACK);
        black.layer_order = 1_000_000; // fg base
        let mut white = utsushi_reallive::GraphicsObject::wipe(WipeColour::WHITE);
        white.layer_order = 1_000_001;
        stack
            .set(GraphicsPlane::Foreground, 0, black)
            .expect("set black");
        stack
            .set(GraphicsPlane::Foreground, 1, white)
            .expect("set white");
    });
    let pass = RenderPass::with_dimensions(1, 1).expect("non-zero");
    let before = runtime.with_stack(|stack| pass.rasterise(stack));
    assert_eq!(before.pixels(), &[0xFF, 0xFF, 0xFF, 0xFF]);

    // objLayer(buf=1, z=-5) → white drops below black → black wins.
    let set_layer = ObjSetOp::new(
        Arc::clone(&runtime),
        GraphicsPlane::Foreground,
        ObjSetProp::Layer,
    );
    let mut vm = Vm::new(1, 0);
    set_layer.dispatch(&mut vm, &[int(1), int(-5)]);
    let after = runtime.with_stack(|stack| pass.rasterise(stack));
    assert_eq!(after.pixels(), &[0x00, 0x00, 0x00, 0xFF]);
}

#[test]
fn obj_of_file_creates_sprite_and_setters_mutate_it() {
    let (runtime, _registry) = runtime_with_registry();
    let mut vm = Vm::new(1, 0);
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm, &[int(3), bytes(b"CHAR01")]);
    ObjSetOp::new(
        Arc::clone(&runtime),
        GraphicsPlane::Foreground,
        ObjSetProp::Move,
    )
    .dispatch(&mut vm, &[int(3), int(120), int(48)]);
    ObjSetOp::new(
        Arc::clone(&runtime),
        GraphicsPlane::Foreground,
        ObjSetProp::Alpha,
    )
    .dispatch(&mut vm, &[int(3), int(128)]);
    let snap = runtime.state_snapshot();
    let obj = snap
        .stack
        .get(GraphicsPlane::Foreground, 3)
        .expect("object created");
    match &obj.kind {
        GraphicsObjectKind::Image { image_ref } => assert_eq!(image_ref.asset_key, "CHAR01"),
        other @ GraphicsObjectKind::Wipe { .. } => panic!("expected Image, got {other:?}"),
    }
    assert_eq!(obj.position.x, 120);
    assert_eq!(obj.position.y, 48);
    assert_eq!(obj.alpha.0, 128);
}

#[test]
fn grp_buffer_then_display_promotes_offscreen_dc_to_screen() {
    let (runtime, _registry) = runtime_with_registry();
    let mut vm = Vm::new(1, 0);
    // grpBuffer(filename, dc=2): load off-screen (invisible).
    GrpRenderOp::new(Arc::clone(&runtime), GrpOp::Buffer)
        .dispatch(&mut vm, &[bytes(b"EV01"), int(2)]);
    let snap = runtime.state_snapshot();
    let buf = snap
        .stack
        .get(GraphicsPlane::Background, 2)
        .expect("dc2 loaded");
    assert!(!buf.visible, "buffered dc must be off-screen");
    assert!(
        snap.stack
            .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
            .is_none()
    );
    // grpDisplay(dc=2): copy dc2 → DC0 (visible screen).
    GrpRenderOp::new(Arc::clone(&runtime), GrpOp::Display).dispatch(&mut vm, &[int(2), int(0)]);
    let snap = runtime.state_snapshot();
    let screen = snap
        .stack
        .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
        .expect("dc0 now shows the displayed buffer");
    assert!(screen.visible);
    match &screen.kind {
        GraphicsObjectKind::Image { image_ref } => assert_eq!(image_ref.asset_key, "EV01"),
        other @ GraphicsObjectKind::Wipe { .. } => panic!("expected Image, got {other:?}"),
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn grp_openbg_bg01a1_registers_bg_plane() {
    let Some(g00_dir) = real_g00_dir() else {
        real_corpus::require_real_bytes("utsushi-reallive grp_openbg_bg01a1_registers_bg_plane");
        return;
    };
    let bg01a1_path = g00_dir.join(BG01A1_FILENAME);
    if !bg01a1_path.exists() {
        eprintln!(
            "BG01A1.g00 not present at {}; skipping",
            bg01a1_path.display()
        );
        return;
    }
    let runtime = Arc::new(GraphicsRuntime::new());
    let package: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir));
    runtime.set_asset_package(Arc::clone(&package));

    // grpOpenBg(filename, effect) — the REAL opcode (73), filename FIRST.
    let op = GrpRenderOp::new(Arc::clone(&runtime), GrpOp::OpenScreen);
    let mut vm = Vm::new(1, 0);
    op.dispatch(&mut vm, &[bytes(b"BG01A1"), int(0)]);

    let snap = runtime.state_snapshot();
    let bg_object = snap
        .stack
        .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
        .expect("DC0 registered");
    match &bg_object.kind {
        GraphicsObjectKind::Image { image_ref } => assert_eq!(image_ref.asset_key, "BG01A1"),
        other @ GraphicsObjectKind::Wipe { .. } => panic!("expected Image, got {other:?}"),
    }
    let bg_canvas = snap.bg_canvas.expect("bg canvas recorded");
    assert_eq!(bg_canvas.asset_key, "BG01A1");
    let (width, height) = bg_canvas
        .dimensions
        .expect("decoded dimensions must be present once VFS is set");
    assert_eq!(width, BG01A1_WIDTH);
    assert_eq!(height, BG01A1_HEIGHT);
    let warnings = runtime.take_warnings();
    assert!(
        warnings.is_empty(),
        "openBg recorded warnings: {warnings:?}"
    );
    let _ = WipeColour::BLACK;
}
