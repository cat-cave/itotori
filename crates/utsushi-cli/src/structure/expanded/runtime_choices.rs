//! Runtime-only choice surfaces: the displayed options a replay observes that
//! have NO static BridgeUnit behind them (a system menu, a save/continue
//! prompt). They carry no translatable script, so they are emitted for graph
//! completeness only, marked `runtime_only`.
//!
//! Root cause this module isolates: a scene's play loop can re-display the SAME
//! prompt on every pass, so the observation's prompt list carries one entry per
//! DISPLAY. `choiceId` identifies the choice SURFACE — scene + prompt byte
//! offset + option index — and every consumer of the narrative structure keys
//! choices by that surface identity. Emitting one entry per display therefore
//! produced thousands of colliding `choiceId`s in a single scene, which the
//! structure consumer rejects outright ("scene … repeats a choice index"),
//! taking the whole export down with it.

use std::collections::BTreeSet;

use serde_json::{Value, json};
use utsushi_core::TextLine;
use utsushi_reallive::{SceneId, SelectionPrompt};

use crate::structure::graph::Edge;

const NO_BRIDGE_UNIT_DIAGNOSTIC: &str =
    "choice target is unknown because the displayed option has no static BridgeUnit";

/// Build the runtime-only choice entries + their edges for one observed scene.
///
/// `bridge_linked` answers "does this replay line already have a static
/// BridgeUnit?" — those options are emitted by the bridge-linked path instead
/// and are skipped here.
///
/// Each distinct surface is emitted EXACTLY ONCE, however many times the play
/// loop re-displayed it.
pub(super) fn runtime_only_choices(
    scene_id: SceneId,
    prompts: &[SelectionPrompt],
    lines: &[TextLine],
    bridge_linked: &dyn Fn(&str) -> bool,
) -> Result<Vec<(Value, Edge)>, String> {
    let mut emitted = BTreeSet::new();
    let mut out = Vec::new();
    for prompt in prompts {
        for (option_index, line_id) in prompt.option_line_ids.iter().enumerate() {
            if bridge_linked(line_id) {
                continue;
            }
            let line = lines
                .iter()
                .find(|line| &line.line_id == line_id)
                .ok_or_else(|| format!("choice line {line_id} is absent from the replay stream"))?;
            let option_index = u16::try_from(option_index)
                .map_err(|err| format!("choice option index is out of range: {err}"))?;
            let choice_id = format!(
                "choice:runtime:scene-{scene_id:04}:prompt-{}:option-{option_index}",
                prompt.byte_offset_in_scene
            );
            if !emitted.insert(choice_id.clone()) {
                continue;
            }
            let edge = Edge::choice(
                scene_id,
                &choice_id,
                option_index,
                None,
                false,
                Some(NO_BRIDGE_UNIT_DIAGNOSTIC.to_string()),
            );
            let value = json!({
                "choiceId": choice_id,
                "choiceGroupId": format!(
                    "choice-group:runtime:scene-{scene_id:04}:prompt-{}",
                    prompt.byte_offset_in_scene
                ),
                "edgeId": edge.id,
                "edgeResolution": edge.resolution,
                "unresolvedEdgeDiagnostic": NO_BRIDGE_UNIT_DIAGNOSTIC,
                "optionIndex": option_index,
                "label": line.text,
                "bridgeRef": null,
                // Mark it runtime_only so the localization join skips it exactly
                // as it skips a runtime-only message, rather than demanding a
                // (non-existent) bridge binding.
                "linkageStatus": "runtime_only",
                "runtimeOnlyReason": "no BridgeUnit exists for this runtime choice surface",
                "branchEntryScene": null,
                "branchTargetSceneId": null,
                "branchMessages": [],
            });
            out.push((value, edge));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
