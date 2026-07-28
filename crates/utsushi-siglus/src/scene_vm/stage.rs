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
const OBJECT_WIPE_COPY: i32 = 56;
const OBJECT_ORDER: i32 = 55;
const OBJECT_WIPE_ERASE: i32 = 92;

const OBJECT_INIT: i32 = 35;
const OBJECT_FREE: i32 = 36;
const OBJECT_CREATE_PCT: i32 = 38;
const OBJECT_SET_POS: i32 = 48;
const OBJECT_SET_SCALE: i32 = 49;
const OBJECT_SET_ROTATE: i32 = 50;
const OBJECT_SET_CENTER: i32 = 158;
const OBJECT_SET_CLIP: i32 = 160;

/// Player-visible geometry for one root-stage object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageGeometry {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub center_x: i32,
    pub center_y: i32,
    pub center_z: i32,
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
    /// Retained lifetime flag read by a later stage wipe operation.
    pub wipe_copy: i32,
    /// Retained lifetime flag read by a later stage wipe operation.
    pub wipe_erase: i32,
    pub order: i32,
    pub layer: i32,
    pub geometry: StageGeometry,
}

impl Default for StageObject {
    fn default() -> Self {
        Self {
            active: false,
            identity: None,
            visible: false,
            transparency: 255,
            wipe_copy: 0,
            wipe_erase: 0,
            order: 0,
            layer: 0,
            geometry: StageGeometry::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct StageObjectTarget {
    stage: i32,
    slot: i32,
    op: Option<i32>,
}

pub(super) fn target(values: &[Value]) -> Option<StageObjectTarget> {
    let values = values
        .iter()
        .map(|value| match value {
            Value::Int(value) => Some(*value),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
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
    match tail {
        [] => Some(StageObjectTarget {
            stage,
            slot,
            op: None,
        }),
        [op] => Some(StageObjectTarget {
            stage,
            slot,
            op: Some(*op),
        }),
        _ => None,
    }
}

pub(super) fn read(
    state: &VmState,
    target: StageObjectTarget,
    offset: usize,
    scene_id: u32,
) -> Result<Value, VmError> {
    let op = target
        .op
        .ok_or_else(|| unsupported(scene_id, offset, "stage-object-reference"))?;
    let object = state
        .stage_objects
        .get(&target.stage)
        .and_then(|slots| slots.get(&target.slot))
        .cloned()
        .unwrap_or_default();
    let value = property(&object, op).ok_or(VmError::UnsupportedStageObjectProperty {
        scene_id,
        offset,
        property: op,
    })?;
    Ok(Value::Int(value))
}

pub(super) fn assign(
    state: &mut VmState,
    target: StageObjectTarget,
    value: i32,
    offset: usize,
    scene_id: u32,
) -> Result<(), VmError> {
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
    target: StageObjectTarget,
    args: &[Value],
    arg_list_id: i32,
    offset: usize,
    scene_id: u32,
) -> Result<Value, VmError> {
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

fn create_overload_at_least(
    arg_list_id: i32,
    argument_count: usize,
    level: i32,
    required_arguments: usize,
) -> bool {
    arg_list_id >= level || argument_count >= required_arguments
}

fn object_mut(state: &mut VmState, target: StageObjectTarget) -> &mut StageObject {
    state
        .stage_objects
        .entry(target.stage)
        .or_default()
        .entry(target.slot)
        .or_default()
}

fn property(object: &StageObject, op: i32) -> Option<i32> {
    Some(match op {
        OBJECT_DISP => i32::from(object.visible),
        OBJECT_LAYER => object.layer,
        OBJECT_X => object.geometry.x,
        OBJECT_Y => object.geometry.y,
        OBJECT_Z => object.geometry.z,
        OBJECT_CENTER_X => object.geometry.center_x,
        OBJECT_CENTER_Y => object.geometry.center_y,
        OBJECT_CENTER_Z => object.geometry.center_z,
        OBJECT_SCALE_X => object.geometry.scale_x,
        OBJECT_SCALE_Y => object.geometry.scale_y,
        OBJECT_SCALE_Z => object.geometry.scale_z,
        OBJECT_ROTATE_X => object.geometry.rotate_x,
        OBJECT_ROTATE_Y => object.geometry.rotate_y,
        OBJECT_ROTATE_Z => object.geometry.rotate_z,
        OBJECT_CLIP_USE => i32::from(object.geometry.clip.is_some()),
        OBJECT_CLIP_LEFT => object.geometry.clip.map_or(0, |clip| clip.0),
        OBJECT_CLIP_TOP => object.geometry.clip.map_or(0, |clip| clip.1),
        OBJECT_CLIP_RIGHT => object.geometry.clip.map_or(0, |clip| clip.2),
        OBJECT_CLIP_BOTTOM => object.geometry.clip.map_or(0, |clip| clip.3),
        OBJECT_TR => object.transparency,
        OBJECT_WIPE_COPY => object.wipe_copy,
        OBJECT_ORDER => object.order,
        OBJECT_WIPE_ERASE => object.wipe_erase,
        _ => return None,
    })
}

fn set_property(object: &mut StageObject, op: i32, value: i32) -> bool {
    match op {
        OBJECT_DISP => object.visible = value != 0,
        OBJECT_LAYER => object.layer = value,
        OBJECT_X => object.geometry.x = value,
        OBJECT_Y => object.geometry.y = value,
        OBJECT_Z => object.geometry.z = value,
        OBJECT_CENTER_X => object.geometry.center_x = value,
        OBJECT_CENTER_Y => object.geometry.center_y = value,
        OBJECT_CENTER_Z => object.geometry.center_z = value,
        OBJECT_SCALE_X => object.geometry.scale_x = value,
        OBJECT_SCALE_Y => object.geometry.scale_y = value,
        OBJECT_SCALE_Z => object.geometry.scale_z = value,
        OBJECT_ROTATE_X => object.geometry.rotate_x = value,
        OBJECT_ROTATE_Y => object.geometry.rotate_y = value,
        OBJECT_ROTATE_Z => object.geometry.rotate_z = value,
        OBJECT_CLIP_USE => {
            if value == 0 {
                object.geometry.clip = None;
            }
        }
        OBJECT_CLIP_LEFT | OBJECT_CLIP_TOP | OBJECT_CLIP_RIGHT | OBJECT_CLIP_BOTTOM => {
            let mut clip = object.geometry.clip.unwrap_or((0, 0, 0, 0));
            match op {
                OBJECT_CLIP_LEFT => clip.0 = value,
                OBJECT_CLIP_TOP => clip.1 = value,
                OBJECT_CLIP_RIGHT => clip.2 = value,
                OBJECT_CLIP_BOTTOM => clip.3 = value,
                _ => unreachable!(),
            }
            object.geometry.clip = Some(clip);
        }
        OBJECT_TR => object.transparency = value,
        OBJECT_WIPE_COPY => object.wipe_copy = value,
        OBJECT_ORDER => object.order = value,
        OBJECT_WIPE_ERASE => object.wipe_erase = value,
        _ => return false,
    }
    true
}

fn set_vec3(
    x: &mut i32,
    y: &mut i32,
    z: &mut i32,
    args: &[Value],
    scene_id: u32,
    offset: usize,
) -> Result<(), VmError> {
    let values = ints(args, 2, scene_id, offset)?;
    *x = values[0];
    *y = values[1];
    if let Some(value) = values.get(2) {
        *z = *value;
    }
    Ok(())
}

fn ints(args: &[Value], minimum: usize, scene_id: u32, offset: usize) -> Result<Vec<i32>, VmError> {
    let values = args
        .iter()
        .map(|value| match value {
            Value::Int(value) => Some(*value),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| unsupported(scene_id, offset, "stage-object-arguments"))?;
    (values.len() >= minimum)
        .then_some(values)
        .ok_or_else(|| unsupported(scene_id, offset, "stage-object-arguments"))
}

fn int(args: &[Value], index: usize, scene_id: u32, offset: usize) -> Result<i32, VmError> {
    args.get(index)
        .and_then(|value| match value {
            Value::Int(value) => Some(*value),
            _ => None,
        })
        .ok_or_else(|| unsupported(scene_id, offset, "stage-object-create-arguments"))
}

fn text(value: &Value) -> Option<&str> {
    match value {
        Value::Text(value) => Some(value),
        _ => None,
    }
}

fn unsupported(scene_id: u32, offset: usize, operation: &'static str) -> VmError {
    VmError::UnsupportedOperation {
        scene_id,
        offset,
        operation,
    }
}
