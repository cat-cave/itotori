//! Env-gated E1 observation proof over two independently supplied Siglus
//! installations. Copyrighted scene bytes stay outside the repository.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kaifuu_siglus::{
    SiglusSecondLayerKey, SiglusStringRef, decode_scene_chunk, decode_scene_flow,
    decode_scene_syscalls, parse_scene_pck, recover_exe_angou_key,
};
use utsushi_core::port::runner::Runner;
use utsushi_core::substrate::{EnginePort, PortRequest};
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
    choices: Vec<ExpectedChoice>,
}

impl ExpectedSurfaces {
    fn total(&self) -> usize {
        self.text + self.names + self.choices.len()
    }
}

struct ExpectedChoice {
    source_unit_key: String,
    branch_target_offset: Option<usize>,
}

#[test]
fn two_real_siglus_titles_emit_linked_e1_text_and_choice_surfaces() {
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
    assert!(
        !expected.choices.is_empty(),
        "{package_id}: no linked SELBTN choice labels found"
    );
    assert!(
        expected
            .choices
            .iter()
            .any(|choice| choice.branch_target_offset.is_some()),
        "{package_id}: no linked choice branch target found"
    );

    let request = PortRequest::new(
        Path::new("siglus-observe-input-is-vfs-only"),
        package_id,
        RuntimeOperation::Trace,
    )
    .with_vfs(mounted_vfs(root, package_id));
    let mut port = UtsushiSiglusPort::new();
    port.launch(&request)
        .unwrap_or_else(|error| panic!("{package_id}: launch failed: {error}"));
    let mut lines = Vec::new();
    let runner = Runner::new();
    while lines.len() < port.lines_total() {
        let observation = runner
            .tick(&mut port, &request)
            .unwrap_or_else(|error| panic!("{package_id}: runner trace failed: {error}"));
        lines.extend(observation.text);
    }

    let observed_text = lines
        .iter()
        .filter(|line| line.text_surface.as_deref() == Some("dialogue"))
        .count();
    let observed_names = lines
        .iter()
        .filter(|line| line.text_surface.as_deref() == Some("speaker_name"))
        .count();
    let observed_choices: Vec<_> = lines
        .iter()
        .filter(|line| {
            line.text_surface
                .as_deref()
                .is_some_and(|surface| surface.starts_with("choice:"))
        })
        .collect();
    assert_eq!(
        observed_text, expected.text,
        "{package_id}: every CD_TEXT must emit exactly one dialogue TextLine"
    );
    assert_eq!(
        observed_names, expected.names,
        "{package_id}: every CD_NAME must emit exactly one speaker-name TextLine"
    );
    assert_eq!(
        observed_choices.len(),
        expected.choices.len(),
        "{package_id}: every linked choice label must emit exactly one E1 TextLine"
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
    let expected_choice_targets: BTreeMap<_, _> = expected
        .choices
        .iter()
        .map(|choice| (choice.source_unit_key.as_str(), choice.branch_target_offset))
        .collect();
    for line in &observed_choices {
        let source_key = line
            .bridge_ref
            .as_ref()
            .and_then(|reference| reference.source_unit_key.as_deref())
            .expect("choice line has bridge choice_label source key");
        assert!(
            expected_choice_targets.contains_key(source_key),
            "{package_id}: choice line source key must resolve to a bridge choice_label"
        );
    }
    let observed_choice_targets: BTreeMap<_, _> = port
        .choice_moments()
        .iter()
        .flat_map(|moment| &moment.options)
        .map(|option| (option.source_unit_key.as_str(), option.branch_target_offset))
        .collect();
    assert_eq!(
        observed_choice_targets, expected_choice_targets,
        "{package_id}: every option keeps its conditional-jump branch target"
    );
    eprintln!(
        "REAL {package_id}: E1 text={} names={} choices={} targets={} total={}",
        observed_text,
        observed_names,
        observed_choices.len(),
        expected_choice_targets
            .values()
            .filter(|target| target.is_some())
            .count(),
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
        let scene_name = entry
            .scene_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .map_or_else(|| format!("{:04}", entry.scene_id), ToOwned::to_owned);
        let syscalls = decode_scene_syscalls(&decoded)
            .unwrap_or_else(|error| panic!("{label}: syscall scene {}: {error}", entry.scene_id));
        for selection in syscalls.selections {
            for option in selection
                .options
                .into_iter()
                .filter(|option| option.structural_arm_index.is_some())
            {
                if decode_choice_label(&decoded, &option.text).is_empty() {
                    continue;
                }
                let source_offset = option
                    .source_command_offset
                    .unwrap_or(option.text.byte_offset);
                expected.choices.push(ExpectedChoice {
                    source_unit_key: format!("siglus:scene-{scene_name}#{source_offset}"),
                    branch_target_offset: option.branch_target_offset,
                });
            }
        }
    }
    expected
}

fn decode_choice_label(decoded_scene: &[u8], string: &SiglusStringRef) -> String {
    assert!(
        string.index >= 0,
        "choice string index must be non-negative"
    );
    assert!(
        string.char_len >= 0,
        "choice string length must be non-negative"
    );
    let byte_len = usize::try_from(string.char_len)
        .expect("choice string length fits usize")
        .checked_mul(2)
        .expect("choice string byte length does not overflow");
    let end = string
        .byte_offset
        .checked_add(byte_len)
        .expect("choice string range does not overflow");
    let raw = decoded_scene
        .get(string.byte_offset..end)
        .expect("choice string stays within decoded scene");
    let key = 28807_u16.wrapping_mul(string.index as u16);
    let units: Vec<_> = raw
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]) ^ key)
        .take_while(|unit| *unit != 0)
        .collect();
    String::from_utf16_lossy(&units)
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
