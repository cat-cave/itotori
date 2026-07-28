//! Which on-screen objects a selection prompt can offer, and what picking one
//! returns.
//!
//! A script declares its clickable buttons by binding options onto graphics
//! objects it has already created, then raising a prompt that asks for a
//! group. Three things have to agree for that to work: the plane the objects
//! were built on, the group the binding belongs to, and the group the prompt
//! asks for. Disagree on any of them and the prompt finds nothing, advances
//! past itself, and the branch after it reads a register nobody wrote.

use super::GraphicsRuntime;
use crate::graphics_objects::GRAPHICS_OBJECT_SLOT_COUNT;
use crate::graphics_objects::{ButtonOptions, GraphicsLayer, GraphicsObject};

/// The button group a binding belongs to when the bytecode names none, and
/// the group a selection asks for when it names none. Both the short
/// `objButtonOpts` shape and the no-argument selection/init shapes omit the
/// group, so they have to meet on the same value or a real screen's buttons
/// would be invisible to its own prompt.
pub const DEFAULT_BUTTON_GROUP: i32 = 0;

/// The top-level object layers a button binding can live on, in scan order.
/// A script chooses a plane per screen; the prompt has to look at both or it
/// reports an empty option list for every screen built on the other one.
pub const BUTTON_CANDIDATE_LAYERS: [GraphicsLayer; 2] = [
    GraphicsLayer::ForegroundObject,
    GraphicsLayer::BackgroundObject,
];

/// Immutable object-button candidate detached from runtime state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ButtonCandidate {
    /// The object layer the binding was found on.
    pub layer: GraphicsLayer,
    pub slot: usize,
    pub options: ButtonOptions,
    pub visible: bool,
    /// Exact detached top-level object state captured while the graphics mutex
    /// is held. It is not an asset-resolution or hit-test result.
    pub object: GraphicsObject,
}

impl GraphicsRuntime {
    /// Deterministic `(layer, slot)` button bindings for one exact group,
    /// across both top-level object planes.
    pub fn button_group_bindings(&self, group: i32) -> Vec<(GraphicsLayer, usize, ButtonOptions)> {
        self.button_candidates(group)
            .into_iter()
            .map(|candidate| (candidate.layer, candidate.slot, candidate.options))
            .collect()
    }

    /// Exact bindings for `group` on both top-level object planes, scanned in
    /// ascending slot order within each plane. Visibility is reported but
    /// never filters a candidate.
    pub fn button_candidates(&self, group: i32) -> Vec<ButtonCandidate> {
        let mut candidates = Vec::new();
        for layer in BUTTON_CANDIDATE_LAYERS {
            for slot in 0..GRAPHICS_OBJECT_SLOT_COUNT {
                let found = self.with_stack(|stack| {
                    let object = stack.get_layer(layer, slot)?;
                    let options = object.button_options?;
                    (options.group == group).then(|| ButtonCandidate {
                        layer,
                        slot,
                        options,
                        visible: object.visible,
                        object: object.clone(),
                    })
                });
                candidates.extend(found);
            }
        }
        candidates
    }
}

/// Resolve an `objButtonOpts` argument list into `(action, se, group,
/// button_number)`.
///
/// Two shapes occur on real bytes. The long shape spells every field out. The
/// short shape carries `(buf, action, se)` only: the script binds the button
/// without naming a group or a return number, so the binding takes the
/// default group and the object's OWN slot as its identity — the value the
/// prompt returns for it, and the value the branch after the prompt matches
/// on. A real archive uses the short shape for every one of its bindings, and
/// its branches match exactly the set of slots it bound, gaps included.
pub(super) fn button_opts_tuple(values: &[i32]) -> Option<(i32, i32, i32, i32)> {
    match *values {
        [_buf, action, se, group, button_number] => Some((action, se, group, button_number)),
        [buf, action, se] => Some((action, se, DEFAULT_BUTTON_GROUP, buf)),
        _ => None,
    }
}
