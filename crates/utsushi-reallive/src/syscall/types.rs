//! Public type surface for system-call dispatch: diagnostic codes, route
//! kinds, route entries, hot regions, screen size, and typed build /
//! dispatch errors. Extracted from the parent so the type band lives in
//! its own ≤500-line child.

use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::vm::SceneId;

/// Stable diagnostic code emitted when the Gameexe tree declares a
/// route key without a matching `(scene, entrypoint)` integer pair.
pub const SYSCALL_ROUTE_MALFORMED_PAIR_CODE: &str = "utsushi.reallive.syscall.route_malformed_pair";

/// Stable diagnostic code emitted when a `MOUSEACTIONCALL.NNN.AREA`
/// key is present but does not parse as a 4-int rectangle.
pub const SYSCALL_MOUSE_AREA_MALFORMED_CODE: &str = "utsushi.reallive.syscall.mouse_area_malformed";

/// Stable diagnostic code emitted when `SCREENSIZE_MOD` is missing or
/// malformed and a pointer event arrives. Normalized → pixel coord
/// conversion requires a known screen size; without it the dispatcher
/// refuses to guess.
pub const SYSCALL_MISSING_SCREEN_SIZE_CODE: &str = "utsushi.reallive.syscall.missing_screen_size";

/// WBCALL slot count **CORPUS-OBSERVED from Sweetie HD**
/// (`WBCALL.000`-`WBCALL.007`) — the only alpha-corpus RealLive title
/// that declares any WBCALL routes.
///
/// **This is NOT an engine-validated universal.** RLDEV documents a
/// *larger* WBCALL namespace, and the 2nd staged RealLive corpus
/// (Kanon) declares no WBCALL routes at all, so nothing corroborates
/// `8` as a RealLive-engine ceiling. Read this as "what Sweetie HD
/// happens to declare", not "the RealLive WBCALL cap". Promotion from
/// corpus-observed to engine-validated requires a 2nd RealLive title
/// that itself exercises WBCALL slots — tracked by the beta-gate guard
/// `wbcall_slot_count_stays_corpus_observed_until_second_reallive_title`
/// in `tests/syscall_routes_real_bytes.rs`.
///
/// Pinned as a `const` so the dispatcher loop and the acceptance test
/// share a single source of truth for the Sweetie-HD-observed value.
pub const WBCALL_SLOT_COUNT: u8 = 8;

/// Stable diagnostic code emitted when a `WBCALL.NNN` key is declared at
/// or beyond the corpus-observed [`WBCALL_SLOT_COUNT`] cap (Sweetie HD).
/// RLDEV documents a larger WBCALL namespace, but no staged RealLive
/// title exercises a higher slot, so the cap stays corpus-observed; the
/// dispatcher refuses to silently ignore an out-of-range slot.
pub const SYSCALL_WBCALL_BEYOND_CAP_CODE: &str = "utsushi.reallive.syscall.wbcall_beyond_cap";

/// The fixed kind-distinct route count documented in
/// `docs/research/reallive-engine.md` § H. Eight kinds:
/// `Cancel`, `SystemcallSave`, `SystemcallLoad`, `SystemcallSystem`
/// `MouseAction`, `Loadcall`, `Exaftercall`, `Wbcall`. The Sweetie HD
/// acceptance test pins
/// [`SyscallDispatcher::route_count`] against this value.
pub const SYSCALL_KIND_COUNT: usize = 8;

/// One of the eight named system-call route kinds. The `Wbcall` and
/// `MouseAction` variants carry their per-instance index so the
/// dispatcher can route the right `WBCALL.NNN` / `MOUSEACTIONCALL.NNN`
/// to its own `(scene, entrypoint)` pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SyscallRouteKind {
    /// `CANCELCALL` — escape / cancel input.
    Cancel,
    /// `SYSTEMCALL_SAVE` — "Save" syscom selected.
    SystemcallSave,
    /// `SYSTEMCALL_LOAD` — "Load" syscom selected.
    SystemcallLoad,
    /// `SYSTEMCALL_SYSTEM` — "System menu" syscom selected.
    SystemcallSystem,
    /// `MOUSEACTIONCALL.NNN` — pointer hot-region.
    MouseAction {
        /// The `NNN` index (`MOUSEACTIONCALL.000` → `index=0`).
        index: u8,
    },
    /// `LOADCALL` — fires after a save is loaded.
    Loadcall,
    /// `EXAFTERCALL` — engine "after main scene" hook.
    Exaftercall,
    /// `WBCALL.NNN` — window-button callback `NNN`.
    Wbcall {
        /// The `NNN` index (`WBCALL.000` → `index=0`).
        index: u8,
    },
}

impl SyscallRouteKind {
    /// Stable token used in diagnostics and audit logs.
    pub fn token(self) -> &'static str {
        match self {
            Self::Cancel => "cancel",
            Self::SystemcallSave => "systemcall_save",
            Self::SystemcallLoad => "systemcall_load",
            Self::SystemcallSystem => "systemcall_system",
            Self::MouseAction { .. } => "mouse_action",
            Self::Loadcall => "loadcall",
            Self::Exaftercall => "exaftercall",
            Self::Wbcall { .. } => "wbcall",
        }
    }

    /// Discriminant index (0..8) used by [`SYSCALL_KIND_COUNT`]
    /// presence checks. Distinct per-variant; the `MouseAction`
    /// `Wbcall` instance index does not affect the discriminant.
    pub fn discriminant(self) -> u8 {
        match self {
            Self::Cancel => 0,
            Self::SystemcallSave => 1,
            Self::SystemcallLoad => 2,
            Self::SystemcallSystem => 3,
            Self::MouseAction { .. } => 4,
            Self::Loadcall => 5,
            Self::Exaftercall => 6,
            Self::Wbcall { .. } => 7,
        }
    }
}

impl fmt::Display for SyscallRouteKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MouseAction { index } => {
                write!(formatter, "mouse_action[{index:03}]")
            }
            Self::Wbcall { index } => write!(formatter, "wbcall[{index:03}]"),
            _ => formatter.write_str(self.token()),
        }
    }
}

/// One parsed dispatch-table entry: the kind, the
/// `(scene_id, entrypoint)` pair, and (for `MouseAction`) the
/// pixel-space hot region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyscallRoute {
    /// Route kind including any per-instance index.
    pub kind: SyscallRouteKind,
    /// Scene id the `farcall` targets.
    pub scene_id: SceneId,
    /// Entrypoint (`pc`) the `farcall` enters.
    pub entrypoint: u32,
    /// Pixel-space hot region carried by `MouseAction` routes. `None`
    /// for every other kind.
    pub area: Option<HotRegion>,
}

/// Inclusive pixel-space hit region for a `MOUSEACTIONCALL.NNN.AREA`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotRegion {
    /// Left edge, inclusive.
    pub x_min: i32,
    /// Top edge, inclusive.
    pub y_min: i32,
    /// Right edge, inclusive.
    pub x_max: i32,
    /// Bottom edge, inclusive.
    pub y_max: i32,
}

impl HotRegion {
    /// Whether the supplied pixel-space point lies inside the
    /// inclusive rectangle.
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x_min && x <= self.x_max && y >= self.y_min && y <= self.y_max
    }
}

/// Screen size declared by `SCREENSIZE_MOD=mode,width,height`. The
/// `mode` field is preserved verbatim (RLDEV-documented as the
/// resolution mode token) but is not consulted during pointer
/// conversion — only `width` / `height` are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenSize {
    /// `mode` field (`#SCREENSIZE_MOD=999,1280,720` → `999`).
    pub mode: i32,
    /// Pixel width.
    pub width: u32,
    /// Pixel height.
    pub height: u32,
}

impl ScreenSize {
    /// Convert a normalized pointer (`x`, `y` in `[0.0, 1.0]`) to
    /// pixel space. Returns `(x_px, y_px)` truncated toward zero
    /// (floor, since the clamped product is non-negative) via an
    /// `as i32` cast on `value * (dim - 1)` — *not* rounded to the
    /// nearest pixel. Coordinates outside `[0.0, 1.0]` are clamped
    /// before the multiply. Hot-region boundary tests are inclusive
    /// so a coordinate exactly on a pixel edge maps to that edge
    /// pixel; a sub-pixel fraction maps to the pixel below it.
    pub fn pointer_to_pixel(&self, x: f32, y: f32) -> (i32, i32) {
        let x_c = x.clamp(0.0, 1.0);
        let y_c = y.clamp(0.0, 1.0);
        let x_px = if self.width == 0 {
            0
        } else {
            (x_c * (self.width - 1) as f32) as i32
        };
        let y_px = if self.height == 0 {
            0
        } else {
            (y_c * (self.height - 1) as f32) as i32
        };
        (x_px, y_px)
    }
}

/// Typed errors surfaced by [`SyscallDispatcher::from_gameexe`]. Every
/// variant carries the route key that failed plus a stable diagnostic
/// code so audit tooling can pin the call site without scraping the
/// `Display` form.
#[derive(Debug, Clone, Error, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SyscallDispatchBuildError {
    /// A documented route key is present in the Gameexe tree but
    /// does not parse as a `(scene_id, entrypoint)` pair. The
    /// dispatcher refuses to silently drop the route — the audit-focus
    /// pin "Routes that say 'TODO' in unit tests but pretend to pass"
    /// requires this exact surface.
    #[error(
        "syscall route {route_key} is present but not shaped as `(scene, entrypoint)` ({code})"
    )]
    MalformedRoutePair {
        /// Stable diagnostic code (matches
        /// [`SYSCALL_ROUTE_MALFORMED_PAIR_CODE`]).
        code: String,
        /// Dotted-path key (e.g. `CANCELCALL`, `WBCALL.000`).
        route_key: String,
    },
    /// A `MOUSEACTIONCALL.NNN.SEEN` is present but its sibling
    /// `MOUSEACTIONCALL.NNN.AREA` is malformed (not a 4-int rectangle).
    #[error("mouse-action route {route_key} has malformed AREA shape (expected 4 ints) ({code})")]
    MouseAreaMalformed {
        /// Stable diagnostic code (matches
        /// [`SYSCALL_MOUSE_AREA_MALFORMED_CODE`]).
        code: String,
        /// Dotted-path key (e.g. `MOUSEACTIONCALL.000`).
        route_key: String,
    },
    /// A `MOUSEACTIONCALL.NNN.SEEN` route is present but its sibling
    /// `AREA` key is missing. Without an AREA the pointer dispatcher
    /// has nothing to test, so the dispatcher refuses to register
    /// the route rather than silently treating it as a fallback.
    #[error("mouse-action route {route_key} is missing its sibling AREA key ({code})")]
    MouseAreaMissing {
        /// Stable diagnostic code (matches
        /// [`SYSCALL_MOUSE_AREA_MALFORMED_CODE`]).
        code: String,
        /// Dotted-path key (e.g. `MOUSEACTIONCALL.000`).
        route_key: String,
    },
    /// A `WBCALL.NNN` key is present with `NNN` at or beyond the
    /// corpus-observed [`WBCALL_SLOT_COUNT`] cap. Sweetie HD (the only
    /// alpha-corpus RealLive title that declares WBCALL routes) declares
    /// exactly `WBCALL.000`-`007`; RLDEV documents a larger namespace but
    /// no staged corpus game exercises it, so the cap is corpus-observed
    /// NOT engine-validated. The dispatcher refuses to silently ignore
    /// the out-of-range slot (the original silent-truncation behaviour)
    /// rather than register a route no staged corpus has validated. When
    /// a real ≥2-game beta corpus exercises higher slots, raise the cap
    /// (promoting it toward engine-validated) and convert this to
    /// enumeration (mirroring the MOUSEACTIONCALL full-namespace scan).
    #[error(
        "wbcall route {route_key} declares slot index {index} at or beyond the corpus-observed cap of {cap} ({code})"
    )]
    WbcallSlotBeyondCap {
        /// Stable diagnostic code (matches
        /// [`SYSCALL_WBCALL_BEYOND_CAP_CODE`]).
        code: String,
        /// Dotted-path key (e.g. `WBCALL.008`).
        route_key: String,
        /// The out-of-range slot index that was declared.
        index: u8,
        /// The corpus-observed cap ([`WBCALL_SLOT_COUNT`], Sweetie HD).
        cap: u8,
    },
}

/// Typed error surfaced by [`SyscallDispatcher::route_for_input_event`]
/// when an input event cannot be lowered to a route without the
/// dispatcher guessing. Distinct from
/// [`SyscallDispatchBuildError`]: that surfaces at build time from a
/// malformed Gameexe shape, this surfaces at dispatch time from runtime
/// state the build could not have caught.
#[derive(Debug, Clone, Error, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SyscallDispatchError {
    /// A substrate [`InputEvent::Pointer`] arrived while at least one
    /// `MOUSEACTIONCALL.NNN` hot-region route is registered, but
    /// `SCREENSIZE_MOD` is missing or malformed so the normalized →
    /// pixel-space conversion cannot run. The dispatcher refuses to
    /// silently drop the pointer event — without this surface a stale
    /// Gameexe missing its `SCREENSIZE_MOD` would vanish every pointer
    /// hot-region dispatch with no diagnostic.
    #[error(
        "pointer event cannot be routed: SCREENSIZE_MOD is missing or malformed, so normalized coords cannot be lowered to pixel space ({code})"
    )]
    MissingScreenSize {
        /// Stable diagnostic code (matches
        /// [`SYSCALL_MISSING_SCREEN_SIZE_CODE`]).
        code: String,
    },
}
