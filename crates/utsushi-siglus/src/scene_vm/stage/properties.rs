use super::*;

pub(super) fn create_overload_at_least(
    arg_list_id: i32,
    argument_count: usize,
    level: i32,
    required_arguments: usize,
) -> bool {
    arg_list_id >= level || argument_count >= required_arguments
}

pub(super) fn object_mut(state: &mut VmState, target: StageObjectTarget) -> &mut StageObject {
    state
        .stage_objects
        .entry(target.stage)
        .or_default()
        .entry(target.slot)
        .or_default()
}

pub(super) fn property(object: &StageObject, op: i32) -> Option<i32> {
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

pub(super) fn set_property(object: &mut StageObject, op: i32, value: i32) -> bool {
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

pub(super) fn set_vec3(
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

pub(super) fn ints(
    args: &[Value],
    minimum: usize,
    scene_id: u32,
    offset: usize,
) -> Result<Vec<i32>, VmError> {
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

pub(super) fn int(
    args: &[Value],
    index: usize,
    scene_id: u32,
    offset: usize,
) -> Result<i32, VmError> {
    args.get(index)
        .and_then(|value| match value {
            Value::Int(value) => Some(*value),
            _ => None,
        })
        .ok_or_else(|| unsupported(scene_id, offset, "stage-object-create-arguments"))
}

pub(super) fn text(value: &Value) -> Option<&str> {
    match value {
        Value::Text(value) => Some(value),
        _ => None,
    }
}

pub(super) fn unsupported(scene_id: u32, offset: usize, operation: &'static str) -> VmError {
    VmError::UnsupportedOperation {
        scene_id,
        offset,
        operation,
    }
}
