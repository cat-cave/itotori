//! Narrative-structure projection over the Siglus static-observation port.
//!
//! Siglus does not expose a replayable cross-scene dispatcher in the port.
//! The common graph therefore records complete decoded scene order and the
//! player-facing E1 text/choice surfaces, while leaving state-dependent route
//! edges absent rather than inventing targets a static walk cannot prove.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use utsushi_core::substrate::{EnginePort, PortRequest};
use utsushi_core::{
    CaseRule, MountedVfs, PackageSource, PlaintextDirPackage, RuntimeOperation, RuntimeVfs,
};

use crate::UtsushiSiglusPort;

/// Produce a common v1 narrative-structure artifact from real Siglus assets.
///
/// `Scene.pck` and `Gameexe.dat` must be sibling files because the port also
/// opens the sibling executable when their container headers require its
/// in-process exe-angou key recovery.
pub fn build_siglus_structure(scene_path: &Path, gameexe_path: &Path) -> Result<Value, String> {
    let root = shared_asset_root(scene_path, gameexe_path)?;
    let package = PlaintextDirPackage::new(
        "siglus-structure-export",
        root,
        CaseRule::InsensitiveAscii,
        PackageSource::PublicName("siglus-structure-export".to_string()),
    );
    let mut vfs = MountedVfs::new(
        "siglus-structure-export",
        PackageSource::PublicName("siglus-structure-export".to_string()),
    );
    vfs.mount_plaintext_dir(package);
    let vfs: Arc<dyn RuntimeVfs> = Arc::new(vfs);
    let request = PortRequest::new(
        Path::new("siglus-structure-export-input"),
        "siglus-structure-export",
        RuntimeOperation::Trace,
    )
    .with_vfs(vfs);
    let mut port = UtsushiSiglusPort::new();
    port.launch(&request)
        .map_err(|error| format!("utsushi.structure.siglus.launch: {error}"))?;

    let index = port
        .scene_moment_index()
        .ok_or("utsushi.structure.siglus.launch: decoded scene index was not installed")?;
    let moments = index.moments();
    let scene_lines = port.scene_text_program();
    if moments.is_empty() || moments.len() != scene_lines.len() {
        return Err(format!(
            "utsushi.structure.siglus.coverage: decoded scenes={} observed scene groups={}",
            moments.len(),
            scene_lines.len()
        ));
    }

    let scenes = moments
        .iter()
        .zip(scene_lines)
        .map(|(moment, lines)| {
            let choices: Vec<Value> = port
                .choice_moments()
                .iter()
                .filter(|choice| choice.scene_id == moment.scene_id)
                .flat_map(|choice| choice.options.iter())
                .enumerate()
                .map(|(option_index, option)| {
                    json!({
                        "optionIndex": option_index,
                        "label": option.text,
                        "branchEntryScene": null,
                        "branchMessages": [],
                    })
                })
                .collect();
            let messages: Vec<Value> = lines
                .iter()
                // `scene_text_program` keeps the complete observation order;
                // names have already been joined onto following dialogue by
                // the port and are deliberately not translatable messages.
                .filter(|line| line.text_surface.as_deref() != Some("speaker_name"))
                .enumerate()
                .map(|(order, line)| {
                    json!({
                        "order": order,
                        "speaker": line.speaker,
                        "text": line.text,
                        "textSurface": line.text_surface,
                    })
                })
                .collect();
            json!({
                "sceneId": moment.id.value,
                "selectionControl": if choices.is_empty() { "none" } else { "button-object" },
                "nextScene": null,
                "dispatchFanoutScenes": [],
                "messages": messages,
                "choices": choices,
            })
        })
        .collect::<Vec<_>>();
    let dispatch_order = moments
        .iter()
        .map(|moment| moment.id.value.clone())
        .collect::<Vec<_>>();

    Ok(json!({
        "schemaVersion": "utsushi.narrative-structure.v1",
        "engine": "siglus",
        "entryScene": dispatch_order[0],
        "sceneDispatchOrder": dispatch_order,
        "scenes": scenes,
        "engineEvidence": {
            "siglus": {
                "observation": "static decoded SceneList walk",
                "speakerInformation": "CD_NAME surfaces are joined by decoded command order to following CD_TEXT dialogue; the speaker value is the displayed name, not a canonical character identity",
                "routeEdges": "state-dependent control flow is not evaluated by the static observation port"
            }
        }
    }))
}

fn shared_asset_root(scene_path: &Path, gameexe_path: &Path) -> Result<PathBuf, String> {
    if scene_path
        .file_name()
        .is_none_or(|name| name != "Scene.pck")
    {
        return Err("utsushi.structure.siglus.input: --scene must name Scene.pck".to_string());
    }
    if gameexe_path
        .file_name()
        .is_none_or(|name| name != "Gameexe.dat")
    {
        return Err("utsushi.structure.siglus.input: --gameexe must name Gameexe.dat".to_string());
    }
    let scene_root = scene_path
        .parent()
        .ok_or("utsushi.structure.siglus.input: --scene has no parent directory")?;
    let gameexe_root = gameexe_path
        .parent()
        .ok_or("utsushi.structure.siglus.input: --gameexe has no parent directory")?;
    if scene_root != gameexe_root {
        return Err(
            "utsushi.structure.siglus.input: --scene and --gameexe must be siblings".to_string(),
        );
    }
    scene_root.canonicalize().map_err(|error| {
        format!("utsushi.structure.siglus.input: could not resolve the asset directory: {error}")
    })
}
