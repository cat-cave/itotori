//! Copyright-safe g00 edge-map redaction, nearest-neighbour scale, and
//! signed-thousandths colour-tone compositing helpers, moved verbatim
//! out of the render-pipeline root module.

use crate::graphics_objects::{GraphicsColourTone, WipeColour};

use super::RGBA_BYTES_PER_PIXEL;

/// Build a copyright-safe, non-reconstructable redaction of a decoded
/// g00 image: a monochrome EDGE-OUTLINE (the scene's structure/layout)
/// over a dark base, honouring each source pixel's alpha so the object's
/// SILHOUETTE is preserved while its colour, tone, and texture are
/// discarded. The output is a derived line-drawing — it shares no
/// verbatim run with the source pixel buffer — so a public frame built
/// from it shows the scene's LAYOUT for proof value without republishing
/// any decoded art. Replaces the old opaque solid-marker fill, which
/// painted a solid block over the whole image and showed nothing.
pub(super) fn redact_edge_map(pixels_rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    // Dark base + light edge; both obviously-synthetic redaction colours.
    const BASE: [i32; 3] = [0x12, 0x10, 0x1A];
    const EDGE: [i32; 3] = [0x9A, 0xA6, 0xC0];
    const THRESHOLD: i32 = 22;
    let w = width as usize;
    let h = height as usize;
    // Rec.601-ish luminance, fixed-point (>>8).
    let luminance = |x: usize, y: usize| -> i32 {
        let idx = (y * w + x) * RGBA_BYTES_PER_PIXEL;
        let r = pixels_rgba[idx] as i32;
        let g = pixels_rgba[idx + 1] as i32;
        let b = pixels_rgba[idx + 2] as i32;
        (r * 54 + g * 183 + b * 19) >> 8
    };
    let mut out = vec![0u8; pixels_rgba.len()];
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) * RGBA_BYTES_PER_PIXEL;
            let alpha = pixels_rgba[idx + 3];
            let x_minus = x.saturating_sub(1);
            let x_plus = (x + 1).min(w - 1);
            let y_minus = y.saturating_sub(1);
            let y_plus = (y + 1).min(h - 1);
            let gradient = (luminance(x_plus, y) - luminance(x_minus, y)).abs()
                + (luminance(x, y_plus) - luminance(x, y_minus)).abs();
            let rgb = if gradient > THRESHOLD {
                // Brighten the edge with the gradient strength.
                let strength = (gradient - THRESHOLD).clamp(0, 255);
                let mix =
                    |base: i32, edge: i32| -> u8 { (base + (edge - base) * strength / 255) as u8 };
                [
                    mix(BASE[0], EDGE[0]),
                    mix(BASE[1], EDGE[1]),
                    mix(BASE[2], EDGE[2]),
                ]
            } else {
                [BASE[0] as u8, BASE[1] as u8, BASE[2] as u8]
            };
            out[idx] = rgb[0];
            out[idx + 1] = rgb[1];
            out[idx + 2] = rgb[2];
            out[idx + 3] = alpha;
        }
    }
    out
}

/// Scale `dimension` (pixels) by `thousandths` (`1000` = identity)
/// rounding to nearest. Negative or zero scale collapses the extent to
/// `0` (the object contributes no pixels); axis mirroring is out of
/// scope for the headless rasteriser.
pub(super) fn scale_dimension(dimension: u32, thousandths: i32) -> u32 {
    if thousandths <= 0 {
        return 0;
    }
    (((dimension as u64) * (thousandths as u64) + 500) / 1000) as u32
}

/// Apply a signed-thousandths colour tone to a [`WipeColour`]'s RGB
/// channels (alpha is untouched).
pub(super) fn apply_tone(colour: WipeColour, tone: GraphicsColourTone) -> WipeColour {
    let [r, g, b, a] = apply_tone_rgba([colour.red, colour.green, colour.blue, colour.alpha], tone);
    WipeColour {
        red: r,
        green: g,
        blue: b,
        alpha: a,
    }
}

/// Apply a signed-thousandths colour tone to an RGBA pixel:
/// `channel_out = clamp(channel + tone_thousandths * 255 / 1000)`. The
/// alpha channel is passed through untouched. A [`GraphicsColourTone::NEUTRAL`]
/// tone is the identity transform.
pub(super) fn apply_tone_rgba(
    pixel: [u8; RGBA_BYTES_PER_PIXEL],
    tone: GraphicsColourTone,
) -> [u8; RGBA_BYTES_PER_PIXEL] {
    let shift = |channel: u8, thousandths: i32| -> u8 {
        if thousandths == 0 {
            return channel;
        }
        let delta = (thousandths * 255) / 1000;
        (channel as i32 + delta).clamp(0, 255) as u8
    };
    [
        shift(pixel[0], tone.red_thousandths),
        shift(pixel[1], tone.green_thousandths),
        shift(pixel[2], tone.blue_thousandths),
        pixel[3],
    ]
}
