//! Env-gated, multi-title proof for the production Siglus G00 capture path.
//!
//! The two roots are intentionally explicit rather than checked into a test
//! fixture: copyrighted title bytes stay outside this repository. When either
//! root is absent the test reports a skip and succeeds; when both are present
//! it drives the real `EnginePort` + `Runner` lifecycle for one compressed
//! type-0 and one layered type-2 asset from each title.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;
use utsushi_core::port::runner::Runner;
use utsushi_core::substrate::PortRequest;
use utsushi_core::{
    CaseRule, PackageSource, PlaintextDirPackage, RuntimeArtifactRoot, RuntimeOperation,
};
use utsushi_siglus::{SiglusCgRedaction, UtsushiSiglusPort, decode_siglus_g00, render_siglus_cg};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

#[test]
fn two_real_siglus_titles_decode_layered_g00_and_capture_redacted_pngs() {
    let Some(first) = corpus_root(FIRST_TITLE_ENV) else {
        return;
    };
    let Some(second) = corpus_root(SECOND_TITLE_ENV) else {
        return;
    };
    exercise_title(&first, "siglus-title-one");
    exercise_title(&second, "siglus-title-two");
}

fn corpus_root(variable: &str) -> Option<PathBuf> {
    let Some(value) = std::env::var_os(variable) else {
        eprintln!("SKIP siglus real bytes: {variable} is unset");
        return None;
    };
    let path = PathBuf::from(value);
    if !path.is_dir() {
        eprintln!("SKIP siglus real bytes: {variable} is not a directory");
        return None;
    }
    Some(path)
}

fn exercise_title(root: &Path, label: &str) {
    let (type0, type2) = find_supported_assets(root)
        .unwrap_or_else(|| panic!("{label}: real corpus lacks a type-0 or type-2 G00 asset"));
    let package = Arc::new(PlaintextDirPackage::new(
        format!("{label}-package"),
        root,
        CaseRule::InsensitiveAscii,
        PackageSource::PublicName(format!("real-corpus:{label}")),
    ));
    for (expected_type, logical_path) in [(0u8, type0), (2u8, type2)] {
        let disk_path = root.join(&logical_path);
        let bytes = fs::read(&disk_path).expect("read selected real G00 asset");
        let image =
            decode_siglus_g00(&bytes).expect("production decoder accepts selected real G00");
        assert!(
            image.width > 0 && image.height > 0,
            "{label}: decoded image has dimensions"
        );
        if expected_type == 2 {
            assert!(
                !image.layers.is_empty(),
                "{label}: type-2 image carries real layer records"
            );
        }
        let full = render_siglus_cg(&image, SiglusCgRedaction::Full)
            .expect("production full-fidelity raster path");
        let redacted = render_siglus_cg(&image, SiglusCgRedaction::default())
            .expect("production default-redaction raster path");
        assert_eq!(full.width, image.width, "{label}: full raster width");
        assert_eq!(full.height, image.height, "{label}: full raster height");
        assert_eq!(full.pixels_rgba.len(), image.pixels_rgba.len());
        assert_ne!(
            full.pixels_rgba, redacted.pixels_rgba,
            "{label}: public raster is derived/redacted rather than raw CG pixels"
        );
        let artifacts = TempDir::new().expect("temporary managed artifact root");
        let artifact_root = RuntimeArtifactRoot::new(artifacts.path().join("runtime-artifacts"));
        let mut port = UtsushiSiglusPort::with_g00_asset(package.clone(), logical_path);
        let run_id = format!("{label}-type-{expected_type}");
        let request = PortRequest::new(root, &run_id, RuntimeOperation::Capture)
            .with_artifact_root(&artifact_root);
        let outcome = Runner::new()
            .run_capture(&mut port, &request)
            .expect("real EnginePort decode/render/capture lifecycle");
        let capture = outcome.capture.expect("capture outcome");
        assert!(
            capture
                .summary
                .as_deref()
                .is_some_and(|summary| summary.contains("redacted=true")),
            "{label}: real capture reports the default redaction policy"
        );
        let artifact = capture.artifact_path.expect("managed PNG path");
        let png = fs::read(artifact).expect("read redacted PNG artifact");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "{label}: capture is a PNG");
    }
}

fn find_supported_assets(root: &Path) -> Option<(String, String)> {
    let directory = fs::read_dir(root.join("g00")).ok()?;
    let mut type0 = None;
    let mut type2 = None;
    for entry in directory.flatten() {
        let path = entry.path();
        if !path.is_file()
            || path
                .extension()
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("g00"))
        {
            continue;
        }
        let mut lead = [0u8; 1];
        if fs::File::open(&path)
            .and_then(|mut file| file.read_exact(&mut lead))
            .is_err()
        {
            continue;
        }
        let logical = path
            .strip_prefix(root)
            .ok()?
            .to_string_lossy()
            .replace('\\', "/");
        match lead[0] {
            0 if type0.is_none() => type0 = Some(logical),
            2 if type2.is_none() => type2 = Some(logical),
            _ => {}
        }
        if let (Some(type0), Some(type2)) = (&type0, &type2) {
            return Some((type0.clone(), type2.clone()));
        }
    }
    None
}
