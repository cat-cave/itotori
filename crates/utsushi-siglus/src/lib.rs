//! Siglus runtime port and real CG/container render surface.
//!
//! The port consumes assets exclusively through the Utsushi `AssetPackage`
//! facade.  Its production capture lifecycle decodes a supported Siglus G00,
//! rasterizes it in-process, and persists a default-redacted PNG under the
//! managed artifact root.  It intentionally does not claim a VM, text, or
//! replay implementation.
//!
//! # Clean-room boundary
//!
//! `siglus_rs`, `siglus-decompile`, and SiglusExtract are research anchors
//! only. This crate neither links nor vendors them, and its G00 observations
//! are re-derived against real title bytes before becoming behaviour here.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod opcode_profile;
pub mod runtime_profile;
pub mod siglus_g00;
pub mod siglus_render;
pub mod vm;
pub mod vm_impl_map;

mod cg_port;

pub use cg_port::{UtsushiSiglusPort, UtsushiSiglusPortContext};
pub use siglus_g00::{
    SiglusG00Error, SiglusG00Image, SiglusG00Kind, SiglusG00Layer, decode_siglus_g00,
};
pub use siglus_render::{
    SiglusCgFrame, SiglusCgRedaction, SiglusRenderError, encode_siglus_png, render_siglus_cg,
};

/// The clean-room research-anchor statement exposed for audit tooling.
pub const SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT: &str = concat!(
    "xmoezzz/siglus_rs (https://github.com/xmoezzz/siglus_rs, MPL-2.0) is a research anchor only. ",
    "bluecookies/siglus-decompile is treated as documentation-only because it states no license; ",
    "SiglusExtract is GPLv3. utsushi-siglus does not depend on siglus_rs, does not include ",
    "siglus_rs headers, does not copy siglus_rs structure layouts, and does not mechanically ",
    "translate any of these projects. Format hypotheses are re-derived and re-tested against real Siglus bytes.",
);

const _: () = assert!(!SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT.is_empty());
