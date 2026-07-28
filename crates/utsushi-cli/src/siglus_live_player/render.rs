use super::RenderedBoundary;
use kaifuu_siglus::GameexeDatEntry;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::path::Path;
use utsushi_reallive::{Framebuffer, TextLayer, WipeColour};
use utsushi_siglus::scene_vm::{Moment, StageSnapshot};
use utsushi_siglus::{
    SiglusCgFrame, SiglusG00Image, SiglusG00Kind, SiglusStageRenderError, decode_siglus_g00,
    encode_siglus_png, render_siglus_cg, render_siglus_stage,
};

/// The Gameexe-driven portion of the Siglus message-window projection.
///
/// Stage `MWND` commands can alter this during a full VM run.  The executable
/// slice currently captures the authored text/choice boundary and the root
/// stage, but not those UI mutations, so this is the decoded `MWND.000`
/// template the reference starts from.  We deliberately draw no made-up waku
/// image: absent an executed, resolvable waku object, only actual text is
/// composited over the real stage frame.
#[derive(Debug, Clone, Copy)]
pub(super) struct MessageWindowProjection {
    virtual_size: Option<(u32, u32)>,
    window_pos: (i32, i32),
    window_size: (u32, u32),
    message_pos: (i32, i32),
    message_margin: (i32, i32, i32, i32),
    moji_count: Option<(usize, usize)>,
    pub(super) moji_size: u32,
    moji_space: (i32, i32),
    extend_type: i32,
}

impl Default for MessageWindowProjection {
    fn default() -> Self {
        // These are the reference runtime's documented MwndTemplate defaults;
        // they apply only when the decoded Gameexe omits the corresponding
        // template field.
        Self {
            virtual_size: None,
            window_pos: (50, 400),
            window_size: (700, 150),
            message_pos: (20, 20),
            message_margin: (20, 20, 20, 20),
            moji_count: Some((26, 3)),
            moji_size: 25,
            moji_space: (-1, 10),
            extend_type: 0,
        }
    }
}

impl MessageWindowProjection {
    pub(super) fn from_gameexe(entries: &[GameexeDatEntry]) -> Self {
        let mut projection = Self::default();
        let entries = entries
            .iter()
            .map(|entry| (entry.key.to_ascii_uppercase(), entry.value.as_str()))
            .collect::<BTreeMap<_, _>>();
        let get = |key: &str| entries.get(key).copied();
        projection.virtual_size = get("SCREEN_SIZE")
            .and_then(parse_pair)
            .and_then(to_positive_pair)
            .or_else(|| {
                get("WINDOW_SIZE")
                    .and_then(parse_pair)
                    .and_then(to_positive_pair)
            });
        if let Some(value) = get("MWND.000.WINDOW_POS").and_then(parse_pair) {
            projection.window_pos = value;
        }
        if let Some(value) = get("MWND.000.WINDOW_SIZE")
            .and_then(parse_pair)
            .and_then(to_positive_pair)
        {
            projection.window_size = value;
        }
        if let Some(value) = get("MWND.000.MESSAGE_POS").and_then(parse_pair) {
            projection.message_pos = value;
        }
        if let Some(value) = get("MWND.000.MESSAGE_MARGIN").and_then(parse_quad) {
            projection.message_margin = value;
        }
        if let Some((columns, rows)) = get("MWND.000.MOJI_CNT").and_then(parse_pair) {
            projection.moji_count =
                (columns > 0 && rows > 0).then(|| (columns as usize, rows as usize));
        }
        if let Some(size) = get("MWND.000.MOJI_SIZE").and_then(parse_integer) {
            if size > 0 {
                projection.moji_size = size as u32;
            }
        }
        if let Some(value) = get("MWND.000.MOJI_SPACE").and_then(parse_pair) {
            projection.moji_space = value;
        }
        if let Some(value) = get("MWND.000.EXTEND_TYPE").and_then(parse_integer) {
            projection.extend_type = value;
        }
        projection
    }

    fn scale_x(self, frame_width: u32) -> f32 {
        frame_width as f32 / self.virtual_size.map_or(frame_width, |size| size.0).max(1) as f32
    }

    fn scale_y(self, frame_height: u32) -> f32 {
        frame_height as f32 / self.virtual_size.map_or(frame_height, |size| size.1).max(1) as f32
    }

    fn scale_x_value(self, value: i32, frame_width: u32) -> u32 {
        (value.max(0) as f32 * self.scale_x(frame_width)).round() as u32
    }

    fn scale_y_value(self, value: i32, frame_height: u32) -> u32 {
        (value.max(0) as f32 * self.scale_y(frame_height)).round() as u32
    }

    pub(super) fn message_rect(self, frame_width: u32, frame_height: u32) -> (u32, u32, u32, u32) {
        let x = self.scale_x_value(self.window_pos.0, frame_width);
        let y = self.scale_y_value(self.window_pos.1, frame_height);
        let width = self
            .scale_x_value(self.window_size.0 as i32, frame_width)
            .max(1);
        let height = self
            .scale_y_value(self.window_size.1 as i32, frame_height)
            .max(1);
        if self.extend_type == 1 {
            let (left, top, right, bottom) = self.message_margin;
            let origin_x = x.saturating_add(self.scale_x_value(left, frame_width));
            let origin_y = y.saturating_add(self.scale_y_value(top, frame_height));
            return (
                origin_x,
                origin_y,
                width
                    .saturating_sub(self.scale_x_value(left.saturating_add(right), frame_width))
                    .max(1),
                height
                    .saturating_sub(self.scale_y_value(top.saturating_add(bottom), frame_height))
                    .max(1),
            );
        }
        let origin_x = x.saturating_add(self.scale_x_value(self.message_pos.0, frame_width));
        let origin_y = y.saturating_add(self.scale_y_value(self.message_pos.1, frame_height));
        let (text_width, text_height) = self.moji_count.map_or_else(
            || {
                let (_, _, right, bottom) = self.message_margin;
                (
                    x.saturating_add(width)
                        .saturating_sub(origin_x)
                        .saturating_sub(self.scale_x_value(right, frame_width))
                        .max(1),
                    y.saturating_add(height)
                        .saturating_sub(origin_y)
                        .saturating_sub(self.scale_y_value(bottom, frame_height))
                        .max(1),
                )
            },
            |(columns, rows)| {
                let horizontal = self.moji_size as i32 * columns as i32
                    + self.moji_space.0 * columns.saturating_sub(1) as i32;
                let vertical = self.moji_size as i32 * rows as i32
                    + self.moji_space.1 * rows.saturating_sub(1) as i32;
                (
                    self.scale_x_value(horizontal.max(1), frame_width),
                    self.scale_y_value(vertical.max(self.moji_size as i32), frame_height),
                )
            },
        );
        (origin_x, origin_y, text_width, text_height)
    }
}

pub(super) fn render_boundaries(
    root: &Path,
    artifact_root: &Path,
    run_id: &str,
    message_window: MessageWindowProjection,
    snapshots: Vec<StageSnapshot>,
) -> Result<Vec<RenderedBoundary>, Box<dyn Error>> {
    let private_root = artifact_root
        .with_extension("private-siglus-live-player")
        .join(run_id);
    let public_root = artifact_root.join("siglus-live-player").join(run_id);
    std::fs::create_dir_all(&private_root)?;
    std::fs::create_dir_all(&public_root)?;
    let mut cache = HashMap::new();
    let mut boundaries = Vec::new();
    for snapshot in snapshots {
        let mut frame = match render_siglus_stage(&snapshot.state.stage_objects, |identity| {
            load_g00(root, identity, &mut cache)
        }) {
            Ok(frame) => frame,
            Err(SiglusStageRenderError::NoVisibleObjects) => continue,
            Err(error) => return Err(error.into()),
        };
        composite_message_window(&mut frame, &snapshot.moment, message_window)?;
        let public = redact_frame(&frame)?;
        let private_png = encode_siglus_png(&frame)?;
        let public_png = encode_siglus_png(&public)?;
        let index = boundaries.len();
        let private_path = private_root.join(format!("frame-{index:04}.png"));
        let public_path = public_root.join(format!("frame-{index:04}.png"));
        std::fs::write(&private_path, &private_png)?;
        std::fs::write(&public_path, &public_png)?;
        boundaries.push(RenderedBoundary {
            snapshot,
            private_path,
            public_path,
            private_sha256: sha256(&private_png),
            public_sha256: sha256(&public_png),
            width: frame.width,
            height: frame.height,
            non_background_pixels: non_background_pixel_count(&frame),
        });
    }
    Ok(boundaries)
}

pub(super) fn load_g00(
    root: &Path,
    identity: &str,
    cache: &mut HashMap<String, SiglusG00Image>,
) -> Result<SiglusG00Image, String> {
    if let Some(image) = cache.get(identity) {
        return Ok(image.clone());
    }
    let name = if identity.to_ascii_lowercase().ends_with(".g00") {
        identity.to_string()
    } else {
        format!("{identity}.g00")
    };
    let path = crate::render_validate_g00::g00_path(&root.join("g00"), &name);
    let bytes = std::fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let image = decode_siglus_g00(&bytes).map_err(|error| error.to_string())?;
    cache.insert(identity.to_string(), image.clone());
    Ok(image)
}

/// Composite the exact text or choice labels emitted at this VM boundary.
///
/// The stage frame remains untouched except where the embedded Japanese-capable
/// rasteriser paints decoded characters.  In particular, this does not invent
/// a message-window skin: the `MWND.WAKU` graphics path is not yet part of the
/// executed root-stage state, so drawing one would be a fabricated layer.
pub(super) fn composite_message_window(
    frame: &mut SiglusCgFrame,
    moment: &Moment,
    projection: MessageWindowProjection,
) -> Result<(), Box<dyn Error>> {
    let (origin_x, origin_y, _text_width, _text_height) =
        projection.message_rect(frame.width, frame.height);
    let scale = (projection.moji_size as f32 * projection.scale_y(frame.height))
        .round()
        .max(1.0) as u32;
    let line_height = ((projection.moji_size as i32 + projection.moji_space.1).max(1) as f32
        * projection.scale_y(frame.height))
    .round()
    .max(scale as f32) as u32;
    let lines = match moment {
        Moment::Text { text, .. } => {
            wrap_message_text(text, projection.moji_count.map(|count| count.0))
        }
        Moment::Choice { options, .. } => options
            .iter()
            .enumerate()
            .flat_map(|(index, option)| {
                let prefix = if index == 0 { "> " } else { "  " };
                wrap_message_text(option, projection.moji_count.map(|count| count.0))
                    .into_iter()
                    .enumerate()
                    .map(move |(line, text)| {
                        if line == 0 {
                            format!("{prefix}{text}")
                        } else {
                            format!("  {text}")
                        }
                    })
            })
            .collect(),
    };
    if lines.iter().all(|line: &String| line.is_empty()) {
        return Err("siglus-live-player reached an empty authored message boundary".into());
    }
    let mut text_surface = Framebuffer::new(frame.width, frame.height);
    let painted = text_surface.draw_text(&TextLayer {
        lines,
        origin_x,
        origin_y,
        scale,
        colour: WipeColour::WHITE,
        backdrop: None,
        name_box: None,
        line_height: Some(line_height),
    });
    if painted == 0 {
        return Err("siglus-live-player decoded message text painted zero pixels".into());
    }
    source_over_frame(&mut frame.pixels_rgba, text_surface.pixels())?;
    Ok(())
}

/// Wrap with the reference `MOJI_CNT` cell count.  The glyph rasteriser still
/// owns glyph shape; this only preserves the authored character order at the
/// text-area's decoded column boundary.
fn wrap_message_text(text: &str, column_count: Option<usize>) -> Vec<String> {
    let Some(column_count) = column_count.filter(|count| *count > 0) else {
        return text.split('\n').map(ToOwned::to_owned).collect();
    };
    let mut lines = vec![String::new()];
    let mut columns = 0usize;
    for character in text.chars() {
        if character == '\n' {
            lines.push(String::new());
            columns = 0;
            continue;
        }
        let width =
            usize::from(!(character.is_ascii() || matches!(character as u32, 0xff61..=0xff9f))) + 1;
        if columns > 0 && columns + width > column_count {
            lines.push(String::new());
            columns = 0;
        }
        lines
            .last_mut()
            .expect("message lines is never empty")
            .push(character);
        columns += width;
    }
    lines
}

fn source_over_frame(destination: &mut [u8], source: &[u8]) -> Result<(), Box<dyn Error>> {
    if destination.len() != source.len() || destination.len() % 4 != 0 {
        return Err("siglus-live-player text surface dimensions disagreed with stage frame".into());
    }
    for (destination, source) in destination.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
        let source_alpha = u32::from(source[3]);
        if source_alpha == 0 {
            continue;
        }
        let destination_alpha = u32::from(destination[3]);
        let output_alpha = source_alpha + (destination_alpha * (255 - source_alpha) + 127) / 255;
        for channel in 0..3 {
            let numerator = u32::from(source[channel]) * source_alpha * 255
                + u32::from(destination[channel]) * destination_alpha * (255 - source_alpha);
            destination[channel] = (numerator / (output_alpha * 255)).min(255) as u8;
        }
        destination[3] = output_alpha as u8;
    }
    Ok(())
}

fn parse_integer(value: &str) -> Option<i32> {
    value.trim().trim_matches('"').parse().ok()
}

fn parse_pair(value: &str) -> Option<(i32, i32)> {
    let values = value
        .trim()
        .trim_matches('"')
        .split(',')
        .map(str::trim)
        .map(str::parse::<i32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (values.len() >= 2).then_some((values[0], values[1]))
}

fn parse_quad(value: &str) -> Option<(i32, i32, i32, i32)> {
    let values = value
        .trim()
        .trim_matches('"')
        .split(',')
        .map(str::trim)
        .map(str::parse::<i32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (values.len() >= 4).then_some((values[0], values[1], values[2], values[3]))
}

fn to_positive_pair(value: (i32, i32)) -> Option<(u32, u32)> {
    (value.0 > 0 && value.1 > 0).then_some((value.0 as u32, value.1 as u32))
}

fn redact_frame(frame: &SiglusCgFrame) -> Result<SiglusCgFrame, Box<dyn Error>> {
    let image = SiglusG00Image {
        kind: SiglusG00Kind::RawBgr,
        width: frame.width,
        height: frame.height,
        pixels_rgba: frame.pixels_rgba.clone(),
        layers: Vec::new(),
    };
    Ok(render_siglus_cg(&image, Default::default())?)
}

fn sha256(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

pub(super) fn non_background_pixel_count(frame: &SiglusCgFrame) -> usize {
    frame
        .pixels_rgba
        .first_chunk::<4>()
        .map_or(0, |background| {
            frame
                .pixels_rgba
                .chunks_exact(4)
                .filter(|pixel| pixel[..3] != background[..3])
                .count()
        })
}
