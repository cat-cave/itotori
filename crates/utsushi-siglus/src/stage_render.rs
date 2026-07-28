//! Projection of decoded Siglus root-stage objects onto a real G00 raster.
//!
//! This module intentionally owns no asset discovery.  Its caller must resolve
//! every object identity against the installed game and hand back the decoded
//! G00.  Missing or unsupported source content is a terminal error, never a
//! blank substitute layer.

use std::collections::BTreeMap;

use thiserror::Error;

use crate::scene_vm::StageObject;
use crate::{SiglusCgFrame, SiglusG00Image};

/// Failures while turning materialised stage state into a raster.
#[derive(Debug, Error)]
pub enum SiglusStageRenderError {
    /// No player-visible object exists at the requested stage state.
    #[error("utsushi.siglus.stage_render.no_visible_objects")]
    NoVisibleObjects,
    /// An active object lacked the source identity the VM should have retained.
    #[error("utsushi.siglus.stage_render.missing_identity: stage {stage} slot {slot}")]
    MissingIdentity { stage: i32, slot: i32 },
    /// The installed title did not supply a decoded image for this authored name.
    #[error("utsushi.siglus.stage_render.asset: {identity}: {detail}")]
    Asset { identity: String, detail: String },
    /// A transform outside the currently projected subset was encountered.
    #[error(
        "utsushi.siglus.stage_render.unsupported_transform: stage {stage} slot {slot}: {detail}"
    )]
    UnsupportedTransform {
        stage: i32,
        slot: i32,
        detail: &'static str,
    },
    /// Author-provided geometry cannot safely fit an addressable raster.
    #[error("utsushi.siglus.stage_render.invalid_bounds: stage {stage} slot {slot}")]
    InvalidBounds { stage: i32, slot: i32 },
    /// Raster allocation would overflow or exceed the conservative live-player limit.
    #[error("utsushi.siglus.stage_render.canvas_limit: {width}x{height}")]
    CanvasLimit { width: u32, height: u32 },
}

#[derive(Debug)]
struct Layer {
    stage: i32,
    slot: i32,
    object: StageObject,
    image: SiglusG00Image,
}

/// Render all active, visible root-stage objects in the authored stage/order/
/// layer/slot order.
///
/// The canvas bounds, source pixels, and layer ordering are all decoded from
/// the supplied state and G00 bytes.  The renderer refuses rotations and
/// non-zero centres until those transforms are implemented, because applying
/// an invented approximation would look like a valid game frame.
pub fn render_siglus_stage<F, E>(
    objects: &BTreeMap<i32, BTreeMap<i32, StageObject>>,
    mut load: F,
) -> Result<SiglusCgFrame, SiglusStageRenderError>
where
    F: FnMut(&str) -> Result<SiglusG00Image, E>,
    E: std::fmt::Display,
{
    let mut layers = Vec::new();
    for (stage, slots) in objects {
        for (slot, object) in slots {
            if !object.active || !object.visible || object.transparency <= 0 {
                continue;
            }
            let identity =
                object
                    .identity
                    .as_deref()
                    .ok_or(SiglusStageRenderError::MissingIdentity {
                        stage: *stage,
                        slot: *slot,
                    })?;
            validate_transform(*stage, *slot, object)?;
            let image = load(identity).map_err(|error| SiglusStageRenderError::Asset {
                identity: identity.to_string(),
                detail: error.to_string(),
            })?;
            layers.push(Layer {
                stage: *stage,
                slot: *slot,
                object: object.clone(),
                image,
            });
        }
    }
    if layers.is_empty() {
        return Err(SiglusStageRenderError::NoVisibleObjects);
    }
    layers.sort_by_key(|layer| {
        (
            layer.stage,
            layer.object.layer,
            layer.object.order,
            layer.slot,
        )
    });

    let (width, height) = canvas_bounds(&layers)?;
    let pixel_len = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(SiglusStageRenderError::CanvasLimit { width, height })?;
    let mut pixels_rgba = vec![0; pixel_len];
    for layer in &layers {
        composite_layer(&mut pixels_rgba, width, height, layer)?;
    }
    Ok(SiglusCgFrame {
        width,
        height,
        pixels_rgba,
    })
}

fn validate_transform(
    stage: i32,
    slot: i32,
    object: &StageObject,
) -> Result<(), SiglusStageRenderError> {
    let geometry = &object.geometry;
    if geometry.z != 0 {
        return Err(SiglusStageRenderError::UnsupportedTransform {
            stage,
            slot,
            detail: "z",
        });
    }
    if geometry.center_x != 0 || geometry.center_y != 0 || geometry.center_z != 0 {
        return Err(SiglusStageRenderError::UnsupportedTransform {
            stage,
            slot,
            detail: "centre",
        });
    }
    if geometry.rotate_x != 0 || geometry.rotate_y != 0 || geometry.rotate_z != 0 {
        return Err(SiglusStageRenderError::UnsupportedTransform {
            stage,
            slot,
            detail: "rotation",
        });
    }
    if geometry.scale_x <= 0 || geometry.scale_y <= 0 || geometry.scale_z <= 0 {
        return Err(SiglusStageRenderError::UnsupportedTransform {
            stage,
            slot,
            detail: "non-positive scale",
        });
    }
    Ok(())
}

fn canvas_bounds(layers: &[Layer]) -> Result<(u32, u32), SiglusStageRenderError> {
    let mut right = 0_i64;
    let mut bottom = 0_i64;
    for layer in layers {
        let geometry = &layer.object.geometry;
        if geometry.x < 0 || geometry.y < 0 {
            return Err(SiglusStageRenderError::InvalidBounds {
                stage: layer.stage,
                slot: layer.slot,
            });
        }
        let scaled_width = scaled_extent(layer.image.width, geometry.scale_x).ok_or(
            SiglusStageRenderError::InvalidBounds {
                stage: layer.stage,
                slot: layer.slot,
            },
        )?;
        let scaled_height = scaled_extent(layer.image.height, geometry.scale_y).ok_or(
            SiglusStageRenderError::InvalidBounds {
                stage: layer.stage,
                slot: layer.slot,
            },
        )?;
        right = right.max(i64::from(geometry.x) + i64::from(scaled_width));
        bottom = bottom.max(i64::from(geometry.y) + i64::from(scaled_height));
    }
    let width = u32::try_from(right).map_err(|_| SiglusStageRenderError::CanvasLimit {
        width: u32::MAX,
        height: u32::MAX,
    })?;
    let height = u32::try_from(bottom).map_err(|_| SiglusStageRenderError::CanvasLimit {
        width: u32::MAX,
        height: u32::MAX,
    })?;
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err(SiglusStageRenderError::CanvasLimit { width, height });
    }
    Ok((width, height))
}

fn scaled_extent(value: u32, scale: i32) -> Option<u32> {
    u64::from(value)
        .checked_mul(u64::try_from(scale).ok()?)
        .and_then(|value| value.checked_add(999))
        .map(|value| value / 1000)
        .and_then(|value| u32::try_from(value).ok())
}

fn composite_layer(
    destination: &mut [u8],
    width: u32,
    height: u32,
    layer: &Layer,
) -> Result<(), SiglusStageRenderError> {
    let geometry = &layer.object.geometry;
    let scaled_width = scaled_extent(layer.image.width, geometry.scale_x).ok_or(
        SiglusStageRenderError::InvalidBounds {
            stage: layer.stage,
            slot: layer.slot,
        },
    )?;
    let scaled_height = scaled_extent(layer.image.height, geometry.scale_y).ok_or(
        SiglusStageRenderError::InvalidBounds {
            stage: layer.stage,
            slot: layer.slot,
        },
    )?;
    for y in 0..scaled_height {
        let target_y = u32::try_from(geometry.y)
            .unwrap_or_default()
            .saturating_add(y);
        if target_y >= height || !within_clip(geometry.clip, target_y as i32, false) {
            continue;
        }
        let source_y = y.saturating_mul(layer.image.height) / scaled_height;
        for x in 0..scaled_width {
            let target_x = u32::try_from(geometry.x)
                .unwrap_or_default()
                .saturating_add(x);
            if target_x >= width || !within_clip(geometry.clip, target_x as i32, true) {
                continue;
            }
            let source_x = x.saturating_mul(layer.image.width) / scaled_width;
            let source = pixel(
                &layer.image.pixels_rgba,
                layer.image.width,
                source_x,
                source_y,
            );
            let destination = pixel_mut(destination, width, target_x, target_y);
            source_over(source, destination, layer.object.transparency as u8);
        }
    }
    Ok(())
}

fn within_clip(clip: Option<(i32, i32, i32, i32)>, point: i32, horizontal: bool) -> bool {
    let Some((left, top, right, bottom)) = clip else {
        return true;
    };
    if horizontal {
        point >= left && point < right
    } else {
        point >= top && point < bottom
    }
}

fn pixel(pixels: &[u8], width: u32, x: u32, y: u32) -> &[u8] {
    let index = ((y * width + x) * 4) as usize;
    &pixels[index..index + 4]
}

fn pixel_mut(pixels: &mut [u8], width: u32, x: u32, y: u32) -> &mut [u8] {
    let index = ((y * width + x) * 4) as usize;
    &mut pixels[index..index + 4]
}

fn source_over(source: &[u8], destination: &mut [u8], transparency: u8) {
    let alpha = u32::from(source[3]) * u32::from(transparency) / 255;
    if alpha == 0 {
        return;
    }
    let destination_alpha = u32::from(destination[3]);
    let output_alpha = alpha + (destination_alpha * (255 - alpha) + 127) / 255;
    if output_alpha == 0 {
        return;
    }
    for channel in 0..3 {
        let numerator = u32::from(source[channel]) * alpha * 255
            + u32::from(destination[channel]) * destination_alpha * (255 - alpha);
        destination[channel] = (numerator / (output_alpha * 255)).min(255) as u8;
    }
    destination[3] = output_alpha as u8;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SiglusG00Kind;
    use crate::scene_vm::StageGeometry;

    fn image(pixel: [u8; 4]) -> SiglusG00Image {
        SiglusG00Image {
            kind: SiglusG00Kind::RawBgr,
            width: 1,
            height: 1,
            pixels_rgba: pixel.to_vec(),
            layers: Vec::new(),
        }
    }

    #[test]
    fn stage_renderer_composites_the_real_identity_in_authored_order() {
        let mut objects = BTreeMap::new();
        objects.insert(
            0,
            BTreeMap::from([
                (
                    4,
                    StageObject {
                        active: true,
                        visible: true,
                        identity: Some("back".to_string()),
                        ..StageObject::default()
                    },
                ),
                (
                    5,
                    StageObject {
                        active: true,
                        visible: true,
                        identity: Some("front".to_string()),
                        order: 1,
                        geometry: StageGeometry {
                            x: 1,
                            ..StageGeometry::default()
                        },
                        ..StageObject::default()
                    },
                ),
            ]),
        );
        let frame = render_siglus_stage(&objects, |identity| match identity {
            "back" => Ok::<_, &'static str>(SiglusG00Image {
                kind: SiglusG00Kind::RawBgr,
                width: 2,
                height: 1,
                pixels_rgba: [255, 0, 0, 255, 255, 0, 0, 255].to_vec(),
                layers: Vec::new(),
            }),
            "front" => Ok(image([0, 255, 0, 255])),
            _ => Err("unexpected identity"),
        })
        .expect("the resolved authored G00s are projected");
        assert_eq!((frame.width, frame.height), (2, 1));
        assert_eq!(frame.pixels_rgba, [255, 0, 0, 255, 0, 255, 0, 255]);
    }

    #[test]
    fn stage_renderer_refuses_to_hide_a_missing_authored_asset_with_a_blank_layer() {
        let objects = BTreeMap::from([(
            0,
            BTreeMap::from([(
                0,
                StageObject {
                    active: true,
                    visible: true,
                    identity: Some("missing".to_string()),
                    ..StageObject::default()
                },
            )]),
        )]);
        let error = render_siglus_stage(&objects, |_| Err::<SiglusG00Image, _>("not found"))
            .expect_err("a renderer core deletion or placeholder path must fail here");
        assert!(matches!(error, SiglusStageRenderError::Asset { .. }));
    }
}
