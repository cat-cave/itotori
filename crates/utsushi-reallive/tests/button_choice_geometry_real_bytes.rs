//! Real-bytes proof for decoded button-object choice geometry.
//!
//! The two configured corpora supply real g00 pattern metadata. A button
//! prompt snapshots the resulting transformed rectangle and image reference,
//! and the choice renderer draws only that decoded rectangle.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use utsushi_core::EvidenceTier;
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, SinkCapability, SinkResult, TextLine,
    TextSurfaceSink, VfsError, VfsResult,
};
use utsushi_reallive::{
    ExprValue, GraphicsPlane, GraphicsRuntime, ObjButtonOptsOp, ObjCreateOp,
    ObjectButtonChoiceWindow, RLOperation, RedactionPolicy, RenderPass, SelRuntime, SelectObjbtnOp,
    SelectionPromptKind, Vm,
};

#[derive(Debug)]
struct OnDiskG00Package {
    g00_dir: PathBuf,
}

#[derive(Default)]
struct NullTextSink;

impl TextSurfaceSink for NullTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, _line: TextLine) -> SinkResult<()> {
        Ok(())
    }
}

impl OnDiskG00Package {
    fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }
}

fn strip_g00_prefix(logical: &str) -> &str {
    logical.strip_prefix("g00/").unwrap_or(logical)
}

impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "button-choice-real-g00"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id().to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName(self.id().to_string()),
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
        Ok(self.g00_dir.join(strip_g00_prefix(id.path())).is_file())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let metadata = fs::metadata(path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(metadata.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let bytes = fs::read(path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

fn first_decodable_stem(g00_dir: &Path) -> String {
    fs::read_dir(g00_dir)
        .expect("read g00 directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("g00"))
        })
        .find_map(|path| {
            let stem = path.file_stem()?.to_str()?.to_owned();
            if !stem.is_ascii() {
                return None;
            }
            let bytes = fs::read(path).ok()?;
            utsushi_reallive::probe_g00_pattern_geometry(&bytes, 0)
                .is_ok()
                .then_some(stem)
        })
        .expect("at least one decodable g00 asset")
}

fn probe_one_corpus(label: &str, g00_dir: PathBuf) {
    let asset = first_decodable_stem(&g00_dir);
    let graphics = Arc::new(GraphicsRuntime::new());
    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir));
    graphics.set_asset_package(Arc::clone(&assets));
    let mut vm = Vm::new(1, 0);
    ObjCreateOp::new(Arc::clone(&graphics), GraphicsPlane::Foreground).dispatch(
        &mut vm,
        &[
            ExprValue::Int(3),
            ExprValue::Bytes(asset.as_bytes().to_vec()),
            ExprValue::Int(1),
            ExprValue::Int(37),
            ExprValue::Int(29),
            ExprValue::Int(0),
        ],
    );
    ObjButtonOptsOp::new(Arc::clone(&graphics), GraphicsPlane::Foreground).dispatch(
        &mut vm,
        &[
            ExprValue::Int(3),
            ExprValue::Int(0),
            ExprValue::Int(0),
            ExprValue::Int(9),
            ExprValue::Int(4),
        ],
    );
    let sink: Arc<dyn TextSurfaceSink> = Arc::new(NullTextSink);
    let runtime = Arc::new(SelRuntime::with_graphics(sink, Arc::clone(&graphics)));
    let outcome = SelectObjbtnOp::new(Arc::clone(&runtime)).dispatch(&mut vm, &[ExprValue::Int(9)]);
    assert!(matches!(
        outcome,
        utsushi_reallive::DispatchOutcome::Yield { .. }
    ));
    let prompts = runtime.take_prompts();
    let SelectionPromptKind::ObjectButtons { options, .. } = &prompts[0].kind else {
        panic!("object-button prompt")
    };
    let option = options[0]
        .render_choice_option()
        .expect("real g00 metadata must provide choice geometry");
    assert_eq!(option.art.asset_key, asset);
    assert!(option.bounds.width > 0 && option.bounds.height > 0);

    let choice = ObjectButtonChoiceWindow::from_metadata(vec![option], 0);
    let stack = graphics.state_snapshot().stack;
    let pass = RenderPass::with_dimensions(640, 480)
        .expect("framebuffer")
        .with_assets(assets);
    let framebuffer = pass.rasterise_object_button_choice(&stack, &choice, RedactionPolicy::Full);
    assert!(framebuffer.pixels().iter().any(|byte| *byte != 0));
    eprintln!(
        "{label}: decoded button geometry = {:?}",
        choice.options[0].bounds
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_GAME_ROOT_2"]
fn button_choice_geometry_is_decoded_from_both_real_corpora() {
    let Some(first) = real_corpus::g00_dir_for_env(real_corpus::REAL_GAME_ROOT_ENV) else {
        real_corpus::require_real_bytes("button_choice_geometry_is_decoded_from_both_real_corpora");
        return;
    };
    let Some(second) = real_corpus::g00_dir_for_env(real_corpus::REAL_GAME_ROOT_2_ENV) else {
        real_corpus::require_real_bytes("button_choice_geometry_is_decoded_from_both_real_corpora");
        return;
    };
    probe_one_corpus("corpus-1", first);
    probe_one_corpus("corpus-2", second);
}
