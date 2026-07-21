//! Env-gated E1 observation proof over two independently supplied Siglus
//! installations. Copyrighted scene bytes stay outside the repository.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kaifuu_siglus::{
    SiglusSecondLayerKey, decode_scene_chunk, decode_scene_flow, parse_scene_pck,
    recover_exe_angou_key,
};
use utsushi_core::port::runner::Runner;
use utsushi_core::substrate::PortRequest;
use utsushi_core::{
    CaseRule, MountedVfs, PackageSource, PlaintextDirPackage, RuntimeOperation, RuntimeVfs,
};
use utsushi_siglus::UtsushiSiglusPort;

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

#[derive(Default)]
struct ExpectedSurfaces {
    text: usize,
    names: usize,
}

impl ExpectedSurfaces {
    fn total(&self) -> usize {
        self.text + self.names
    }
}

#[test]
fn two_real_siglus_titles_emit_one_e1_line_per_decoded_text_surface() {
    let Some(first) = corpus_root(FIRST_TITLE_ENV) else {
        return;
    };
    let Some(second) = corpus_root(SECOND_TITLE_ENV) else {
        return;
    };

    exercise_title(&first, "siglus-observe-first");
    exercise_title(&second, "siglus-observe-second");
}

fn corpus_root(variable: &str) -> Option<PathBuf> {
    let Some(value) = std::env::var_os(variable) else {
        eprintln!("SKIP Siglus observe real bytes: {variable} is unset");
        return None;
    };
    let candidate = PathBuf::from(value);
    let root = if candidate.is_dir() {
        candidate
    } else {
        candidate.parent().map(Path::to_path_buf)?
    };
    for logical in ["Scene.pck", "Gameexe.dat", "SiglusEngine.exe"] {
        if !root.join(logical).is_file() {
            eprintln!("SKIP Siglus observe real bytes: {variable} lacks {logical}");
            return None;
        }
    }
    Some(root)
}

fn exercise_title(root: &Path, package_id: &str) {
    let expected = expected_surfaces(root, package_id);
    assert!(expected.text > 0, "{package_id}: no CD_TEXT surfaces found");
    assert!(
        expected.names > 0,
        "{package_id}: no CD_NAME surfaces found"
    );

    let request = PortRequest::new(
        Path::new("siglus-observe-input-is-vfs-only"),
        package_id,
        RuntimeOperation::Trace,
    )
    .with_vfs(mounted_vfs(root, package_id));
    let mut port = UtsushiSiglusPort::new();
    let outcome = Runner::new()
        .run_trace(&mut port, &request)
        .unwrap_or_else(|error| panic!("{package_id}: runner trace failed: {error}"));
    let lines: Vec<_> = outcome
        .observations
        .iter()
        .flat_map(|observation| observation.text.iter())
        .collect();

    let observed_text = lines
        .iter()
        .filter(|line| line.text_surface.as_deref() == Some("dialogue"))
        .count();
    let observed_names = lines
        .iter()
        .filter(|line| line.text_surface.as_deref() == Some("speaker_name"))
        .count();
    assert_eq!(
        observed_text, expected.text,
        "{package_id}: every CD_TEXT must emit exactly one dialogue TextLine"
    );
    assert_eq!(
        observed_names, expected.names,
        "{package_id}: every CD_NAME must emit exactly one speaker-name TextLine"
    );
    assert_eq!(
        lines.len(),
        expected.total(),
        "{package_id}: total E1 lines"
    );
    assert!(lines.iter().all(|line| {
        line.bridge_ref
            .as_ref()
            .and_then(|reference| reference.source_unit_key.as_deref())
            .is_some_and(|key| key.starts_with("siglus:scene-") && key.contains('#'))
    }));
    assert!(lines.iter().all(|line| line.body_shift_jis.is_none()));
    eprintln!(
        "REAL {package_id}: E1 text={} names={} total={}",
        observed_text,
        observed_names,
        lines.len()
    );
}

fn expected_surfaces(root: &Path, label: &str) -> ExpectedSurfaces {
    let executable = std::fs::read(root.join("SiglusEngine.exe")).expect("read engine executable");
    let scene_pack = std::fs::read(root.join("Scene.pck")).expect("read Scene.pck");
    let key_ref = SiglusSecondLayerKey::from_secret_ref(format!("secret://utsushi/siglus/{label}"));
    let recovered = recover_exe_angou_key(&executable, &key_ref)
        .unwrap_or_else(|error| panic!("{label}: recover scene key: {error}"));
    let index =
        parse_scene_pck(&scene_pack).unwrap_or_else(|error| panic!("{label}: parse pack: {error}"));
    let mut expected = ExpectedSurfaces::default();

    for entry in &index.entries {
        let start = entry.byte_offset as usize;
        let end = start + entry.byte_len as usize;
        let decoded = decode_scene_chunk(
            entry.scene_id,
            &scene_pack[start..end],
            index.extra_key_use,
            index.extra_key_use.then_some(recovered.material()),
        )
        .unwrap_or_else(|error| panic!("{label}: decode scene {}: {error}", entry.scene_id));
        let flow = decode_scene_flow(&decoded)
            .unwrap_or_else(|error| panic!("{label}: flow scene {}: {error}", entry.scene_id));
        for surface in flow.text_surfaces {
            assert!(
                surface.is_patchable(),
                "{label}: surface at {} must have a concrete literal",
                surface.site_offset
            );
            if surface.is_name {
                expected.names += 1;
            } else {
                expected.text += 1;
            }
        }
    }
    expected
}

fn mounted_vfs(root: &Path, package_id: &str) -> Arc<dyn RuntimeVfs> {
    let package = PlaintextDirPackage::new(
        package_id,
        root,
        CaseRule::InsensitiveAscii,
        PackageSource::PublicName(format!("fixture:{package_id}")),
    );
    let mut vfs = MountedVfs::new(
        package_id,
        PackageSource::PublicName(format!("fixture:{package_id}")),
    );
    vfs.mount_plaintext_dir(package);
    Arc::new(vfs)
}
