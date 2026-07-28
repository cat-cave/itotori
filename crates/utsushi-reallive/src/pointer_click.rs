//! Explicit, geometry-derived pointer policy for a live RealLive screen.

use utsushi_core::input::{InputEvent, PointerButton};

use crate::graphics_objects::{GraphicsObjectStack, HitRect};
use crate::input_bridge::{REALLIVE_RAW_INPUT_ENGINE, REALLIVE_RAW_PRIMARY_RELEASE};

/// The default live-session virtual screen, used by the cursor syscall.
pub const LIVE_SESSION_SCREEN: (i32, i32) = (640, 480);

/// A refusal to manufacture a pointer target from incomplete graphics state.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HydratedPrimaryClickError {
    #[error("utsushi.reallive.pointer_click.rectangle_missing: values={values:?}")]
    RectangleMissing { values: [Option<i32>; 4] },
    #[error("utsushi.reallive.pointer_click.rectangle_not_hydrated: {rectangle:?}")]
    RectangleNotHydrated { rectangle: HitRect },
    #[error("utsushi.reallive.pointer_click.empty_rectangle: {rectangle:?}")]
    EmptyRectangle { rectangle: HitRect },
}

/// A real primary-button press/release pair derived from hydrated object art.
///
/// Policy: take the script's current four bank operands, require that exact
/// rectangle to match a visible hydrated object, then choose its strict
/// interior centre. No coordinate is accepted from a caller or stored as a
/// policy constant.
#[derive(Debug, Clone, PartialEq)]
pub struct HydratedPrimaryClick {
    pub rectangle: HitRect,
    pub pixel: (i32, i32),
    pub normalized: (f32, f32),
}

impl HydratedPrimaryClick {
    /// Derive the click from the VM rectangle and graphics stack at the input
    /// boundary. A changed rectangle produces a changed gesture.
    pub fn from_rectangle(
        stack: &GraphicsObjectStack,
        values: [Option<i32>; 4],
    ) -> Result<Self, HydratedPrimaryClickError> {
        let [Some(x), Some(y), Some(width), Some(height)] = values else {
            return Err(HydratedPrimaryClickError::RectangleMissing { values });
        };
        let rectangle = HitRect {
            x,
            y,
            width,
            height,
        };
        if rectangle.width < 2 || rectangle.height < 2 {
            return Err(HydratedPrimaryClickError::EmptyRectangle { rectangle });
        }
        let hydrated = stack.iter_allocated_layers().any(|(_, _, object)| {
            object.visible
                && object.position.x == rectangle.x
                && object.position.y == rectangle.y
                && object.geometry.surface.is_some_and(|surface| {
                    surface.width == rectangle.width && surface.height == rectangle.height
                })
        });
        if !hydrated {
            return Err(HydratedPrimaryClickError::RectangleNotHydrated { rectangle });
        }
        let pixel = (
            rectangle.x.saturating_add(rectangle.width / 2),
            rectangle.y.saturating_add(rectangle.height / 2),
        );
        Ok(Self {
            rectangle,
            pixel,
            normalized: (
                pixel.0 as f32 / (LIVE_SESSION_SCREEN.0 - 1) as f32,
                pixel.1 as f32 / (LIVE_SESSION_SCREEN.1 - 1) as f32,
            ),
        })
    }

    /// The exact press then release input stream the cursor poll observes.
    pub fn events(&self) -> [InputEvent; 2] {
        [
            InputEvent::Pointer {
                x: self.normalized.0,
                y: self.normalized.1,
                button: PointerButton::Primary,
            },
            InputEvent::raw(REALLIVE_RAW_INPUT_ENGINE, REALLIVE_RAW_PRIMARY_RELEASE),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GraphicsLayer, GraphicsObject, GraphicsPosition, SurfaceGeometry};

    #[test]
    fn click_follows_the_current_hydrated_vm_rectangle() {
        let mut stack = GraphicsObjectStack::new();
        let mut object = GraphicsObject::image("button-art");
        object.position = GraphicsPosition { x: 20, y: 30 };
        object.geometry.surface = Some(SurfaceGeometry {
            width: 100,
            height: 40,
            origin: GraphicsPosition::ORIGIN,
        });
        stack
            .set_layer(GraphicsLayer::ForegroundObject, 1, object)
            .expect("in-range object slot");

        let click =
            HydratedPrimaryClick::from_rectangle(&stack, [Some(20), Some(30), Some(100), Some(40)])
                .expect("hydrated button click");
        assert_eq!(
            click.rectangle,
            HitRect {
                x: 20,
                y: 30,
                width: 100,
                height: 40
            }
        );
        assert_eq!(click.pixel, (70, 50));
        assert!(matches!(
            click.events(),
            [InputEvent::Pointer { .. }, InputEvent::Raw { .. }]
        ));
    }
}
