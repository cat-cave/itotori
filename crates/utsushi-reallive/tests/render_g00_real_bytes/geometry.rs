pub(super) fn pixel_at(fb: &utsushi_reallive::Framebuffer, x: u32, y: u32) -> [u8; 4] {
    let stride = fb.width() as usize * 4;
    let off = (y as usize) * stride + (x as usize) * 4;
    let p = fb.pixels();
    [p[off], p[off + 1], p[off + 2], p[off + 3]]
}

/// True if any pixel inside the given rect differs from `colour`.
pub(super) fn rect_has_non_colour_pixel(
    fb: &utsushi_reallive::Framebuffer,
    x0: i32,
    y0: i32,
    w: u32,
    h: u32,
    colour: [u8; 4],
) -> bool {
    for dy in 0..h {
        for dx in 0..w {
            let x = x0 + dx as i32;
            let y = y0 + dy as i32;
            if x < 0 || y < 0 || x >= fb.width() as i32 || y >= fb.height() as i32 {
                continue;
            }
            if pixel_at(fb, x as u32, y as u32) != colour {
                return true;
            }
        }
    }
    false
}

/// Count DISTINCT RGBA pixel values inside the given rect (capped at a
/// small ceiling — we only need "more than one"). A single-colour solid
/// fill returns `1`; an edge-outline returns many.
pub(super) fn distinct_rect_colours(
    fb: &utsushi_reallive::Framebuffer,
    x0: i32,
    y0: i32,
    w: u32,
    h: u32,
) -> usize {
    let mut seen: std::collections::HashSet<[u8; 4]> = std::collections::HashSet::new();
    for dy in 0..h {
        for dx in 0..w {
            let x = x0 + dx as i32;
            let y = y0 + dy as i32;
            if x < 0 || y < 0 || x >= fb.width() as i32 || y >= fb.height() as i32 {
                continue;
            }
            seen.insert(pixel_at(fb, x as u32, y as u32));
            if seen.len() >= 8 {
                return seen.len();
            }
        }
    }
    seen.len()
}

/// True if the two framebuffers differ at any pixel inside the rect.
pub(super) fn rect_differs(
    a: &utsushi_reallive::Framebuffer,
    b: &utsushi_reallive::Framebuffer,
    x0: i32,
    y0: i32,
    w: u32,
    h: u32,
) -> bool {
    for dy in 0..h {
        for dx in 0..w {
            let x = x0 + dx as i32;
            let y = y0 + dy as i32;
            if x < 0 || y < 0 || x >= a.width() as i32 || y >= a.height() as i32 {
                continue;
            }
            if pixel_at(a, x as u32, y as u32) != pixel_at(b, x as u32, y as u32) {
                return true;
            }
        }
    }
    false
}
