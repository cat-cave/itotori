//! Real Softpal scene-art loading and compositing for the private player frame.

use std::path::Path;

use image::{ImageFormat, load_from_memory_with_format};
use kaifuu_softpal::PacArchive;
use utsushi_reallive::{Framebuffer, TextLayer, WipeColour};
use utsushi_softpal::SoftpalFrame;

use crate::softpal_pgd::{PgdImage, decode_ge_pgd};

const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;

#[derive(Debug)]
pub(crate) struct SceneArt {
    background_name: String,
    character_name: String,
    background: PgdImage,
    character: PgdImage,
}

impl SceneArt {
    pub(crate) fn load(root: &Path) -> Result<Self, String> {
        let (background_name, background) = load_first_ge_image(&root.join("bk.pac"))?;
        let (character_name, character) = load_first_ge_image(&root.join("st.pac"))?;
        Ok(Self {
            background_name,
            character_name,
            background,
            character,
        })
    }

    pub(crate) fn description(&self) -> String {
        format!(
            "background={} character={}",
            self.background_name, self.character_name
        )
    }

    pub(crate) fn render(&self, speaker: Option<&str>, text: &str) -> Result<Vec<u8>, String> {
        let mut pixels = vec![0; WIDTH as usize * HEIGHT as usize * 4];
        scale_over(
            &mut pixels,
            (WIDTH, HEIGHT),
            &self.background,
            (0, 0, WIDTH, HEIGHT),
        );
        let scaled_width = WIDTH / 2;
        let scaled_height = HEIGHT;
        scale_over(
            &mut pixels,
            (WIDTH, HEIGHT),
            &self.character,
            ((WIDTH - scaled_width) / 2, 0, scaled_width, scaled_height),
        );
        overlay_text(&mut pixels, speaker, text)?;
        Ok(pixels)
    }
}

fn load_first_ge_image(path: &Path) -> Result<(String, PgdImage), String> {
    let archive_bytes =
        std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let archive = PacArchive::parse(&archive_bytes).map_err(|error| error.to_string())?;
    let mut found_pgd = false;
    for entry in archive.entries() {
        let extension = entry
            .name
            .rsplit_once('.')
            .map_or("", |(_, extension)| extension);
        if extension != "PGD" && extension != "JPG" {
            continue;
        }
        found_pgd |= extension == "PGD";
        let bytes = archive
            .extract(&archive_bytes, entry)
            .map_err(|error| error.to_string())?;
        let decoded = if extension == "JPG" {
            decode_jpeg(bytes)
        } else {
            decode_ge_pgd(bytes)
        };
        if let Ok(image) = decoded {
            return Ok((entry.name.clone(), image));
        }
    }
    let extension = if found_pgd {
        "no supported GE PGD"
    } else {
        "no PGD"
    };
    Err(format!("{} has {extension} asset", path.display()))
}

fn decode_jpeg(bytes: &[u8]) -> Result<PgdImage, String> {
    let image = load_from_memory_with_format(bytes, ImageFormat::Jpeg)
        .map_err(|error| format!("JPEG decode: {error}"))?
        .into_rgba8();
    Ok(PgdImage {
        width: image.width(),
        height: image.height(),
        rgba: image.into_raw(),
    })
}

fn scale_over(
    target: &mut [u8],
    (target_width, target_height): (u32, u32),
    source: &PgdImage,
    (x, y, width, height): (u32, u32, u32, u32),
) {
    for destination_y in 0..height.min(target_height.saturating_sub(y)) {
        let source_y = destination_y as usize * source.height as usize / height as usize;
        for destination_x in 0..width.min(target_width.saturating_sub(x)) {
            let source_x = destination_x as usize * source.width as usize / width as usize;
            let source_offset = (source_y * source.width as usize + source_x) * 4;
            let target_offset = ((y + destination_y) as usize * target_width as usize
                + (x + destination_x) as usize)
                * 4;
            source_over(
                &mut target[target_offset..target_offset + 4],
                &source.rgba[source_offset..source_offset + 4],
            );
        }
    }
}

fn overlay_text(target: &mut [u8], speaker: Option<&str>, text: &str) -> Result<(), String> {
    let mut lines = Vec::new();
    if let Some(speaker) = speaker.filter(|speaker| !speaker.trim().is_empty()) {
        lines.push(speaker.to_string());
    }
    lines.extend(text.split('\n').map(ToOwned::to_owned));
    if lines.iter().all(|line| line.trim().is_empty()) {
        return Err("softpal-live-player reached an empty decoded dialogue boundary".to_string());
    }
    let mut layer = Framebuffer::new(WIDTH, HEIGHT);
    let painted = layer.draw_text(&TextLayer {
        lines,
        origin_x: 16,
        origin_y: 16,
        scale: 24,
        colour: WipeColour::WHITE,
        backdrop: None,
        name_box: None,
        line_height: None,
    });
    if painted == 0 {
        return Err("softpal-live-player decoded dialogue painted zero pixels".to_string());
    }
    for (destination, source) in target
        .chunks_exact_mut(4)
        .zip(layer.pixels().chunks_exact(4))
    {
        source_over(destination, source);
    }
    Ok(())
}

fn source_over(destination: &mut [u8], source: &[u8]) {
    let alpha = u32::from(source[3]);
    if alpha == 0 {
        return;
    }
    let inverse = 255 - alpha;
    for channel in 0..3 {
        destination[channel] =
            ((u32::from(source[channel]) * alpha + u32::from(destination[channel]) * inverse + 127)
                / 255) as u8;
    }
    destination[3] = (alpha + (u32::from(destination[3]) * inverse + 127) / 255).min(255) as u8;
}

pub(crate) fn art_frame(
    art: &SceneArt,
    speaker: Option<&str>,
    text: &str,
) -> Result<SoftpalFrame, String> {
    Ok(SoftpalFrame {
        width: WIDTH,
        height: HEIGHT,
        pixels_rgba: art.render(speaker, text)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_compositor_changes_the_destination_with_source_pixels() {
        let mut destination = [10, 20, 30, 255];
        source_over(&mut destination, &[200, 100, 50, 255]);
        assert_eq!(destination, [200, 100, 50, 255]);
    }

    #[test]
    fn scene_frame_contains_the_decoded_background_below_text() {
        let art = SceneArt {
            background_name: "test-background.PGD".to_string(),
            character_name: "transparent-character.PGD".to_string(),
            background: PgdImage {
                width: 1,
                height: 1,
                rgba: vec![12, 34, 56, 255],
            },
            character: PgdImage {
                width: 1,
                height: 1,
                rgba: vec![0, 0, 0, 0],
            },
        };
        let frame = art_frame(&art, None, "decoded dialogue").expect("frame composites");
        let bottom_right = ((HEIGHT as usize - 1) * WIDTH as usize + (WIDTH as usize - 1)) * 4;
        assert_eq!(
            &frame.pixels_rgba[bottom_right..bottom_right + 4],
            &[12, 34, 56, 255]
        );
    }
}
