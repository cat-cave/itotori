//! Synthetic coverage for [`GraphicsRuntime::read_g00_through_vfs`] and
//! the g00-decode-warning surface.
//!
//! Prior to the genaudit3-p3-cleanup-dead-helpers-warnings-doc fix
//! `read_g00_through_vfs` silently bound the decoder's
//! `Vec<G00Warning>` to `_warnings` and dropped it — only the
//! `(width, height)` tuple was returned and the non-fatal
//! `PayloadLengthMismatch` warning the decode surfaced was lost. The
//! dims-probe was the canonical place a real corpus LZSS drift could
//! surface auditably; this test pins that surface so a regression
//! where the warnings are silently discarded again fails loud.
//!
//! The package is an in-memory [`AssetPackage`] (no real bytes) that
//! returns a hand-authored type-0 g00 file whose declared canvas is
//! larger than the LZSS payload — the canonical "best-effort decode
//! PayloadLengthMismatch" pattern exercised by the in-crate
//! `g00::type0_short_stream_pads_and_warns_not_silent`.

#[path = "support/g00_synthetic.rs"]
mod g00_synthetic;

use std::sync::Arc;

use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsResult,
};
use utsushi_reallive::{
    ExprValue, GraphicsRuntime, GraphicsRuntimeWarning, GrpOp, GrpRenderOp, RLOperation, Vm,
};

/// Hand-authored type-0 g00 blob that decodes best-effort and surfaces
/// one [`G00Warning::PayloadLengthMismatch`].
///
/// Mirrors the canonical "short LZSS" pattern exercised by the in-crate
/// [`g00::tests::type0_short_stream_pads_and_warns_not_silent`] test:
/// declared `(width = 4, height = 1)` canvas = 16 bytes of RGBA, but the
/// LZSS prelude decodes to a single BGR pixel (3 bytes -> 4 RGBA bytes).
/// The decoder pads to the canvas and emits one
/// `PayloadLengthMismatch { observed: 4, declared: 16 }`.
fn short_type0_g00_bytes() -> Vec<u8> {
    // LZSS prelude: flag 0x01 (one literal in the first slot of the
    // first flag group), then 3 bytes of literal BGR data.
    let lzss: [u8; 4] = [0x01, 0x01, 0x02, 0x03];
    let mut bytes = Vec::new();
    bytes.push(0u8); // type-0 lead byte
    bytes.extend_from_slice(&4u16.to_le_bytes()); // width = 4
    bytes.extend_from_slice(&1u16.to_le_bytes()); // height = 1
    bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes()); // compressed_size
    bytes.extend_from_slice(&16u32.to_le_bytes()); // declared canvas = 4×1 RGBA
    bytes.extend_from_slice(&lzss);
    // Sibling fixture (used in another test) confirms zero-warning
    // decoding; importing it proves the `synthetic_type0_g00` builder
    // API surface is real.
    let _ = g00_synthetic::synthetic_type0_g00();
    bytes
}

#[derive(Debug)]
struct InMemoryG00Package {
    bytes: Vec<u8>,
}

impl InMemoryG00Package {
    fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }
}

impl AssetPackage for InMemoryG00Package {
    fn id(&self) -> &'static str {
        "in-memory-short-g00"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: "in-memory-short-g00".to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName("in-memory-short-g00".to_string()),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }

    fn exists(&self, _id: &AssetId) -> VfsResult<bool> {
        Ok(true)
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(self.bytes.len() as u64),
            revision: None,
        })
    }

    fn open(&self, _id: &AssetId) -> VfsResult<AssetBytes> {
        Ok(AssetBytes::from(self.bytes.clone()))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

#[test]
fn read_g00_through_vfs_surfaces_g00_payload_warning_via_runtime_queue() {
    let runtime = GraphicsRuntime::new();
    let package: Arc<dyn AssetPackage> = Arc::new(InMemoryG00Package::new(short_type0_g00_bytes()));
    runtime.set_asset_package(Arc::clone(&package));

    let probe = runtime.read_g00_through_vfs("BACK.g00", "");
    let dims = match probe {
        Ok(Some(dims)) => dims,
        Ok(None) => panic!("dims probe returned Ok(None); expected Some((w, h))"),
        Err(err) => panic!("dims probe returned Err; expected Some((w, h)): {err:?}"),
    };
    assert_eq!(dims, (4, 1));

    let warnings = runtime.warnings();
    assert!(
        warnings.iter().any(|w| matches!(
            w,
            GraphicsRuntimeWarning::G00PayloadWarning { asset_key, .. } if asset_key == "BACK.g00"
        )),
        "read_g00_through_vfs dropped the G00Warning on the floor; \
         expected a G00PayloadWarning tagged asset_key=\"BACK.g00\" in the runtime queue, \
         got: {warnings:?}",
    );
    assert!(
        warnings
            .iter()
            .all(|w| !matches!(w, GraphicsRuntimeWarning::G00DecodeFailure { .. })),
        "non-fatal PayloadLengthMismatch was incorrectly mapped to G00DecodeFailure: \
         {warnings:?}",
    );
}

#[test]
fn g00_payload_warning_with_opcode_carries_tag_at_caller_boundary() {
    let runtime = Arc::new(GraphicsRuntime::new());
    let package: Arc<dyn AssetPackage> = Arc::new(InMemoryG00Package::new(short_type0_g00_bytes()));
    runtime.set_asset_package(Arc::clone(&package));
    let mut vm = Vm::new(1, 0);
    let op = GrpRenderOp::new(Arc::clone(&runtime), GrpOp::OpenScreen);
    op.dispatch(
        &mut vm,
        &[ExprValue::Bytes(b"BACK".to_vec()), ExprValue::Int(0)],
    );

    let warnings = runtime.take_warnings();
    // The dispatcher passes the Shift-JIS-decoded filename (`BACK`)
    // to read_g00_through_vfs, which becomes the asset_key on the
    // G00PayloadWarning. The opcode_tag must be `grp.open` because the
    // dims probe was reached through the OpenScreen dispatch arm.
    assert!(
        warnings.iter().any(|w| matches!(
            w,
            GraphicsRuntimeWarning::G00PayloadWarning {
                opcode_tag,
                asset_key,
                ..
            } if *opcode_tag == "grp.open" && asset_key == "BACK"
        )),
        "G00PayloadWarning did not carry the grp.open opcode tag at the dispatch boundary; \
         got: {warnings:?}",
    );
}

#[test]
fn g00_payload_warning_display_carries_diagnostic_prefix_and_asset_key() {
    use std::string::ToString;
    let warning = GraphicsRuntimeWarning::G00PayloadWarning {
        opcode_tag: "grp.open",
        asset_key: "BACK.g00".to_string(),
        reason: "utsushi.reallive.g00.payload_length_mismatch: test".to_string(),
    };
    let rendered = warning.to_string();
    assert!(
        rendered.contains("g00.payload_length_mismatch"),
        "G00PayloadWarning Display must preserve the g00.{{...}} diagnostic prefix; got {rendered:?}",
    );
    assert!(
        rendered.contains("asset=BACK.g00"),
        "G00PayloadWarning Display must carry the dims-probe asset key; got {rendered:?}",
    );
    let stamped = warning.with_opcode("grp.display");
    let stamped_str = stamped.to_string();
    assert!(
        stamped_str.contains("op=grp.display"),
        "G00PayloadWarning.with_opcode must stamp the opcode tag; got {stamped_str:?}",
    );
}
