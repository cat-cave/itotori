//! Decoder for the observed `GE ` payload used by Softpal `.PGD` art.
//!
//! The two owned corpora contain method-2 backgrounds and method-3 character
//! sheets.  The decoder is deliberately narrow: JPEG, TGA, and `PGD3` delta
//! resources are named unsupported rather than guessed at.

#[derive(Clone, Debug)]
pub(crate) struct PgdImage {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: Vec<u8>,
}

pub(crate) fn decode_ge_pgd(bytes: &[u8]) -> Result<PgdImage, String> {
    if bytes.get(..3) != Some(b"GE ") {
        return Err("unsupported image signature (expected GE PGD)".to_string());
    }
    let mut width = usize::try_from(read_u32(bytes, 0x0c)?).map_err(|_| "width overflow")?;
    let mut height = usize::try_from(read_u32(bytes, 0x10)?).map_err(|_| "height overflow")?;
    let method = read_u16(bytes, 0x1c)?;
    let unpacked_len = usize::try_from(read_u32(bytes, 0x20)?).map_err(|_| "payload overflow")?;
    let unpacked = unpack(bytes, 0x28, unpacked_len)?;
    let rgba = match method {
        1 => planes_to_rgba(&unpacked)?,
        2 => yuv_like_to_rgba(&unpacked, width, height)?,
        3 => {
            let bpp = read_u16(&unpacked, 2)?;
            width = usize::from(read_u16(&unpacked, 4)?);
            height = usize::from(read_u16(&unpacked, 6)?);
            let pixel_size = match bpp {
                24 => 3,
                32 => 4,
                _ => return Err(format!("unsupported GE method-3 bpp {bpp}")),
            };
            bgra_to_rgba(
                &reconstruct_bgra(&unpacked, 8, width, height, pixel_size)?,
                pixel_size,
            )?
        }
        _ => return Err(format!("unsupported GE method {method}")),
    };
    let expected = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("decoded dimensions overflow")?;
    if rgba.len() != expected {
        return Err(format!(
            "decoded RGBA length {} does not equal {expected}",
            rgba.len()
        ));
    }
    Ok(PgdImage {
        width: width as u32,
        height: height as u32,
        rgba,
    })
}

fn unpack(bytes: &[u8], start: usize, output_len: usize) -> Result<Vec<u8>, String> {
    let mut output = vec![0; output_len];
    let mut cursor = Cursor::new(bytes, start);
    let mut destination = 0usize;
    let mut control = 2u16;
    while destination < output.len() {
        control >>= 1;
        if control == 1 {
            control = u16::from(cursor.byte()?) | 0x100;
        }
        let count = if control & 1 != 0 {
            let raw = usize::from(cursor.u16()?);
            let mut count = raw & 7;
            if raw & 8 == 0 {
                count = (count << 8) | usize::from(cursor.byte()?);
            }
            count += 4;
            let source = raw >> 4;
            if source == 0 || source > destination {
                return Err(format!(
                    "invalid GE back reference {source} at {destination}"
                ));
            }
            copy_overlap(&mut output, destination - source, destination, count)?;
            count
        } else {
            let count = usize::from(cursor.byte()?);
            let end = destination
                .checked_add(count)
                .ok_or("GE literal destination overflow")?;
            cursor.copy_into(
                output
                    .get_mut(destination..end)
                    .ok_or("GE literal out of bounds")?,
            )?;
            count
        };
        destination = destination
            .checked_add(count)
            .ok_or("GE destination overflow")?;
        if destination > output.len() {
            return Err("GE stream overruns declared output".to_string());
        }
    }
    Ok(output)
}

fn planes_to_rgba(input: &[u8]) -> Result<Vec<u8>, String> {
    if !input.len().is_multiple_of(4) {
        return Err("GE method-1 payload is not four planes".to_string());
    }
    let plane = input.len() / 4;
    let (alpha, rest) = input.split_at(plane);
    let (red, rest) = rest.split_at(plane);
    let (green, blue) = rest.split_at(plane);
    let mut output = Vec::with_capacity(input.len());
    for index in 0..plane {
        output.extend_from_slice(&[red[index], green[index], blue[index], alpha[index]]);
    }
    Ok(output)
}

fn yuv_like_to_rgba(input: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return Err("GE method-2 dimensions are not even".to_string());
    }
    let segment = width
        .checked_mul(height)
        .ok_or("GE method-2 dimensions overflow")?
        / 4;
    if input.len() < segment * 3 {
        return Err("GE method-2 payload is truncated".to_string());
    }
    let mut chroma_blue = 0usize;
    let mut chroma_red = segment;
    let mut luma = segment * 2;
    let mut output = vec![0; width * height * 4];
    for y in 0..height / 2 {
        for x in 0..width / 2 {
            let cb = input[chroma_blue] as i8 as i32;
            let cr = input[chroma_red] as i8 as i32;
            chroma_blue += 1;
            chroma_red += 1;
            for point in [0, 1, width, width + 1] {
                let luminance = i32::from(input[luma + point]) << 7;
                let pixel = ((y * 2 * width) + (x * 2) + point) * 4;
                output[pixel] = clamp((luminance + 179 * cr) >> 7);
                output[pixel + 1] = clamp((luminance - 43 * cb - 89 * cr) >> 7);
                output[pixel + 2] = clamp((luminance + 226 * cb) >> 7);
                output[pixel + 3] = 255;
            }
            luma += 2;
        }
        luma += width;
    }
    Ok(output)
}

fn reconstruct_bgra(
    input: &[u8],
    mut source: usize,
    width: usize,
    height: usize,
    pixel_size: usize,
) -> Result<Vec<u8>, String> {
    let stride = width
        .checked_mul(pixel_size)
        .ok_or("GE method-3 stride overflow")?;
    let mut output = vec![
        0;
        height
            .checked_mul(stride)
            .ok_or("GE method-3 image overflow")?
    ];
    let controls_end = source
        .checked_add(height)
        .ok_or("GE method-3 controls overflow")?;
    let controls = input
        .get(source..controls_end)
        .ok_or("GE method-3 controls truncated")?;
    source = source
        .checked_add(height)
        .ok_or("GE method-3 controls overflow")?;
    let mut destination = 0usize;
    for (row, &control) in controls.iter().enumerate() {
        if control & 1 != 0 {
            copy(input, source, &mut output, destination, pixel_size)?;
            source += pixel_size;
            let previous_start = destination;
            destination += pixel_size;
            for previous in previous_start..previous_start + (stride - pixel_size) {
                let delta = *input.get(source).ok_or("GE method-3 data truncated")?;
                output[destination] = output[previous].wrapping_sub(delta);
                source += 1;
                destination += 1;
            }
        } else if control & 2 != 0 {
            if row == 0 {
                return Err("GE method-3 first row references predecessor".to_string());
            }
            let previous_start = destination - stride;
            let previous_end = destination;
            for previous in previous_start..previous_end {
                let delta = *input.get(source).ok_or("GE method-3 data truncated")?;
                output[destination] = output[previous].wrapping_sub(delta);
                source += 1;
                destination += 1;
            }
        } else {
            copy(input, source, &mut output, destination, pixel_size)?;
            source += pixel_size;
            destination += pixel_size;
            if row == 0 {
                copy(input, source, &mut output, destination, stride - pixel_size)?;
                source += stride - pixel_size;
                destination += stride - pixel_size;
                continue;
            }
            let previous_start = destination - stride;
            let previous_end = destination - pixel_size;
            for previous in previous_start..previous_end {
                let delta = *input.get(source).ok_or("GE method-3 data truncated")?;
                output[destination] = ((u16::from(output[previous])
                    + u16::from(output[destination - pixel_size]))
                    / 2) as u8;
                output[destination] = output[destination].wrapping_sub(delta);
                source += 1;
                destination += 1;
            }
        }
    }
    Ok(output)
}

fn bgra_to_rgba(input: &[u8], pixel_size: usize) -> Result<Vec<u8>, String> {
    if !input.len().is_multiple_of(pixel_size) {
        return Err("GE method-3 has a partial pixel".to_string());
    }
    let mut output = Vec::with_capacity(input.len() / pixel_size * 4);
    for pixel in input.chunks_exact(pixel_size) {
        output.extend_from_slice(&[
            pixel[2],
            pixel[1],
            pixel[0],
            if pixel_size == 4 { pixel[3] } else { 255 },
        ]);
    }
    Ok(output)
}

fn copy(
    input: &[u8],
    source: usize,
    output: &mut [u8],
    destination: usize,
    count: usize,
) -> Result<(), String> {
    let source_end = source.checked_add(count).ok_or("GE source overflow")?;
    let destination_end = destination
        .checked_add(count)
        .ok_or("GE destination overflow")?;
    let from = input
        .get(source..source_end)
        .ok_or("GE source out of bounds")?;
    let to = output
        .get_mut(destination..destination_end)
        .ok_or("GE destination out of bounds")?;
    to.copy_from_slice(from);
    Ok(())
}

fn copy_overlap(
    output: &mut [u8],
    source: usize,
    destination: usize,
    count: usize,
) -> Result<(), String> {
    let end = destination
        .checked_add(count)
        .ok_or("GE overlap overflow")?;
    if end > output.len() {
        return Err("GE overlap out of bounds".to_string());
    }
    for offset in 0..count {
        output[destination + offset] = output[source + offset];
    }
    Ok(())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let raw = bytes.get(offset..offset + 2).ok_or("truncated u16")?;
    Ok(u16::from_le_bytes([raw[0], raw[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let raw = bytes.get(offset..offset + 4).ok_or("truncated u32")?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

fn clamp(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8], position: usize) -> Self {
        Self { bytes, position }
    }

    fn byte(&mut self) -> Result<u8, String> {
        let byte = *self.bytes.get(self.position).ok_or("GE input truncated")?;
        self.position += 1;
        Ok(byte)
    }

    fn u16(&mut self) -> Result<u16, String> {
        let value = read_u16(self.bytes, self.position)?;
        self.position += 2;
        Ok(value)
    }

    fn copy_into(&mut self, target: &mut [u8]) -> Result<(), String> {
        let end = self
            .position
            .checked_add(target.len())
            .ok_or("GE input overflow")?;
        target.copy_from_slice(
            self.bytes
                .get(self.position..end)
                .ok_or("GE input truncated")?,
        );
        self.position = end;
        Ok(())
    }
}
