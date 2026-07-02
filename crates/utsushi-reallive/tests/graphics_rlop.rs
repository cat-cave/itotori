//! UTSUSHI-215 integration tests for the graphics RLOperation family
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
//! crate's UTSUSHI-201/202/203 sibling parsers landed under the
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
    BG_PLANE_SLOT, ExprValue, GRP_RLOP_COUNT, GraphicsObjectKind, GraphicsPlane, GraphicsRuntime,
    GrpAllocDcOp, GrpOpcode, GrpOpenBgOp, GrpWipeOp, OBJ_RLOP_COUNT, ObjFgBgOp, ObjFgBgOpcode,
    RLOperation, RenderPass, RlopRegistry, Vm, WipeColour, register_grp_rlops, register_obj_rlops,
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

#[test]
fn registry_mounts_alpha_tier_opcode_union() {
    // Spec: ~25 opcodes across module_grp + module_obj_*. This crate
    // ships 15 module_grp + 16 (4 mgmt + 12 fg/bg) = 31. Pinned so a
    // future addition / removal surfaces in the audit trail.
    let mut registry = RlopRegistry::new();
    let runtime = Arc::new(GraphicsRuntime::new());
    let grp = register_grp_rlops(&mut registry, Arc::clone(&runtime));
    let obj = register_obj_rlops(&mut registry, Arc::clone(&runtime));
    assert_eq!(grp, GRP_RLOP_COUNT);
    assert_eq!(obj, OBJ_RLOP_COUNT);
    assert_eq!(grp + obj, 31);
    assert_eq!(registry.len(), 31);
}

#[test]
fn alpha_tier_opcode_count_at_least_25_per_spec() {
    // The spec's "~25 opcodes" target is the alpha-tier coverage
    // frontier. We pin `>= 25` so a future split that drops below
    // surfaces in the audit trail. The const-block is required by
    // clippy::assertions_on_constants because both inputs are const.
    const _: () = {
        assert!(GRP_RLOP_COUNT + OBJ_RLOP_COUNT >= 25);
    };
}

#[test]
fn obj_set_layer_observably_reorders_render_pass_output() {
    // Audit-focus pin: "Layer-ordering that ignores `objSetLayer`".
    // We populate two foreground wipes, run a render, swap the layer
    // order through `objSetLayer`, and run a second render. The
    // single-pixel framebuffer must observably change colour.
    let runtime = Arc::new(GraphicsRuntime::new());
    let mut registry = RlopRegistry::new();
    register_grp_rlops(&mut registry, Arc::clone(&runtime));
    register_obj_rlops(&mut registry, Arc::clone(&runtime));

    // Allocate two foreground wipes through the grp.wipe op so the
    // dispatch path matches what the VM would do.
    let wipe = GrpWipeOp::new(Arc::clone(&runtime));
    let mut vm = Vm::new(1, 0);
    // black at slot 0, white at slot 1 — both layer_order = 0 (default).
    wipe.dispatch(
        &mut vm,
        &[
            ExprValue::Int(0),
            ExprValue::Int(0),
            ExprValue::Int(0),
            ExprValue::Int(0),
        ],
    );
    wipe.dispatch(
        &mut vm,
        &[
            ExprValue::Int(1),
            ExprValue::Int(255),
            ExprValue::Int(255),
            ExprValue::Int(255),
        ],
    );

    let pass = RenderPass::with_dimensions(1, 1).expect("non-zero");
    let before = runtime.with_stack(|stack| pass.rasterise(stack));
    // Both at layer_order=0 → slot order (slot 1) wins.
    assert_eq!(before.pixels(), &[0xFF, 0xFF, 0xFF, 0xFF]);

    // Now push white below black via objSetLayer.
    let set_layer = ObjFgBgOp::new(
        Arc::clone(&runtime),
        GraphicsPlane::Foreground,
        ObjFgBgOpcode::SetLayer,
    );
    set_layer.dispatch(&mut vm, &[ExprValue::Int(1), ExprValue::Int(-5)]);
    let after = runtime.with_stack(|stack| pass.rasterise(stack));
    assert_eq!(after.pixels(), &[0x00, 0x00, 0x00, 0xFF]);
}

#[test]
fn alloc_dc_produces_observable_state_snapshot_mutation() {
    // Audit-focus pin: "Opcodes that mutate state but never produce a
    // visible effect". `allocDC` produces a slot allocation observable
    // through `state_snapshot`; the snapshot reports both the slot
    // count and the recorded DC dimensions.
    let runtime = Arc::new(GraphicsRuntime::new());
    let op = GrpAllocDcOp::new(Arc::clone(&runtime));
    let mut vm = Vm::new(1, 0);
    op.dispatch(
        &mut vm,
        &[ExprValue::Int(8), ExprValue::Int(1280), ExprValue::Int(720)],
    );
    let snap = runtime.state_snapshot();
    assert_eq!(snap.allocated_slot_count(), 1);
    let dc = snap.dc_allocation(8).expect("dc allocation recorded");
    assert_eq!(dc.slot, 8);
    assert_eq!(dc.width, 1280);
    assert_eq!(dc.height, 720);
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn grp_openbg_bg01a1_registers_bg_plane() {
    let Some(g00_dir) = real_g00_dir() else {
        real_corpus::skip_or_require_real_bytes(
            "utsushi-reallive grp_openbg_bg01a1_registers_bg_plane",
        );
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

    let op = GrpOpenBgOp::new(Arc::clone(&runtime));
    let mut vm = Vm::new(1, 0);
    op.dispatch(&mut vm, &[ExprValue::Bytes(b"BG01A1".to_vec())]);

    let snap = runtime.state_snapshot();
    let bg_object = snap
        .background_slot(BG_PLANE_SLOT)
        .expect("bg plane slot 0 registered");
    match &bg_object.kind {
        GraphicsObjectKind::Image { image_ref } => {
            assert_eq!(image_ref.asset_key, "BG01A1");
        }
        other @ GraphicsObjectKind::Wipe { .. } => panic!("expected Image, got {other:?}"),
    }

    let bg_canvas = snap.bg_canvas.expect("bg canvas recorded");
    assert_eq!(bg_canvas.asset_key, "BG01A1");
    // The g00 decoder may surface non-fatal warnings on this corpus
    // (LZSS-variant detection etc.) without rejecting the file; the
    // header still produces `(width, height)` per the type-0 byte
    // layout. Pin the documented HD canvas size.
    let (width, height) = bg_canvas
        .dimensions
        .expect("decoded dimensions must be present once VFS is set");
    assert_eq!(width, BG01A1_WIDTH);
    assert_eq!(height, BG01A1_HEIGHT);

    // Sanity: the runtime did not record any fail-soft warnings — the
    // openBg succeeded structurally.
    let warnings = runtime.take_warnings();
    assert!(
        warnings.is_empty(),
        "openBg recorded fail-soft warnings: {warnings:?}",
    );

    // Touch the GrpOpcode enum so the import stays load-bearing.
    assert_eq!(GrpOpcode::OpenBg.opcode(), 0x0006);
    // Reference the spec-pinned verification command identifier.
    let _ = WipeColour::BLACK;
}
