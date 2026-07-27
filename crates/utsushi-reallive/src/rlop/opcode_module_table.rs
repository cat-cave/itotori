//! Append-only mount table for self-contained RealLive opcode modules.
//!
//! # Why this table exists
//!
//! Mounting an opcode module used to mean editing THREE shared files: a
//! `pub mod` line in `rlop/mod.rs`, a registrar import in `replay.rs`, and
//! a registrar call in `replay/implementation/registry.rs`. Because the
//! merge queue lands branches serially, every queued branch that mounted a
//! module invalidated the wiring edits of the branch ahead of it, so a
//! wave of N opcode branches cost O(N^2) rebases. The wiring — not the
//! opcode work — was the dominant failure mode.
//!
//! This table collapses that surface to ONE line in ONE file. The
//! `opcode_module_table!` invocation below is both the module
//! declaration and the mount registration, so a new opcode module appends
//! a single entry at the end of a list and touches nothing else. The file
//! additionally carries a `merge=union` attribute (see `.gitattributes`),
//! so git resolves simultaneous appends from independent branches without
//! a conflict.
//!
//! # Adding an opcode module
//!
//! 1. Write `src/rlop/module_<name>.rs` exposing
//!    `pub fn register_<name>_rlops(registry: &mut RlopRegistry) -> usize`.
//!    It addresses the rlop substrate through `super::…` exactly like the
//!    modules already listed (the re-exports further down make that
//!    resolve), and any sibling family module as `crate::rlop::module_…`.
//! 2. Append one line to the `opcode_module_table!` invocation.
//!
//! That is the whole wiring surface.
//!
//! # Substrate-honesty posture
//!
//! The table is data, not dispatch: each entry is a plain function pointer
//! invoked exactly once per registry mount, in declaration order. It adds
//! no fallback and swallows no failure — a module that claims a
//! `(module_type, module_id, opcode)` another module already claimed still
//! panics inside [`RlopRegistry::register`], loudly, at mount time.
//! Mount order does not affect the resulting op table: the registry is a
//! displacement-free map, so the mounted key set is order-independent.

use std::fmt;
use std::sync::Arc;

use utsushi_core::substrate::TextSurfaceSink;

use super::module_audio::AudioRuntime;
use super::module_msg::MsgRuntime;
use super::module_obj::GraphicsRuntime;
use super::module_sel::SelRuntime;
use super::module_str::StrRuntime;
use super::module_sys::SysRuntime;

// The mounted modules are children of THIS module, so their `super::…`
// paths resolve here. Re-export the rlop substrate every opcode module
// addresses, so a mounted module keeps the same `use super::{…}` shape it
// would have as a direct child of `rlop`. A mounted module that needs a
// sibling FAMILY module (for a shared module-id constant, say) names it
// absolutely as `crate::rlop::module_…` — the substrate re-export stays a
// fixed set that no new module has to extend.
pub(crate) use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};

/// Per-mount runtimes an opcode module may draw on.
///
/// Handed to every table entry so a module that needs the graphics /
/// audio / selection / sys / string / text runtime can take it WITHOUT
/// editing shared mount code — the one-line-append property holds for
/// runtime-bearing modules too, not just for stateless ones.
#[derive(Clone)]
pub struct OpcodeModuleContext {
    /// Substrate text sink this mount drives text output through.
    pub sink: Arc<dyn TextSurfaceSink>,
    /// Text/messaging runtime backing the `msg` family.
    pub msg: Arc<MsgRuntime>,
    /// Shared graphics-object runtime backing the `grp`/`obj` families.
    pub graphics: Arc<GraphicsRuntime>,
    /// Shared audio runtime backing the `bgm`/`pcm`/`koe` families.
    pub audio: Arc<AudioRuntime>,
    /// Selection (choice) runtime backing the `sel` family.
    pub selection: Arc<SelRuntime>,
    /// Fixed-seed clock/RNG runtime backing the `sys` family.
    pub sys: Arc<SysRuntime>,
    /// String-operation runtime backing the `str` family.
    pub strings: Arc<StrRuntime>,
}

impl fmt::Debug for OpcodeModuleContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpcodeModuleContext")
            .finish_non_exhaustive()
    }
}

/// Signature every table entry exposes: mount this module's ops onto
/// `registry`, returning the number of registrations made.
pub type OpcodeModuleMount = fn(&mut RlopRegistry, &OpcodeModuleContext) -> usize;

/// Declare and mount a self-contained opcode module in one entry.
///
/// Each entry is `"<file>.rs" => <module>: <mount expression>`. The macro
/// emits the `#[path]`-anchored `pub mod` declaration AND the
/// [`OPCODE_MODULE_TABLE`] entry, so the two can never drift apart and a
/// new module needs no second edit anywhere.
macro_rules! opcode_module_table {
    ($( $file:literal => $module:ident : $mount:expr ),* $(,)?) => {
        $(
            #[path = $file]
            pub mod $module;
        )*

        /// Every self-contained opcode module mounted into a full
        /// registry, in declaration order.
        pub(crate) const OPCODE_MODULE_TABLE: &[OpcodeModuleMount] = &[$($mount),*];
    };
}

// ---------------------------------------------------------------------
// APPEND-ONLY: add a new opcode module as ONE new line at the END.
// Do not reorder or regroup existing entries — that reintroduces the
// cross-branch conflicts this table exists to remove.
// ---------------------------------------------------------------------
opcode_module_table! {
    "module_media_commands.rs" => module_media_commands: |r, _| module_media_commands::register_media_rlops(r),
    "module_msg_extra.rs" => module_msg_extra: |r, _| module_msg_extra::register_msg_extra_rlops(r),
    "module_sys_menu.rs" => module_sys_menu: |r, _| module_sys_menu::register_sys_menu_rlops(r),
    "module_sys_display.rs" => module_sys_display: |r, _| module_sys_display::register_sys_display_rlops(r),
    "module_sys_timer.rs" => module_sys_timer: |r, _| module_sys_timer::register_sys_timer_rlops(r),
    "module_sys_config_commands.rs" => module_sys_config_commands: |r, _| module_sys_config_commands::register_sys_config_rlops(r),
    "module_observed_surface.rs" => module_observed_surface: |r, _| module_observed_surface::register_observed_surface_rlops(r),
}

/// Mount every entry in [`OPCODE_MODULE_TABLE`] onto `registry`,
/// returning the total number of registrations made.
pub(crate) fn mount_opcode_module_table(
    registry: &mut RlopRegistry,
    context: &OpcodeModuleContext,
) -> usize {
    OPCODE_MODULE_TABLE
        .iter()
        .map(|mount| mount(registry, context))
        .sum()
}
