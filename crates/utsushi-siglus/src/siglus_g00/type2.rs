use super::*;

pub(super) fn decode_type2(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<SiglusG00Image, SiglusG00Error> {
    let layer_count = read_u32(input, HEADER_LEN)? as usize;
    if layer_count == 0 {
        return Err(SiglusG00Error::InvalidSection {
            detail: "type-2 layer count is zero",
        });
    }
    if layer_count > MAX_LAYER_COUNT {
        return Err(SiglusG00Error::InvalidSection {
            detail: "type-2 layer count exceeds decoder limit",
        });
    }
    let records_end = HEADER_LEN
        .checked_add(4)
        .and_then(|offset| offset.checked_add(layer_count.checked_mul(LAYER_RECORD_LEN)?))
        .ok_or(SiglusG00Error::InvalidSection {
            detail: "type-2 layer table overflows",
        })?;
    if input.len() < records_end {
        return Err(SiglusG00Error::TruncatedHeader {
            required: records_end,
            observed: input.len(),
        });
    }
    let mut layers = (0..layer_count)
        .map(|index| read_layer(input, HEADER_LEN + 4 + index * LAYER_RECORD_LEN))
        .collect::<Result<Vec<_>, _>>()?;
    let mut canvas_height = height as usize;
    stack_identical_layers(&mut layers, height, &mut canvas_height);
    let decoded = decode_lzss_section(input, records_end, LzssFlavor::Bytes)?;
    let canvas_height =
        u32::try_from(canvas_height).map_err(|_| SiglusG00Error::DecodedSizeExceedsLimit {
            declared: usize::MAX,
        })?;
    let canvas_bytes = checked_canvas_len(width, canvas_height, 4)?;
    let mut pixels_rgba = vec![0; canvas_bytes];
    let listed_layers = read_u32(&decoded, 0)? as usize;
    let table_end =
        4usize
            .checked_add(listed_layers.checked_mul(8).ok_or(
                SiglusG00Error::InvalidLayerPayload {
                    detail: "layer offset table overflows",
                },
            )?)
            .ok_or(SiglusG00Error::InvalidLayerPayload {
                detail: "layer offset table overflows",
            })?;
    if table_end > decoded.len() {
        return Err(SiglusG00Error::InvalidLayerPayload {
            detail: "layer offset table is truncated",
        });
    }
    for (index, layer) in layers.iter().enumerate().take(listed_layers) {
        let entry = 4 + index * 8;
        let start = read_u32(&decoded, entry)? as usize;
        let length = read_u32(&decoded, entry + 4)? as usize;
        blit_layer(
            &decoded,
            start,
            length,
            *layer,
            width as usize,
            canvas_height as usize,
            &mut pixels_rgba,
        )?;
    }
    Ok(SiglusG00Image {
        kind: SiglusG00Kind::LayeredBgra,
        width,
        height: canvas_height,
        pixels_rgba,
        layers,
    })
}

fn read_layer(input: &[u8], offset: usize) -> Result<SiglusG00Layer, SiglusG00Error> {
    Ok(SiglusG00Layer {
        x1: read_i32(input, offset)?,
        y1: read_i32(input, offset + 4)?,
        x2: read_i32(input, offset + 8)?,
        y2: read_i32(input, offset + 12)?,
        origin_x: read_i32(input, offset + 16)?,
        origin_y: read_i32(input, offset + 20)?,
    })
}

fn stack_identical_layers(layers: &mut [SiglusG00Layer], height: u32, canvas_height: &mut usize) {
    let Some(first) = layers.first().copied() else {
        return;
    };
    let identical = layers.len() > 1
        && first.width() > 0
        && first.height() > 0
        && layers.iter().all(|layer| {
            layer.x1 == first.x1
                && layer.y1 == first.y1
                && layer.x2 == first.x2
                && layer.y2 == first.y2
                && layer.origin_x == first.origin_x
        });
    if identical {
        for (index, layer) in layers.iter_mut().enumerate() {
            let y_offset = (index as i32).saturating_mul(height as i32);
            layer.y1 = layer.y1.saturating_add(y_offset);
            layer.y2 = layer.y2.saturating_add(y_offset);
        }
        *canvas_height = (height as usize).saturating_mul(layers.len());
    }
}

pub(super) fn lzss_section(input: &[u8], offset: usize) -> Result<&[u8], SiglusG00Error> {
    let compressed_size = read_u32(input, offset)? as usize;
    if compressed_size < 8 {
        return Err(SiglusG00Error::InvalidSection {
            detail: "compressed section is shorter than its header",
        });
    }
    let end = offset
        .checked_add(compressed_size)
        .ok_or(SiglusG00Error::InvalidSection {
            detail: "compressed section overflows",
        })?;
    if end > input.len() {
        return Err(SiglusG00Error::TruncatedHeader {
            required: end,
            observed: input.len(),
        });
    }
    Ok(&input[offset + 8..end])
}

fn decode_lzss_section(
    input: &[u8],
    offset: usize,
    flavor: LzssFlavor,
) -> Result<Vec<u8>, SiglusG00Error> {
    let declared = read_u32(input, offset + 4)? as usize;
    if declared > MAX_DECODED_BYTES {
        return Err(SiglusG00Error::DecodedSizeExceedsLimit { declared });
    }
    decode_lzss(lzss_section(input, offset)?, declared, flavor).map_err(lzss_error)
}

pub(super) fn lzss_error(error: lzss::LzssError) -> SiglusG00Error {
    let detail = match error {
        lzss::LzssError::Truncated => "stream ended before the declared output was complete",
        lzss::LzssError::InvalidBackReference => {
            "back-reference distance is outside decoded output"
        }
    };
    SiglusG00Error::Lzss { detail }
}

fn blit_layer(
    data: &[u8],
    start: usize,
    length: usize,
    layer: SiglusG00Layer,
    canvas_width: usize,
    canvas_height: usize,
    target: &mut [u8],
) -> Result<(), SiglusG00Error> {
    let end = start
        .checked_add(length)
        .ok_or(SiglusG00Error::InvalidLayerPayload {
            detail: "layer range overflows",
        })?;
    if end > data.len()
        || start
            .checked_add(TYPE2_BLOCK_HEADER_LEN)
            .is_none_or(|value| value > end)
    {
        return Err(SiglusG00Error::InvalidLayerPayload {
            detail: "layer block is truncated",
        });
    }
    let mut source = start + TYPE2_BLOCK_HEADER_LEN;
    while source < end {
        let header_end = source.checked_add(TYPE2_TILE_HEADER_LEN).ok_or(
            SiglusG00Error::InvalidLayerPayload {
                detail: "tile header overflows",
            },
        )?;
        if header_end > end {
            return Err(SiglusG00Error::InvalidLayerPayload {
                detail: "tile header is truncated",
            });
        }
        let x = read_u16(data, source)? as i32 + layer.x1;
        let y = read_u16(data, source + 2)? as i32 + layer.y1;
        let width = read_u16(data, source + 6)? as usize;
        let height = read_u16(data, source + 8)? as usize;
        let bytes = width
            .checked_mul(height)
            .and_then(|count| count.checked_mul(4))
            .ok_or(SiglusG00Error::InvalidLayerPayload {
                detail: "tile pixel size overflows",
            })?;
        let pixels_end =
            header_end
                .checked_add(bytes)
                .ok_or(SiglusG00Error::InvalidLayerPayload {
                    detail: "tile pixel range overflows",
                })?;
        if pixels_end > end {
            return Err(SiglusG00Error::InvalidLayerPayload {
                detail: "tile pixels are truncated",
            });
        }
        for row in 0..height {
            for column in 0..width {
                let destination_x = x.saturating_add(column as i32);
                let destination_y = y.saturating_add(row as i32);
                if destination_x < 0
                    || destination_y < 0
                    || destination_x as usize >= canvas_width
                    || destination_y as usize >= canvas_height
                {
                    continue;
                }
                let source_offset = header_end + (row * width + column) * 4;
                let destination_offset =
                    ((destination_y as usize * canvas_width) + destination_x as usize) * 4;
                source_over_bgra(
                    &data[source_offset..source_offset + 4],
                    &mut target[destination_offset..destination_offset + 4],
                );
            }
        }
        source = pixels_end;
    }
    Ok(())
}

fn source_over_bgra(source: &[u8], destination: &mut [u8]) {
    let alpha = source[3] as u32;
    if alpha == 0 {
        return;
    }
    if alpha == 255 {
        destination.copy_from_slice(&[source[2], source[1], source[0], 255]);
        return;
    }
    let destination_alpha = destination[3] as u32;
    let output_alpha = alpha + (destination_alpha * (255 - alpha) + 127) / 255;
    for (out, src) in destination[..3]
        .iter_mut()
        .zip([source[2], source[1], source[0]])
    {
        let numerator = src as u32 * alpha * 255 + *out as u32 * destination_alpha * (255 - alpha);
        *out = (numerator / (output_alpha * 255)).min(255) as u8;
    }
    destination[3] = output_alpha as u8;
}
