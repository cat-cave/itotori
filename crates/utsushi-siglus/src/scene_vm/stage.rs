//! Root-stage object state recovered from executable element paths.

use super::model::{Value, VmError, VmState};

const FORM_STAGE: i32 = 49;
const ELM_ARRAY: i32 = -1;
const STAGE_OBJECT: i32 = 2;

const OBJECT_DISP: i32 = 0;
const OBJECT_LAYER: i32 = 2;
const OBJECT_X: i32 = 3;
const OBJECT_Y: i32 = 4;
const OBJECT_Z: i32 = 5;
const OBJECT_CENTER_X: i32 = 6;
const OBJECT_CENTER_Y: i32 = 7;
const OBJECT_CENTER_Z: i32 = 8;
const OBJECT_CENTER_REP_X: i32 = 9;
const OBJECT_CENTER_REP_Y: i32 = 10;
const OBJECT_CENTER_REP_Z: i32 = 11;
const OBJECT_SCALE_X: i32 = 12;
const OBJECT_SCALE_Y: i32 = 13;
const OBJECT_SCALE_Z: i32 = 14;
const OBJECT_ROTATE_X: i32 = 15;
const OBJECT_ROTATE_Y: i32 = 16;
const OBJECT_ROTATE_Z: i32 = 17;
const OBJECT_CLIP_USE: i32 = 18;
const OBJECT_CLIP_LEFT: i32 = 19;
const OBJECT_CLIP_TOP: i32 = 20;
const OBJECT_CLIP_RIGHT: i32 = 21;
const OBJECT_CLIP_BOTTOM: i32 = 22;
const OBJECT_TR: i32 = 27;
const OBJECT_BLEND: i32 = 46;
const OBJECT_WIPE_COPY: i32 = 56;
const OBJECT_ORDER: i32 = 55;
const OBJECT_WIPE_ERASE: i32 = 92;
const OBJECT_CHILD: i32 = 93;

const OBJECT_INIT: i32 = 35;
const OBJECT_FREE: i32 = 36;
const OBJECT_CREATE_PCT: i32 = 38;
const OBJECT_SET_POS: i32 = 48;
const OBJECT_SET_SCALE: i32 = 49;
const OBJECT_SET_ROTATE: i32 = 50;
const OBJECT_SET_CENTER: i32 = 158;
const OBJECT_SET_CENTER_REP: i32 = 159;
const OBJECT_SET_CLIP: i32 = 160;
const OBJECT_LIST_GET_SIZE: i32 = 3;
const OBJECT_LIST_RESIZE: i32 = 4;

/// Player-visible geometry for one root-stage object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageGeometry {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub center_x: i32,
    pub center_y: i32,
    pub center_z: i32,
    pub center_rep_x: i32,
    pub center_rep_y: i32,
    pub center_rep_z: i32,
    pub scale_x: i32,
    pub scale_y: i32,
    pub scale_z: i32,
    pub rotate_x: i32,
    pub rotate_y: i32,
    pub rotate_z: i32,
    pub clip: Option<(i32, i32, i32, i32)>,
}

impl Default for StageGeometry {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            z: 0,
            center_x: 0,
            center_y: 0,
            center_z: 0,
            center_rep_x: 0,
            center_rep_y: 0,
            center_rep_z: 0,
            scale_x: 1000,
            scale_y: 1000,
            scale_z: 1000,
            rotate_x: 0,
            rotate_y: 0,
            rotate_z: 0,
            clip: None,
        }
    }
}

/// One root-stage slot, retained in [`VmState::stage_objects`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageObject {
    pub active: bool,
    pub identity: Option<String>,
    pub visible: bool,
    pub transparency: i32,
    /// The authored blend mode retained for an embedded object.
    pub blend: i32,
    /// Retained lifetime flag read by a later stage wipe operation.
    pub wipe_copy: i32,
    /// Retained lifetime flag read by a later stage wipe operation.
    pub wipe_erase: i32,
    pub order: i32,
    pub layer: i32,
    pub geometry: StageGeometry,
    /// Embedded `OBJECT.CHILD` slots, keyed by the authored child index.
    pub children: std::collections::BTreeMap<i32, StageObject>,
}

impl Default for StageObject {
    fn default() -> Self {
        Self {
            active: false,
            identity: None,
            visible: false,
            transparency: 255,
            blend: 0,
            wipe_copy: 0,
            wipe_erase: 0,
            order: 0,
            layer: 0,
            geometry: StageGeometry::default(),
            children: std::collections::BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StageObjectTarget {
    stage: i32,
    slot: i32,
    children: Vec<i32>,
    op: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum StageTarget {
    Object(StageObjectTarget),
    ObjectList { stage: i32, op: i32 },
}

pub(super) fn target(values: &[Value]) -> Option<StageTarget> {
    let values = values
        .iter()
        .map(|value| match value {
            Value::Int(value) => Some(*value),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    if let [FORM_STAGE, STAGE_OBJECT, ELM_ARRAY, stage, op] = values.as_slice() {
        // The installed corpus uses the compact root-stage list form. The
        // reference parses this as ChildListOp for 3/4, not as a slot property:
        // siglus_scene_vm/src/runtime/forms/stage.rs:262-281.
        if matches!(*op, OBJECT_LIST_GET_SIZE | OBJECT_LIST_RESIZE) {
            return Some(StageTarget::ObjectList {
                stage: *stage,
                op: *op,
            });
        }
        return Some(StageTarget::Object(StageObjectTarget {
            stage: *stage,
            slot: 0,
            children: Vec::new(),
            op: Some(*op),
        }));
    }
    let (stage, slot, tail) = match values.as_slice() {
        [
            FORM_STAGE,
            ELM_ARRAY,
            stage,
            STAGE_OBJECT,
            ELM_ARRAY,
            slot,
            tail @ ..,
        ] => (*stage, *slot, tail),
        [
            form @ (37 | 38 | 73),
            STAGE_OBJECT,
            ELM_ARRAY,
            slot,
            tail @ ..,
        ] => (
            match form {
                37 => 0,
                38 => 1,
                73 => 2,
                _ => unreachable!(),
            },
            *slot,
            tail,
        ),
        _ => return None,
    };
    object_target(stage, slot, tail).map(StageTarget::Object)
}

/// Decode a root object followed by zero or more `OBJECT.CHILD[index]`
/// selectors. The reference treats each child as a full embedded object, so
/// its final property/command is dispatched against the child rather than
/// discarded as an unknown tail.
fn object_target(stage: i32, slot: i32, mut tail: &[i32]) -> Option<StageObjectTarget> {
    let mut children = Vec::new();
    while let [OBJECT_CHILD, ELM_ARRAY, child, rest @ ..] = tail {
        children.push(*child);
        tail = rest;
    }
    let op = match tail {
        [] => None,
        [op] => Some(*op),
        _ => return None,
    };
    Some(StageObjectTarget {
        stage,
        slot,
        children,
        op,
    })
}

pub(super) fn read(
    state: &VmState,
    target: StageTarget,
    offset: usize,
    scene_id: u32,
) -> Result<Value, VmError> {
    let StageTarget::Object(target) = target else {
        let StageTarget::ObjectList { stage, op } = target else {
            unreachable!();
        };
        return (op == OBJECT_LIST_GET_SIZE)
            .then(|| {
                Value::Int(
                    state
                        .stage_object_list_sizes
                        .get(&stage)
                        .copied()
                        .or_else(|| {
                            state
                                .stage_objects
                                .get(&stage)
                                .map(std::collections::BTreeMap::len)
                        })
                        .unwrap_or(0) as i32,
                )
            })
            .ok_or_else(|| unsupported(scene_id, offset, "stage-object-list-read"));
    };
    let op = target
        .op
        .ok_or_else(|| unsupported(scene_id, offset, "stage-object-reference"))?;
    let mut object = state
        .stage_objects
        .get(&target.stage)
        .and_then(|slots| slots.get(&target.slot))
        .cloned()
        .unwrap_or_default();
    for child in &target.children {
        object = object.children.get(child).cloned().unwrap_or_default();
    }
    let value = property(&object, op).ok_or(VmError::UnsupportedStageObjectProperty {
        scene_id,
        offset,
        property: op,
    })?;
    Ok(Value::Int(value))
}

pub(super) fn assign(
    state: &mut VmState,
    target: StageTarget,
    value: i32,
    offset: usize,
    scene_id: u32,
) -> Result<(), VmError> {
    let StageTarget::Object(target) = target else {
        return Err(unsupported(
            scene_id,
            offset,
            "stage-object-list-assignment",
        ));
    };
    let op = target
        .op
        .ok_or_else(|| unsupported(scene_id, offset, "stage-object-reference"))?;
    let object = object_mut(state, target);
    set_property(object, op, value)
        .then_some(())
        .ok_or(VmError::UnsupportedStageObjectProperty {
            scene_id,
            offset,
            property: op,
        })
}

pub(super) fn command(
    state: &mut VmState,
    target: StageTarget,
    args: &[Value],
    arg_list_id: i32,
    offset: usize,
    scene_id: u32,
) -> Result<Value, VmError> {
    if let StageTarget::ObjectList { stage, op } = target {
        if op != OBJECT_LIST_RESIZE {
            return Err(unsupported(scene_id, offset, "stage-object-list-command"));
        }
        let size = int(args, 0, scene_id, offset)?;
        let size = usize::try_from(size)
            .map_err(|_| unsupported(scene_id, offset, "stage-object-list-size"))?;
        state.stage_object_list_sizes.insert(stage, size);
        state
            .stage_objects
            .entry(stage)
            .or_default()
            .retain(|slot, _| *slot >= 0 && (*slot as usize) < size);
        return Ok(Value::Int(0));
    }
    let StageTarget::Object(target) = target else {
        unreachable!();
    };
    let op = target
        .op
        .ok_or_else(|| unsupported(scene_id, offset, "stage-object-reference"))?;
    let object = object_mut(state, target);
    match op {
        OBJECT_INIT | OBJECT_FREE => *object = StageObject::default(),
        OBJECT_CREATE_PCT => {
            let identity = args
                .first()
                .and_then(text)
                .ok_or_else(|| unsupported(scene_id, offset, "stage-object-create-identity"))?;
            object.active = true;
            object.identity = Some(identity.to_string());
            // OBJECT.CREATE's overloads are `(file)`, `(file, disp)`, and
            // `(file, disp, x, y[, patno])`. Preserve x/y only when the
            // executed bytecode supplied that overload. The reference writes
            // these values during create, before any later SET_POS call; see
            // siglus_scene_vm/src/runtime/forms/stage.rs:8900-8923.
            if create_overload_at_least(arg_list_id, args.len(), 1, 2) {
                object.visible = int(args, 1, scene_id, offset)? != 0;
            }
            if create_overload_at_least(arg_list_id, args.len(), 2, 4) {
                object.geometry.x = int(args, 2, scene_id, offset)?;
                object.geometry.y = int(args, 3, scene_id, offset)?;
            }
        }
        OBJECT_SET_POS => set_vec3(
            &mut object.geometry.x,
            &mut object.geometry.y,
            &mut object.geometry.z,
            args,
            scene_id,
            offset,
        )?,
        OBJECT_SET_CENTER => set_vec3(
            &mut object.geometry.center_x,
            &mut object.geometry.center_y,
            &mut object.geometry.center_z,
            args,
            scene_id,
            offset,
        )?,
        OBJECT_SET_CENTER_REP => set_vec3(
            &mut object.geometry.center_rep_x,
            &mut object.geometry.center_rep_y,
            &mut object.geometry.center_rep_z,
            args,
            scene_id,
            offset,
        )?,
        OBJECT_SET_SCALE => set_vec3(
            &mut object.geometry.scale_x,
            &mut object.geometry.scale_y,
            &mut object.geometry.scale_z,
            args,
            scene_id,
            offset,
        )?,
        OBJECT_SET_ROTATE => set_vec3(
            &mut object.geometry.rotate_x,
            &mut object.geometry.rotate_y,
            &mut object.geometry.rotate_z,
            args,
            scene_id,
            offset,
        )?,
        OBJECT_SET_CLIP => {
            let values = ints(args, 4, scene_id, offset)?;
            object.geometry.clip = Some((values[0], values[1], values[2], values[3]));
        }
        _ => return Err(unsupported(scene_id, offset, "stage-object-command")),
    }
    Ok(Value::Int(0))
}

mod properties;

use self::properties::{
    create_overload_at_least, int, ints, object_mut, property, set_property, set_vec3, text,
    unsupported,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_stage_object_list_resize_keeps_its_stage_for_picture_creation() {
        let resize = target(&[
            Value::Int(FORM_STAGE),
            Value::Int(STAGE_OBJECT),
            Value::Int(ELM_ARRAY),
            Value::Int(1),
            Value::Int(OBJECT_LIST_RESIZE),
        ])
        .expect("reference compact stage-list path is recognised");
        let mut state = VmState::default();
        command(&mut state, resize, &[Value::Int(2)], 0, 18, 7)
            .expect("the authored list resize must execute");
        let create = target(&[
            Value::Int(FORM_STAGE),
            Value::Int(STAGE_OBJECT),
            Value::Int(ELM_ARRAY),
            Value::Int(1),
            Value::Int(OBJECT_CREATE_PCT),
        ])
        .expect("the compact path's implicit slot zero is recognised");
        command(
            &mut state,
            create,
            &[Value::Text("BG01A01".to_string()), Value::Int(1)],
            1,
            19,
            7,
        )
        .expect("the following authored picture creation must execute");

        assert_eq!(state.stage_object_list_sizes.get(&1), Some(&2));
        assert_eq!(
            state.stage_objects[&1][&0].identity.as_deref(),
            Some("BG01A01"),
            "removing compact list-path dispatch prevents the real background identity from reaching the compositor"
        );
    }
}
