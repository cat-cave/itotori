//! Siglus static-observation port and real CG/container render surface.
//!
//! The port consumes assets exclusively through the Utsushi `AssetPackage`
//! facade. It statically walks decoded scene text at E1 without claiming a
//! live VM, and it can rasterize a supported G00 into a default-redacted PNG
//! when an embedding configures that optional capture surface.
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
pub mod substrate_conformance_checklist;
pub mod vm;
pub mod vm_impl_map;

mod cg_port;
mod cg_port_sinks;
mod launch;
mod observe;

pub use cg_port::{UtsushiSiglusPort, UtsushiSiglusPortContext};
pub use cg_port_sinks::{SiglusObservationSinks, SiglusTextSink};
pub use launch::{SiglusSceneMoment, SiglusSceneMomentIndex};
pub use observe::{SiglusChoiceDiagnostic, SiglusChoiceMoment, SiglusChoiceOption};
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
