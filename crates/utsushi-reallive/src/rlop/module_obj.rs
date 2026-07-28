//! RealLive `module_obj_management` + `module_obj_fg_bg` RLOperation subset.
//!
//! Implements the alpha-tier object-stack subset the spec
//! node pins:
//!
//! - `module_obj_management` (`(1, 60)`): `objAlloc`, `objFree`
//!   `objInit`, `objCopy`.
//! - `module_obj_fg_bg` (`(1, 81)` foreground / `(1, 82)` background):
//!   per-object setters `objSetPos`, `objSetAlpha`, `objSetScale`
//!   `objSetLayer`, plus `objShow` / `objHide`.
//!
//! Every op routes through a shared [`GraphicsRuntime`] that owns the
//! [`crate::GraphicsObjectStack`] state, a typed VFS surface for
//! `module_grp::openBg`-style g00 reads, the long-op id sequence used
//! by the `module_grp` `fade` op, and the fail-soft warning queue.
//!
//! # Layer-ordering posture (audit-focus pin)
//!
//! This module's audit-focus item is "layer-ordering that ignores
//! `objSetLayer`". The render-pass at [`crate::RenderPass::rasterise`]
//! already sorts allocated objects by
//! `(plane.paint_order(), layer_order, slot)` — pinned this. The
//! `objSetLayer` directly mutates [`crate::GraphicsObject::layer_order`],
//! so a render after a `objSetLayer` re-orders the paint output
//! observably; the acceptance test
//! `obj_set_layer_reorders_render_pass_output` pins that the
//! highest-`layer_order` object wins the single pixel of a 1×1
//! framebuffer regardless of `objSetLayer` call order.

mod button_bindings;
mod image_geometry;
#[cfg(test)]
#[path = "module_obj_tests.rs"]
mod tests;
include!("module_obj_parts/001.rs");
include!("module_obj_parts/002.rs");
include!("module_obj_parts/003.rs");
