use super::*;

#[path = "render_pass/api.rs"]
mod api;

impl RenderPass {
    fn paint_object(
        &self,
        framebuffer: &mut Framebuffer,
        object: &GraphicsObject,
        plane: GraphicsPlane,
        slot: usize,
        policy: RedactionPolicy,
        report: &mut RenderReport,
    ) {
        match &object.kind {
            GraphicsObjectKind::Wipe { colour } => {
                // A wipe is a full-screen clear. Its recorded colour tone
                // and object-level alpha are applied uniformly with every
                // other object: a neutral-tone opaque wipe fills verbatim.
                let toned = apply_tone(*colour, object.colour_tone);
                framebuffer.fill_blended(toned, object.alpha.0);
            }
            GraphicsObjectKind::Image { image_ref } => {
                self.paint_image(
                    framebuffer,
                    object,
                    &image_ref.asset_key,
                    plane,
                    slot,
                    policy,
                    report,
                );
            }
        }
    }

    /// Record (and log, under [`RENDER_PIPELINE_OBJECT_SKIPPED_CODE`]) a
    /// fail-soft skip: an image object that contributed no pixels. The
    /// compositor keeps going, but the skip is NEVER silent.
    fn record_skip(
        report: &mut RenderReport,
        asset_key: &str,
        plane: GraphicsPlane,
        slot: usize,
        reason: SkipReason,
    ) {
        // No `tracing`/`log` dependency in this crate; the established
        // diagnostic channel here (see `bytecode_element`) is stderr. The
        // stable code prefix makes the line audit-greppable.
        eprintln!(
            "{RENDER_PIPELINE_OBJECT_SKIPPED_CODE}: asset_key={asset_key} \
             plane={plane:?} slot={slot} reason={reason:?}"
        );
        report.skipped_objects.push(SkippedObject {
            asset_key: asset_key.to_string(),
            plane,
            slot,
            reason,
        });
    }

    /// Dereference an image object's `asset_key` through the bound asset
    /// package, decode the g00 bytes, and composite the decoded bitmap
    /// into `framebuffer` at the object's position, applying its scale
    /// (nearest-neighbour resample), colour tone, and alpha. Under
    /// [`RedactionPolicy::Redact`] the same destination rect carries a
    /// copyright-safe edge-outline of the decoded pixels (see
    /// [`redact_edge_map`]) instead of the art itself, so the emitted
    /// frame publishes the scene's layout without its pixels. If no asset
    /// package is
    /// bound, or resolution / decoding fails, the object contributes no
    /// pixels — a fail-soft gap, never a panic. Every such gap is RECORDED
    /// on `report` (and logged) via [`Self::record_skip`] so the dropped
    /// object surfaces on the render result instead of a frame silently
    /// looking complete when it is not.
    // reason: cohesive paint step over distinct blit/render inputs; a params struct would add indirection without clarity.
    #[allow(clippy::too_many_arguments)]
    fn paint_image(
        &self,
        framebuffer: &mut Framebuffer,
        object: &GraphicsObject,
        asset_key: &str,
        plane: GraphicsPlane,
        slot: usize,
        policy: RedactionPolicy,
        report: &mut RenderReport,
    ) {
        let Some(assets) = self.assets.as_ref() else {
            Self::record_skip(report, asset_key, plane, slot, SkipReason::NoAssetPackage);
            return;
        };
        let logical = format!("g00/{asset_key}.g00");
        let asset_id = match assets.resolve(&logical) {
            Ok(asset_id) => asset_id,
            Err(error) => {
                Self::record_skip(
                    report,
                    asset_key,
                    plane,
                    slot,
                    SkipReason::ResolveFailed {
                        logical,
                        error: error.to_string(),
                    },
                );
                return;
            }
        };
        let bytes = match assets.open(&asset_id) {
            Ok(bytes) => bytes,
            Err(error) => {
                Self::record_skip(
                    report,
                    asset_key,
                    plane,
                    slot,
                    SkipReason::OpenFailed {
                        logical,
                        error: error.to_string(),
                    },
                );
                return;
            }
        };
        // LIVE decode of the real g00 bytes into an RGBA canvas. The
        // decoder's non-fatal warnings (short-payload zero-extension) are
        // surfaced on the report; a hard decode error records a
        // DecodeFailed skip (the fail-soft continues rendering the rest of
        // the stack) rather than silently dropping the object.
        let (image, warnings) = match decode_g00(bytes.as_slice()) {
            Ok(decoded) => decoded,
            Err(error) => {
                Self::record_skip(
                    report,
                    asset_key,
                    plane,
                    slot,
                    SkipReason::DecodeFailed {
                        error: error.to_string(),
                    },
                );
                return;
            }
        };
        for warning in warnings {
            report.warnings.push(ObjectWarning {
                asset_key: asset_key.to_string(),
                warning,
            });
        }
        let src_w = image.width;
        let src_h = image.height;
        if src_w == 0 || src_h == 0 {
            Self::record_skip(
                report,
                asset_key,
                plane,
                slot,
                SkipReason::ZeroDims {
                    src_w,
                    src_h,
                    dst_w: 0,
                    dst_h: 0,
                },
            );
            return;
        }
        let dst_w = scale_dimension(src_w, object.scale.x_thousandths);
        let dst_h = scale_dimension(src_h, object.scale.y_thousandths);
        if dst_w == 0 || dst_h == 0 {
            Self::record_skip(
                report,
                asset_key,
                plane,
                slot,
                SkipReason::ZeroDims {
                    src_w,
                    src_h,
                    dst_w,
                    dst_h,
                },
            );
            return;
        }
        // Select the source-space RGBA buffer the blit samples from.
        //
        // - `Full` composites the REAL decoded g00 (with the object's
        //   colour tone) — the private, full-fidelity buffer.
        // - `Redact` composites a copyright-safe EDGE-OUTLINE of the g00
        //   ([`redact_edge_map`]): the scene's structure/layout survives
        //   for proof value while colour, tone, and texture are discarded
        //   and no verbatim decoded run is republished. This REPLACES the
        //   old solid-marker fill, which painted over the whole frame and
        //   showed nothing.
        let redacted = match policy {
            RedactionPolicy::Full => None,
            RedactionPolicy::Redact => Some(redact_edge_map(&image.pixels_rgba, src_w, src_h)),
        };
        let source_pixels: &[u8] = match &redacted {
            Some(edges) => edges,
            None => &image.pixels_rgba,
        };
        let src_stride = (src_w as usize) * RGBA_BYTES_PER_PIXEL;
        for dy in 0..dst_h {
            // `object.position` comes from VM state and can be arbitrary;
            // saturating_add keeps a corrupt/out-of-range position from
            // overflowing i32 — a saturated coordinate falls outside the
            // framebuffer and is skipped by the bounds check below.
            let py = object.position.y.saturating_add(dy as i32);
            if py < 0 || py >= framebuffer.height as i32 {
                continue;
            }
            // Nearest-neighbour source row.
            let sy = ((dy as u64 * src_h as u64) / dst_h as u64) as u32;
            for dx in 0..dst_w {
                let px = object.position.x.saturating_add(dx as i32);
                if px < 0 || px >= framebuffer.width as i32 {
                    continue;
                }
                let sx = ((dx as u64 * src_w as u64) / dst_w as u64) as u32;
                let sidx = (sy as usize) * src_stride + (sx as usize) * RGBA_BYTES_PER_PIXEL;
                let sample = [
                    source_pixels[sidx],
                    source_pixels[sidx + 1],
                    source_pixels[sidx + 2],
                    source_pixels[sidx + 3],
                ];
                // The object's colour tone applies to the real art only;
                // the synthetic edge-outline carries no source tone.
                let src = match policy {
                    RedactionPolicy::Full => apply_tone_rgba(sample, object.colour_tone),
                    RedactionPolicy::Redact => sample,
                };
                framebuffer.blend_pixel(px as u32, py as u32, src, object.alpha.0);
            }
        }
    }
}
