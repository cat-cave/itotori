//! UTSUSHI-214 — headless render pipeline + deterministic PNG encoder.
//!
//! Owns the per-frame [`Framebuffer`], the [`RenderPass`] that walks the
//! [`crate::GraphicsObjectStack`] and rasterises it, the
//! deterministic-PNG encoder, and the in-process artifact store that
//! retains the encoded PNG bytes so the acceptance criteria can pin
//! "the artifact_id resolves to a PNG blob" without going through a
//! filesystem.
//!
//! # Substrate-gap honesty (UTSUSHI-214 spec callout)
//!
//! The DAG node carries a **substrate-gap** callout: the substrate's
//! [`utsushi_core::substrate::FrameArtifactSink`] currently enforces an
//! `EvidenceTier::E2` per-payload floor (see
//! `crates/utsushi-core/src/sink/frame.rs` and the proposal note at
//! `docs/research/reallive-engine-dag-proposal.md` § "UTSUSHI-146o").
//! The UTSUSHI-214 spec, however, requires the synthetic-rasterised
//! frame to carry `evidence_tier=E1` because the headless rasteriser
//! produces a synthetic frame, not a captured one. To keep this crate
//! substrate-honest, UTSUSHI-214 emits through a typed in-crate carrier
//! ([`FrameEmission`] +
//! [`InMemoryFrameArtifactStore`]) rather than through the E2-floored
//! substrate sink. When the substrate slice lands the
//! E1-emission-from-engine extension (tracked under the same
//! substrate-gap line in `reallive-engine-dag-proposal.md`), the wiring
//! into [`utsushi_core::substrate::SinkSet`] becomes a one-line swap
//! at the [`RenderPass::emit`] call site — no on-disk format or
//! callsite shape changes.
//!
//! # Deterministic PNG encoder
//!
//! Audit-focus pin (DAG spec): "Non-deterministic PNG output
//! (timestamp metadata)". The encoder writes exactly four chunks in a
//! fixed order:
//!
//! 1. **`IHDR`** — width, height, bit depth `8`, colour type `6`
//!    (RGBA), no filter / interlace.
//! 2. **`IDAT`** — zlib stream wrapped around an **uncompressed
//!    deflate stored block** (BTYPE=00). Stored blocks have a fixed
//!    `(LEN, NLEN)` header and emit the pixel bytes verbatim, so the
//!    only variability surface that exists in dynamic-Huffman deflate
//!    is eliminated. zlib's `adler32` and the PNG `crc32` are both
//!    pure functions of the bytes, so the encoder is byte-identical
//!    across runs and threads.
//! 3. **`IEND`** — fixed zero-length terminator.
//!
//! No `tIME`, `tEXt`, `iTXt`, or `pHYs` chunks are written, so there
//! is no timestamp surface to leak between runs. The Adler-32 and
//! CRC-32 routines are written inline (no external crates), keeping
//! the byte stream fully reproducible.
//!
//! # Artifact store (audit-focus pin)
//!
//! Audit-focus pin (DAG spec): "The artifact store being a stub `Vec`
//! that doesn't actually retain bytes". [`InMemoryFrameArtifactStore`]
//! retains the **PNG bytes** keyed by `artifact_id`, not just a count:
//! - [`InMemoryFrameArtifactStore::get`] returns `Some(&[u8])` for
//!   stored artifacts;
//! - the per-emission `artifact_id` is a deterministic SHA-256 of the
//!   PNG bytes (sourced through the workspace `sha2` crate), so
//!   identical frame state produces an identical artifact id;
//! - the store's `len()` matches the number of distinct emissions, but
//!   the bytes are independently fetchable so the test surface verifies
//!   the audit-focus pin without trusting a counter.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::graphics_objects::{
    GraphicsObject, GraphicsObjectKind, GraphicsObjectStack, GraphicsPlane, WipeColour,
};
use crate::syscall::ScreenSize;
use utsushi_core::substrate::EvidenceTier;

/// Stable diagnostic code emitted by [`RenderPass::new`] when the
/// caller supplies a [`ScreenSize`] with `width == 0` or `height == 0`.
pub const RENDER_PIPELINE_ZERO_SCREEN_SIZE_CODE: &str =
    "utsushi.reallive.render_pipeline.zero_screen_size";

/// Stable diagnostic code emitted by [`InMemoryFrameArtifactStore::resolve`]
/// when a lookup misses. Tests can pin this without scraping `Display`.
pub const RENDER_PIPELINE_ARTIFACT_MISS_CODE: &str =
    "utsushi.reallive.render_pipeline.artifact_miss";

/// PNG file-magic. Pinned so the deterministic-encoder test can assert
/// the prefix without inlining the magic in the test itself.
pub const PNG_FILE_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// PNG colour type for RGBA: per the spec, value `6`.
pub const PNG_COLOUR_TYPE_RGBA: u8 = 6;

/// Bit depth this encoder writes (`8` bits per channel).
pub const PNG_BIT_DEPTH: u8 = 8;

/// Bytes per pixel (`RGBA = 4`).
pub const RGBA_BYTES_PER_PIXEL: usize = 4;

/// Framebuffer header carried in the IDAT scanlines: every PNG scanline
/// is prefixed with a one-byte filter code. The encoder uses `0` (no
/// filter) so the scanline contents stay byte-identical to the raw
/// framebuffer row.
const PNG_FILTER_NONE: u8 = 0;

/// In-process framebuffer. A `width × height` grid of RGBA bytes in
/// row-major order. The render pass writes into the buffer directly;
/// the encoder consumes it byte-for-byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Framebuffer {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Framebuffer {
    /// Construct a `width × height` framebuffer, initialised to the
    /// fully-transparent (`r=g=b=a=0`) pattern.
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0u8; (width as usize) * (height as usize) * RGBA_BYTES_PER_PIXEL],
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Borrow the raw RGBA bytes in row-major order.
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Fill the entire framebuffer with `colour`, **in RGBA order**.
    /// The wipe-object renderer routes through this method.
    pub fn fill(&mut self, colour: WipeColour) {
        let pattern = [colour.red, colour.green, colour.blue, colour.alpha];
        for (index, byte) in self.pixels.iter_mut().enumerate() {
            *byte = pattern[index % RGBA_BYTES_PER_PIXEL];
        }
    }
}

/// Per-frame emission carried out of the render pass. Mirrors the
/// substrate's [`utsushi_core::substrate::FrameArtifact`] shape so the
/// post-substrate-gap swap (see the module docstring) is a structural
/// change to one site rather than a redesign of the consumers.
///
/// `evidence_tier` is fixed to `E1` per the UTSUSHI-214 spec
/// acceptance criterion. The substrate sink today rejects `E1`, which
/// is exactly the substrate-gap this node documents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameEmission {
    /// Monotonic frame number, sourced from the render pass's
    /// `frame_index` counter.
    pub frame_index: u64,
    /// `EvidenceTier::E1` for every UTSUSHI-214 emission.
    pub evidence_tier: EvidenceTier,
    /// Deterministic identifier; SHA-256 of the encoded PNG bytes,
    /// rendered as a lower-case hex digest.
    pub artifact_id: String,
    /// Pixel width of the emitted PNG.
    pub width: u32,
    /// Pixel height of the emitted PNG.
    pub height: u32,
    /// Stable artifact kind (`"frame_capture"`). Pinned so the
    /// substrate-gap swap can keep the same allow-list.
    pub artifact_kind: String,
}

/// Typed errors surfaced by [`InMemoryFrameArtifactStore`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FrameArtifactStoreError {
    /// `artifact_id` was not stored. The diagnostic code is pinned at
    /// [`RENDER_PIPELINE_ARTIFACT_MISS_CODE`] so tests can grep without
    /// scraping `Display`.
    #[error("frame artifact id not stored: {artifact_id} ({code})")]
    Miss { code: String, artifact_id: String },
}

/// In-process artifact store keyed by deterministic SHA-256 ids. The
/// store **retains the PNG bytes**, not just a count — the
/// UTSUSHI-214 audit-focus item "the artifact store being a stub `Vec`
/// that doesn't actually retain bytes" is the explicit motivation.
///
/// The store uses a `BTreeMap<String, Vec<u8>>` rather than a `Vec`
/// so a duplicate insertion (same `artifact_id` from a deterministic
/// re-encode of identical state) replaces the entry with the same
/// bytes rather than appending. Acceptance criterion "two render
/// passes with the same state produce byte-identical PNGs" is
/// independently verifiable through [`InMemoryFrameArtifactStore::get`].
#[derive(Debug, Default)]
pub struct InMemoryFrameArtifactStore {
    by_id: Mutex<BTreeMap<String, Vec<u8>>>,
}

impl InMemoryFrameArtifactStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert `bytes` keyed by `artifact_id`. Returns the previous
    /// bytes if the key was already present (`None` otherwise).
    pub fn insert(&self, artifact_id: impl Into<String>, bytes: Vec<u8>) -> Option<Vec<u8>> {
        self.by_id
            .lock()
            .expect("InMemoryFrameArtifactStore lock")
            .insert(artifact_id.into(), bytes)
    }

    /// Borrow-by-clone the bytes for `artifact_id`. The clone is
    /// intentional: the store owns the canonical bytes, callers get
    /// an owned copy. Returns `None` on miss.
    pub fn get(&self, artifact_id: &str) -> Option<Vec<u8>> {
        self.by_id
            .lock()
            .expect("InMemoryFrameArtifactStore lock")
            .get(artifact_id)
            .cloned()
    }

    /// Typed-error variant of [`Self::get`] for callsites that want
    /// to surface a stable diagnostic code on miss.
    pub fn resolve(&self, artifact_id: &str) -> Result<Vec<u8>, FrameArtifactStoreError> {
        self.get(artifact_id)
            .ok_or_else(|| FrameArtifactStoreError::Miss {
                code: RENDER_PIPELINE_ARTIFACT_MISS_CODE.to_string(),
                artifact_id: artifact_id.to_string(),
            })
    }

    /// Number of distinct stored artifact ids.
    pub fn len(&self) -> usize {
        self.by_id
            .lock()
            .expect("InMemoryFrameArtifactStore lock")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Return the sorted set of stored ids (BTreeMap-order). Useful for
    /// tests that pin "the second render pass produced no new id".
    pub fn ids(&self) -> Vec<String> {
        self.by_id
            .lock()
            .expect("InMemoryFrameArtifactStore lock")
            .keys()
            .cloned()
            .collect()
    }
}

/// Typed errors surfaced by [`RenderPass::new`] when the caller-supplied
/// [`ScreenSize`] is unusable.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RenderPassBuildError {
    /// Width or height is zero. The render pass refuses to silently
    /// emit a zero-pixel PNG.
    #[error(
        "render pass requires non-zero screen dimensions, got width={width} height={height} ({code})"
    )]
    ZeroScreenSize {
        code: String,
        width: u32,
        height: u32,
    },
}

/// The headless render pipeline. Owns a per-pass `frame_index`
/// counter, the framebuffer dimensions, and the artifact store the
/// emitted PNG bytes land in.
#[derive(Debug)]
pub struct RenderPass {
    width: u32,
    height: u32,
    frame_index: u64,
    artifact_store: InMemoryFrameArtifactStore,
}

impl RenderPass {
    /// Construct a render pass from a [`ScreenSize`] (e.g. the value
    /// parsed from Sweetie HD's `Gameexe.ini` `SCREENSIZE_MOD=999,1280,720`
    /// by [`crate::SyscallDispatcher::screen_size`]).
    pub fn new(screen_size: ScreenSize) -> Result<Self, RenderPassBuildError> {
        Self::with_dimensions(screen_size.width, screen_size.height)
    }

    /// Construct a render pass with raw `(width, height)`. Used by
    /// tests that want to drive the encoder without a full Gameexe
    /// parse.
    pub fn with_dimensions(width: u32, height: u32) -> Result<Self, RenderPassBuildError> {
        if width == 0 || height == 0 {
            return Err(RenderPassBuildError::ZeroScreenSize {
                code: RENDER_PIPELINE_ZERO_SCREEN_SIZE_CODE.to_string(),
                width,
                height,
            });
        }
        Ok(Self {
            width,
            height,
            frame_index: 0,
            artifact_store: InMemoryFrameArtifactStore::new(),
        })
    }

    /// Framebuffer pixel width.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Framebuffer pixel height.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The next `frame_index` the render pass will emit.
    pub fn next_frame_index(&self) -> u64 {
        self.frame_index
    }

    /// Borrow the artifact store. The store retains the PNG bytes
    /// keyed by `artifact_id`; see the module docstring for the
    /// audit-focus motivation.
    pub fn artifact_store(&self) -> &InMemoryFrameArtifactStore {
        &self.artifact_store
    }

    /// Rasterise `stack` into a fresh framebuffer, encode it as a
    /// deterministic PNG, store the bytes under the SHA-256-derived
    /// `artifact_id`, and return the [`FrameEmission`].
    pub fn render(&mut self, stack: &GraphicsObjectStack) -> FrameEmission {
        let framebuffer = self.rasterise(stack);
        let png_bytes = encode_png_rgba_deterministic(&framebuffer);
        let artifact_id = sha256_hex(&png_bytes);
        self.artifact_store.insert(artifact_id.clone(), png_bytes);
        let emission = FrameEmission {
            frame_index: self.frame_index,
            evidence_tier: EvidenceTier::E1,
            artifact_id,
            width: self.width,
            height: self.height,
            artifact_kind: "frame_capture".to_string(),
        };
        self.frame_index = self.frame_index.saturating_add(1);
        emission
    }

    /// Rasterise without encoding or storing. Useful for tests that
    /// want to assert pixel-level state without round-tripping
    /// through the PNG encoder. The render order is:
    ///   `(plane: Background first, then Foreground)`, then within
    ///   each plane `(layer_order ascending, slot ascending)`.
    pub fn rasterise(&self, stack: &GraphicsObjectStack) -> Framebuffer {
        let mut framebuffer = Framebuffer::new(self.width, self.height);
        let mut entries: Vec<(GraphicsPlane, i32, usize, &GraphicsObject)> = stack
            .iter_allocated()
            .map(|(plane, slot, object)| (plane, object.layer_order, slot, object))
            .collect();
        entries.sort_by_key(|(plane, layer, slot, _)| (plane.paint_order(), *layer, *slot));
        for (_, _, _, object) in entries {
            if !object.visible {
                continue;
            }
            self.paint_object(&mut framebuffer, object);
        }
        framebuffer
    }

    fn paint_object(&self, framebuffer: &mut Framebuffer, object: &GraphicsObject) {
        match &object.kind {
            GraphicsObjectKind::Wipe { colour } => {
                framebuffer.fill(*colour);
            }
            GraphicsObjectKind::Image { .. } => {
                // UTSUSHI-214 records the image_ref but does not
                // dereference it. The g00 binding lands with the
                // graphics RLOperation family at UTSUSHI-215.
            }
        }
    }
}

/// Deterministic SHA-256 hex digest. Sourced through the workspace
/// `sha2` crate (already a transitive dependency); pinned here as a
/// thin helper so the artifact-id derivation has a single home.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Encode `framebuffer` as a deterministic 8-bit RGBA PNG. See the
/// module docstring for the determinism contract.
pub fn encode_png_rgba_deterministic(framebuffer: &Framebuffer) -> Vec<u8> {
    let mut out = Vec::with_capacity(PNG_FILE_MAGIC.len() + framebuffer.pixels().len() + 256);
    out.extend_from_slice(&PNG_FILE_MAGIC);
    write_ihdr_chunk(&mut out, framebuffer.width(), framebuffer.height());
    write_idat_chunk(
        &mut out,
        framebuffer.width(),
        framebuffer.height(),
        framebuffer.pixels(),
    );
    write_iend_chunk(&mut out);
    out
}

fn write_chunk(out: &mut Vec<u8>, chunk_type: [u8; 4], payload: &[u8]) {
    let length = payload.len() as u32;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&chunk_type);
    out.extend_from_slice(payload);
    let mut crc_input = Vec::with_capacity(4 + payload.len());
    crc_input.extend_from_slice(&chunk_type);
    crc_input.extend_from_slice(payload);
    let crc = crc32_ieee(&crc_input);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn write_ihdr_chunk(out: &mut Vec<u8>, width: u32, height: u32) {
    let mut payload = Vec::with_capacity(13);
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&height.to_be_bytes());
    payload.push(PNG_BIT_DEPTH);
    payload.push(PNG_COLOUR_TYPE_RGBA);
    payload.push(0); // compression method 0 (deflate)
    payload.push(0); // filter method 0
    payload.push(0); // interlace method 0 (none)
    write_chunk(out, *b"IHDR", &payload);
}

fn write_idat_chunk(out: &mut Vec<u8>, width: u32, height: u32, pixels: &[u8]) {
    // Build the PNG scanline stream: one filter byte (0 = None) per row,
    // followed by the row's RGBA bytes.
    let row_stride = (width as usize) * RGBA_BYTES_PER_PIXEL;
    let mut scanlines = Vec::with_capacity((height as usize) * (1 + row_stride));
    for row in 0..(height as usize) {
        scanlines.push(PNG_FILTER_NONE);
        let row_start = row * row_stride;
        scanlines.extend_from_slice(&pixels[row_start..row_start + row_stride]);
    }
    let payload = wrap_as_zlib_stored(&scanlines);
    write_chunk(out, *b"IDAT", &payload);
}

fn write_iend_chunk(out: &mut Vec<u8>) {
    write_chunk(out, *b"IEND", &[]);
}

/// Wrap `data` as a zlib stream consisting of one-or-more uncompressed
/// deflate stored blocks (`BTYPE=00`). RFC 1951 caps a stored block at
/// `65_535` bytes; longer payloads are split into multiple blocks. The
/// final block sets the `BFINAL` bit. The zlib header is the
/// well-known `0x78 0x01` (deflate, no compression, no dictionary,
/// `FCHECK` chosen so `(CMF*256 + FLG) % 31 == 0`).
fn wrap_as_zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 16);
    // CMF: deflate, 32K window. FLG: FCHECK chosen so the RFC 1950
    // header-check invariant `(CMF*256 + FLG) % 31 == 0` holds.
    const ZLIB_CMF: u8 = 0x78;
    const ZLIB_FLG: u8 = 0x01;
    // Compile-time pin of the invariant; a future tweak to either
    // byte that breaks the header check fails to compile rather than
    // shipping a stream rejected by strict zlib decoders.
    const _: () = assert!(
        ((ZLIB_CMF as u16) * 256 + ZLIB_FLG as u16).is_multiple_of(31),
        "zlib header (CMF, FLG) pair must satisfy (CMF*256 + FLG) % 31 == 0",
    );
    out.push(ZLIB_CMF);
    out.push(ZLIB_FLG);

    const MAX_STORED_BLOCK_LEN: usize = 65_535;
    if data.is_empty() {
        // Emit a single empty final stored block.
        out.push(0x01); // BFINAL=1, BTYPE=00
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(!0u16).to_le_bytes());
    } else {
        let mut offset = 0usize;
        while offset < data.len() {
            let remaining = data.len() - offset;
            let take = remaining.min(MAX_STORED_BLOCK_LEN);
            let is_final = offset + take == data.len();
            let header = if is_final { 0x01u8 } else { 0x00u8 };
            out.push(header);
            let len = take as u16;
            let nlen = !len;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&nlen.to_le_bytes());
            out.extend_from_slice(&data[offset..offset + take]);
            offset += take;
        }
    }

    let adler = adler32(data);
    out.extend_from_slice(&adler.to_be_bytes());
    out
}

/// Adler-32 checksum (RFC 1950 / zlib).
pub fn adler32(data: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

/// CRC-32 (IEEE-802.3 polynomial, used by PNG and zlib).
pub fn crc32_ieee(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        t
    });
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        let index = ((crc ^ byte as u32) & 0xFF) as usize;
        crc = table[index] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphics_objects::{GraphicsObject, WipeColour};

    fn reallive_real_bytes_screen_size() -> ScreenSize {
        ScreenSize {
            mode: 999,
            width: 1280,
            height: 720,
        }
    }

    #[test]
    fn adler32_known_vector() {
        // Vector from RFC 1950 commentary / zlib test suite: adler32("Wikipedia")
        // = 0x11E60398.
        assert_eq!(adler32(b"Wikipedia"), 0x11E60398);
    }

    #[test]
    fn adler32_of_empty_is_one() {
        assert_eq!(adler32(&[]), 1);
    }

    #[test]
    fn crc32_known_vector_matches_png_spec() {
        // Test vector from RFC 3720 / PNG spec: crc32("123456789") = 0xCBF43926.
        assert_eq!(crc32_ieee(b"123456789"), 0xCBF43926);
    }

    #[test]
    fn crc32_of_empty_is_zero() {
        assert_eq!(crc32_ieee(&[]), 0);
    }

    #[test]
    fn zlib_stored_round_trips_short_payload_through_known_header() {
        let wrapped = wrap_as_zlib_stored(b"hi");
        assert_eq!(wrapped[0], 0x78);
        assert_eq!(wrapped[1], 0x01);
        // BFINAL=1, BTYPE=00.
        assert_eq!(wrapped[2], 0x01);
        // LEN little-endian = 2.
        assert_eq!(&wrapped[3..5], &2u16.to_le_bytes());
        // NLEN little-endian = !2.
        assert_eq!(&wrapped[5..7], &(!2u16).to_le_bytes());
        // Payload then Adler-32 of the payload.
        assert_eq!(&wrapped[7..9], b"hi");
        assert_eq!(&wrapped[9..13], &adler32(b"hi").to_be_bytes());
    }

    #[test]
    fn zlib_stored_splits_at_64k_boundary() {
        // Inputs longer than 65_535 must be split across stored blocks.
        let payload = vec![0xAAu8; 65_535 + 10];
        let wrapped = wrap_as_zlib_stored(&payload);
        // Header (2) + first block header (5) + first block payload (65_535) +
        // second block header (5) + second block payload (10) + adler (4).
        let expected_len = 2 + 5 + 65_535 + 5 + 10 + 4;
        assert_eq!(wrapped.len(), expected_len);
        // First block must not be final, second must be.
        assert_eq!(wrapped[2], 0x00);
        let second_block_header = 2 + 5 + 65_535;
        assert_eq!(wrapped[second_block_header], 0x01);
    }

    #[test]
    fn render_pass_rejects_zero_screen_size() {
        let result = RenderPass::with_dimensions(0, 720);
        assert!(matches!(
            result,
            Err(RenderPassBuildError::ZeroScreenSize { width: 0, .. })
        ));
        let result = RenderPass::with_dimensions(1280, 0);
        assert!(matches!(
            result,
            Err(RenderPassBuildError::ZeroScreenSize { height: 0, .. })
        ));
    }

    #[test]
    fn render_pass_honours_reallive_real_bytes_screen_size() {
        let pass = RenderPass::new(reallive_real_bytes_screen_size()).expect("non-zero screen");
        assert_eq!(pass.width(), 1280);
        assert_eq!(pass.height(), 720);
    }

    #[test]
    fn deterministic_png_starts_with_magic_and_contains_expected_chunks() {
        let mut pass = RenderPass::with_dimensions(4, 2).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let wipe = GraphicsObject::wipe(WipeColour::opaque_rgb(0x12, 0x34, 0x56));
        stack
            .set(GraphicsPlane::Foreground, 0, wipe)
            .expect("in-range slot");
        let emission = pass.render(&stack);
        let bytes = pass
            .artifact_store()
            .resolve(&emission.artifact_id)
            .expect("artifact retained");
        assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);
        // IHDR length is 13.
        assert_eq!(&bytes[8..12], &13u32.to_be_bytes());
        assert_eq!(&bytes[12..16], b"IHDR");
        // IEND chunk is the last 12 bytes: 4-byte length + "IEND" + 4-byte CRC.
        let tail = &bytes[bytes.len() - 12..];
        assert_eq!(&tail[0..4], &0u32.to_be_bytes());
        assert_eq!(&tail[4..8], b"IEND");
    }

    #[test]
    fn wipe_smoke_fills_buffer_with_documented_colour_byte_order() {
        let pass = RenderPass::with_dimensions(2, 2).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let red = WipeColour::opaque_rgb(0xFF, 0x00, 0x00);
        stack
            .set(GraphicsPlane::Foreground, 0, GraphicsObject::wipe(red))
            .expect("set wipe");
        let fb = pass.rasterise(&stack);
        // Every pixel must be (R=255, G=0, B=0, A=255) in RGBA order.
        let pixels = fb.pixels();
        assert_eq!(pixels.len(), 16);
        for chunk in pixels.chunks(4) {
            assert_eq!(chunk, &[0xFF, 0x00, 0x00, 0xFF]);
        }
    }

    #[test]
    fn two_render_passes_with_same_state_produce_byte_identical_pngs() {
        let mut pass_a = RenderPass::with_dimensions(8, 8).expect("non-zero screen");
        let mut pass_b = RenderPass::with_dimensions(8, 8).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(
                GraphicsPlane::Foreground,
                3,
                GraphicsObject::wipe(WipeColour::WHITE),
            )
            .expect("set wipe");
        let emission_a = pass_a.render(&stack);
        let emission_b = pass_b.render(&stack);
        assert_eq!(emission_a.artifact_id, emission_b.artifact_id);
        let bytes_a = pass_a
            .artifact_store()
            .get(&emission_a.artifact_id)
            .expect("retained a");
        let bytes_b = pass_b
            .artifact_store()
            .get(&emission_b.artifact_id)
            .expect("retained b");
        assert_eq!(bytes_a, bytes_b);
    }

    #[test]
    fn artifact_store_actually_retains_bytes_not_a_stub_counter() {
        // Audit-focus pin: "The artifact store being a stub `Vec`
        // that doesn't actually retain bytes". The store MUST be able
        // to resolve the id back to non-empty bytes that start with
        // the PNG magic.
        let mut pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(
                GraphicsPlane::Foreground,
                0,
                GraphicsObject::wipe(WipeColour::BLACK),
            )
            .expect("set wipe");
        let emission = pass.render(&stack);
        let bytes = pass
            .artifact_store()
            .resolve(&emission.artifact_id)
            .expect("retained");
        assert!(bytes.len() > PNG_FILE_MAGIC.len());
        assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);
        let miss = pass.artifact_store().resolve("never-stored");
        assert!(matches!(miss, Err(FrameArtifactStoreError::Miss { .. })));
    }

    #[test]
    fn artifact_id_is_deterministic_sha256_of_png_bytes() {
        let mut pass = RenderPass::with_dimensions(3, 3).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(
                GraphicsPlane::Foreground,
                0,
                GraphicsObject::wipe(WipeColour::BLACK),
            )
            .expect("set wipe");
        let emission = pass.render(&stack);
        let bytes = pass
            .artifact_store()
            .get(&emission.artifact_id)
            .expect("retained");
        assert_eq!(emission.artifact_id, sha256_hex(&bytes));
    }

    #[test]
    fn emission_metadata_pins_evidence_tier_e1_and_artifact_kind() {
        let mut pass = RenderPass::with_dimensions(2, 2).expect("non-zero screen");
        let stack = GraphicsObjectStack::new();
        let emission = pass.render(&stack);
        assert_eq!(emission.evidence_tier, EvidenceTier::E1);
        assert_eq!(emission.artifact_kind, "frame_capture");
        assert_eq!(emission.frame_index, 0);
        assert_eq!(emission.width, 2);
        assert_eq!(emission.height, 2);
        let next = pass.render(&stack);
        assert_eq!(next.frame_index, 1);
    }

    #[test]
    fn layer_order_paints_higher_value_last_within_a_plane() {
        let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let mut lower = GraphicsObject::wipe(WipeColour::BLACK);
        lower.layer_order = 0;
        let mut higher = GraphicsObject::wipe(WipeColour::WHITE);
        higher.layer_order = 1;
        stack
            .set(GraphicsPlane::Foreground, 0, lower)
            .expect("set lower");
        stack
            .set(GraphicsPlane::Foreground, 1, higher)
            .expect("set higher");
        let fb = pass.rasterise(&stack);
        // The higher-layer white wipe must win the single pixel.
        assert_eq!(fb.pixels(), &[0xFF, 0xFF, 0xFF, 0xFF]);
    }

    #[test]
    fn foreground_plane_paints_after_background_regardless_of_layer_order() {
        let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let mut bg = GraphicsObject::wipe(WipeColour::WHITE);
        bg.layer_order = 999; // higher than the fg layer_order
        let mut fg = GraphicsObject::wipe(WipeColour::BLACK);
        fg.layer_order = 0;
        stack.set(GraphicsPlane::Background, 0, bg).expect("set bg");
        stack.set(GraphicsPlane::Foreground, 0, fg).expect("set fg");
        let fb = pass.rasterise(&stack);
        // Foreground wins despite its lower layer_order.
        assert_eq!(fb.pixels(), &[0x00, 0x00, 0x00, 0xFF]);
    }

    #[test]
    fn invisible_objects_are_skipped() {
        let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let mut hidden = GraphicsObject::wipe(WipeColour::WHITE);
        hidden.visible = false;
        stack
            .set(GraphicsPlane::Foreground, 0, hidden)
            .expect("set hidden");
        let fb = pass.rasterise(&stack);
        // No object painted → framebuffer stays at the initial
        // (0,0,0,0) pattern.
        assert_eq!(fb.pixels(), &[0x00, 0x00, 0x00, 0x00]);
    }
}
