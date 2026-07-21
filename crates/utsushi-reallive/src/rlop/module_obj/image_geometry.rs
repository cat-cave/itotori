//! Decoded g00 geometry hydration for file-backed graphics objects.

use super::{GraphicsRuntime, GraphicsRuntimeWarning};
use crate::g00::probe_g00_pattern_geometry;
use crate::graphics_objects::{GraphicsPosition, SurfaceGeometry};

impl GraphicsRuntime {
    /// Read selected g00 pattern geometry through the bound VFS.
    ///
    /// No bound package is an explicit geometry gap, not a synthesized rect.
    pub fn probe_g00_geometry_through_vfs(
        &self,
        asset_name: &str,
        pattern: u32,
        opcode_tag: &'static str,
    ) -> Result<Option<SurfaceGeometry>, GraphicsRuntimeWarning> {
        let package = {
            let guard = self.lock_inner();
            guard.asset_package.clone()
        };
        let Some(package) = package else {
            return Ok(None);
        };
        let logical = format!("g00/{asset_name}.g00");
        let id = package
            .resolve(&logical)
            .map_err(|err| Self::vfs_warning(asset_name, err).with_opcode(opcode_tag))?;
        let bytes = package
            .open(&id)
            .map_err(|err| Self::vfs_warning(asset_name, err).with_opcode(opcode_tag))?;
        let geometry = probe_g00_pattern_geometry(bytes.as_slice(), pattern).map_err(|err| {
            GraphicsRuntimeWarning::G00DecodeFailure {
                opcode_tag,
                asset_key: asset_name.to_string(),
                reason: err.to_string(),
            }
        })?;
        Ok(Some(SurfaceGeometry {
            width: i32::try_from(geometry.width).expect("g00 width fits i32"),
            height: i32::try_from(geometry.height).expect("g00 height fits i32"),
            origin: GraphicsPosition {
                x: geometry.origin_x,
                y: geometry.origin_y,
            },
        }))
    }
}
