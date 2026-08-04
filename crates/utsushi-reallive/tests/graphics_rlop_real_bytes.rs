//! Real-bytes proof for the corpus-backed graphics `openBg` path.

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
    ExprValue, GraphicsObjectKind, GraphicsPlane, GraphicsRuntime, GrpOp, GrpRenderOp, RLOperation,
    SCREEN_DC_SLOT, Vm, WipeColour,
};

const BG01A1_FILENAME: &str = "BG01A1.g00";
const BG01A1_WIDTH: u32 = 1280;
const BG01A1_HEIGHT: u32 = 720;

fn real_g00_dir() -> Option<PathBuf> {
    real_corpus::reallivedata_subdir("g00")
}

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
        "-on-disk-g00"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: "-on-disk-g00".to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName("-on-disk-g00".to_string()),
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
        Ok(self.g00_dir.join(strip_g00_prefix(id.path())).exists())
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

fn int(value: i32) -> ExprValue {
    ExprValue::Int(value)
}

fn bytes(value: &[u8]) -> ExprValue {
    ExprValue::Bytes(value.to_vec())
}

#[test]
fn grp_openbg_bg01a1_registers_bg_plane() {
    let Some(g00_dir) = real_g00_dir() else {
        real_corpus::require_real_bytes("utsushi-reallive grp_openbg_bg01a1_registers_bg_plane");
        return;
    };
    let bg01a1_path = g00_dir.join(BG01A1_FILENAME);
    if !bg01a1_path.exists() {
        panic!("real-bytes proof not established: required corpus asset is unavailable");
    }
    let runtime = Arc::new(GraphicsRuntime::new());
    let package: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir));
    runtime.set_asset_package(Arc::clone(&package));

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
