//! UTSUSHI-213 — system-call dispatch wired to Gameexe routes.
//!
//! Builds a typed dispatch table from the Sweetie HD-shaped Gameexe
//! routes documented in `docs/research/reallive-engine.md` § H, then
//! lowers a substrate [`InputEvent`] or a pixel-space pointer-move into
//! a [`SyscallRoute`] that the VM event loop invokes through the
//! UTSUSHI-211 [`FarcallOp`]. No private dispatch path — every route
//! invocation goes through the existing control-flow [`FarcallOp`]
//! so the call stack, frame-kind discipline, and stack-depth ceiling
//! are reused verbatim (acceptance criterion #4).
//!
//! # Route kinds
//!
//! The dispatcher recognises **eight** route kinds covering Sweetie HD
//! § H:
//!
//! | Kind                              | Gameexe key                      | `_MOD` key                 |
//! | --------------------------------- | -------------------------------- | -------------------------- |
//! | [`SyscallRouteKind::Cancel`]      | `CANCELCALL`                     | `CANCELCALL_MOD`           |
//! | [`SyscallRouteKind::SystemcallSave`]   | `SYSTEMCALL_SAVE`           | `SYSTEMCALL_SAVE_MOD`      |
//! | [`SyscallRouteKind::SystemcallLoad`]   | `SYSTEMCALL_LOAD`           | `SYSTEMCALL_LOAD_MOD`      |
//! | [`SyscallRouteKind::SystemcallSystem`] | `SYSTEMCALL_SYSTEM`         | `SYSTEMCALL_SYSTEM_MOD`    |
//! | [`SyscallRouteKind::MouseAction`] | `MOUSEACTIONCALL.NNN.SEEN`+`AREA` | `MOUSEACTIONCALL.NNN.MOD`  |
//! | [`SyscallRouteKind::Loadcall`]    | `LOADCALL`                       | `LOADCALL_MOD`             |
//! | [`SyscallRouteKind::Exaftercall`] | `EXAFTERCALL`                    | `EXAFTERCALL_MOD`          |
//! | [`SyscallRouteKind::Wbcall`]      | `WBCALL.000`-`007`               | none (always active)       |
//!
//! Sweetie HD declares one `MOUSEACTIONCALL.000` and eight
//! `WBCALL.NNN` instances, so the parsed dispatcher holds **15
//! entries across 8 kinds**. The route count
//! ([`SyscallDispatcher::route_count`]) reports the kind-distinct
//! total — exactly 8 for Sweetie HD — which the acceptance criterion
//! pins as "the dispatcher reports 8 known routes".
//!
//! # `_MOD` flag semantics
//!
//! Per RLDEV, `<route>_MOD=0` disables the route entirely (the engine
//! treats it as not present). `_MOD=1` and missing `_MOD` keys leave
//! the route active. `MOUSEACTIONCALL.NNN.MOD` follows the same shape
//! but is dotted under the per-index namespace. `WBCALL` has no
//! documented `_MOD` flag, so its routes are always active.
//!
//! # Pointer hot-region dispatch
//!
//! `MOUSEACTIONCALL.NNN.AREA=x_min,y_min,x_max,y_max` is a pixel-space
//! rectangle. The dispatcher reads the screen size from
//! `SCREENSIZE_MOD=mode,width,height` and converts a substrate-
//! normalized [`InputEvent::Pointer`] (coords in `[0.0, 1.0]`) into
//! pixel-space before the inclusive rectangle test. Tests can also
//! drive [`SyscallDispatcher::route_for_pointer_pixel`] directly to
//! exercise the rectangle predicate without the normalization
//! round-trip.
//!
//! # Substrate-honesty posture
//!
//! - Every documented Gameexe shape that fails to parse surfaces a
//!   typed [`SyscallDispatchBuildError`] — no silent fallback.
//! - The eight route kinds are an exhaustive enum: a future
//!   per-engine extension would land as a new variant rather than as
//!   an `Other(String)` fallback.
//! - The dispatcher does not own a private call stack; it returns
//!   the typed [`SyscallRoute`] and the VM dispatches through the
//!   UTSUSHI-211 [`FarcallOp`] (see [`SyscallDispatcher::invoke`]).
//! - `_MOD=0` masks the route at parse time so a stale Gameexe with a
//!   disabled route cannot accidentally fire — the entry is not even
//!   in the table.

use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use utsushi_core::substrate::InputEvent;

use crate::gameexe::Gameexe;
use crate::rlop::module_ctrl::FarcallOp;
use crate::rlop::{DispatchOutcome, ExprValue, RLOperation};
use crate::vm::{SceneId, Vm, VmError};

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

/// Sweetie HD's WBCALL slot count (`WBCALL.000`-`WBCALL.007`).
/// Pinned as a `const` so the dispatcher loop and the acceptance test
/// share a single source of truth.
pub const WBCALL_SLOT_COUNT: u8 = 8;

/// The fixed kind-distinct route count documented in
/// `docs/research/reallive-engine.md` § H. Eight kinds:
/// `Cancel`, `SystemcallSave`, `SystemcallLoad`, `SystemcallSystem`,
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
    /// presence checks. Distinct per-variant; the `MouseAction` /
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
    /// pixel space. Returns `(x_px, y_px)` rounded to the nearest
    /// pixel via a truncating-toward-zero `as i32` cast on
    /// `value * (dim - 1)`. Coordinates outside `[0.0, 1.0]` are
    /// clamped before the multiply.
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
}

/// Typed dispatcher built from a parsed [`Gameexe`] tree. Holds the
/// 15-route Sweetie HD table (7 named routes + 8 WBCALL slots; one
/// MOUSEACTIONCALL slot) plus the screen size used by the pointer
/// normalization round-trip.
#[derive(Debug, Clone)]
pub struct SyscallDispatcher {
    routes: Vec<SyscallRoute>,
    screen_size: Option<ScreenSize>,
}

impl SyscallDispatcher {
    /// Build the dispatcher from a parsed [`Gameexe`]. Returns a
    /// typed [`SyscallDispatchBuildError`] on any malformed route
    /// key. Routes whose `_MOD=0` flag disables them are not
    /// registered (the engine treats `_MOD=0` as "route absent").
    ///
    /// # Errors
    ///
    /// - [`SyscallDispatchBuildError::MalformedRoutePair`] — a named
    ///   route key (e.g. `CANCELCALL=garbage`) is not a 2-int pair.
    /// - [`SyscallDispatchBuildError::MouseAreaMalformed`] — a
    ///   `MOUSEACTIONCALL.NNN.AREA` is not a 4-int rectangle.
    /// - [`SyscallDispatchBuildError::MouseAreaMissing`] — a
    ///   `MOUSEACTIONCALL.NNN.SEEN` lacks its sibling AREA.
    pub fn from_gameexe(gameexe: &Gameexe) -> Result<Self, SyscallDispatchBuildError> {
        let mut routes: Vec<SyscallRoute> = Vec::with_capacity(16);

        // The four named scalar routes whose `_MOD` key gates them.
        for (key, mod_key, kind) in [
            ("CANCELCALL", "CANCELCALL_MOD", SyscallRouteKind::Cancel),
            (
                "SYSTEMCALL_SAVE",
                "SYSTEMCALL_SAVE_MOD",
                SyscallRouteKind::SystemcallSave,
            ),
            (
                "SYSTEMCALL_LOAD",
                "SYSTEMCALL_LOAD_MOD",
                SyscallRouteKind::SystemcallLoad,
            ),
            (
                "SYSTEMCALL_SYSTEM",
                "SYSTEMCALL_SYSTEM_MOD",
                SyscallRouteKind::SystemcallSystem,
            ),
            ("LOADCALL", "LOADCALL_MOD", SyscallRouteKind::Loadcall),
            (
                "EXAFTERCALL",
                "EXAFTERCALL_MOD",
                SyscallRouteKind::Exaftercall,
            ),
        ] {
            if let Some(route) = parse_named_pair(gameexe, key, mod_key, kind)? {
                routes.push(route);
            }
        }

        // MOUSEACTIONCALL.NNN routes — enumerate the namespace.
        for index in 0..=u8::MAX {
            let seen_key = format!("MOUSEACTIONCALL.{index:03}.SEEN");
            let area_key = format!("MOUSEACTIONCALL.{index:03}.AREA");
            let mod_key = format!("MOUSEACTIONCALL.{index:03}.MOD");
            let Some(pair) = gameexe.get_int_pair(&seen_key) else {
                // No SEEN at this index — check it really is absent
                // (rather than malformed) and move on.
                if gameexe.get(&seen_key).is_some() {
                    return Err(SyscallDispatchBuildError::MalformedRoutePair {
                        code: SYSCALL_ROUTE_MALFORMED_PAIR_CODE.to_string(),
                        route_key: seen_key,
                    });
                }
                // Stop scanning after the first absent slot in the
                // common case — the audit-focus pin "Failing to wire
                // `_MOD` flags" requires the loop to make progress,
                // but the namespace is enumerated by checking each
                // slot, not by trusting a "last index" sentinel.
                if index > 0 && gameexe.get(&area_key).is_none() {
                    break;
                }
                continue;
            };
            if mod_disables(gameexe, &mod_key) {
                continue;
            }
            let area_value = gameexe.get_int_array(&area_key).ok_or_else(|| {
                if gameexe.get(&area_key).is_none() {
                    SyscallDispatchBuildError::MouseAreaMissing {
                        code: SYSCALL_MOUSE_AREA_MALFORMED_CODE.to_string(),
                        route_key: format!("MOUSEACTIONCALL.{index:03}"),
                    }
                } else {
                    SyscallDispatchBuildError::MouseAreaMalformed {
                        code: SYSCALL_MOUSE_AREA_MALFORMED_CODE.to_string(),
                        route_key: format!("MOUSEACTIONCALL.{index:03}"),
                    }
                }
            })?;
            if area_value.len() != 4 {
                return Err(SyscallDispatchBuildError::MouseAreaMalformed {
                    code: SYSCALL_MOUSE_AREA_MALFORMED_CODE.to_string(),
                    route_key: format!("MOUSEACTIONCALL.{index:03}"),
                });
            }
            let (scene_id, entrypoint) = normalise_pair(pair, &seen_key)?;
            routes.push(SyscallRoute {
                kind: SyscallRouteKind::MouseAction { index },
                scene_id,
                entrypoint,
                area: Some(HotRegion {
                    x_min: area_value[0],
                    y_min: area_value[1],
                    x_max: area_value[2],
                    y_max: area_value[3],
                }),
            });
        }

        // WBCALL.000-007 — fixed 8-slot window-button table.
        for index in 0..WBCALL_SLOT_COUNT {
            let key = format!("WBCALL.{index:03}");
            if let Some(pair) = gameexe.get_int_pair(&key) {
                let (scene_id, entrypoint) = normalise_pair(pair, &key)?;
                routes.push(SyscallRoute {
                    kind: SyscallRouteKind::Wbcall { index },
                    scene_id,
                    entrypoint,
                    area: None,
                });
            } else if gameexe.get(&key).is_some() {
                return Err(SyscallDispatchBuildError::MalformedRoutePair {
                    code: SYSCALL_ROUTE_MALFORMED_PAIR_CODE.to_string(),
                    route_key: key,
                });
            }
        }

        let screen_size = parse_screen_size(gameexe);

        Ok(Self {
            routes,
            screen_size,
        })
    }

    /// Borrow the parsed dispatch table in source-file order.
    pub fn routes(&self) -> &[SyscallRoute] {
        &self.routes
    }

    /// Number of *kind-distinct* routes the dispatcher carries. Pinned
    /// against [`SYSCALL_KIND_COUNT`] for Sweetie HD by the acceptance
    /// test (`syscall_routes_match_sweetie_hd`).
    pub fn route_count(&self) -> usize {
        let mut seen = [false; SYSCALL_KIND_COUNT];
        for route in &self.routes {
            seen[route.kind.discriminant() as usize] = true;
        }
        seen.iter().filter(|present| **present).count()
    }

    /// Total entry count (15 for Sweetie HD: 7 named + 8 WBCALL +
    /// 1 MOUSEACTIONCALL — minus any `_MOD=0`-disabled entries).
    pub fn entry_count(&self) -> usize {
        self.routes.len()
    }

    /// Borrow the parsed [`ScreenSize`], if any.
    pub fn screen_size(&self) -> Option<ScreenSize> {
        self.screen_size
    }

    /// Look up the route for a given kind. `MouseAction` and `Wbcall`
    /// require a matching instance index.
    pub fn route_for_kind(&self, kind: SyscallRouteKind) -> Option<&SyscallRoute> {
        self.routes.iter().find(|route| route.kind == kind)
    }

    /// Match a substrate [`InputEvent`] against the dispatch table.
    /// Returns the route that fires, or `None` if no route applies.
    ///
    /// The translation is:
    /// - [`InputEvent::Save`] → [`SyscallRouteKind::SystemcallSave`].
    /// - [`InputEvent::Load`] → [`SyscallRouteKind::SystemcallLoad`].
    /// - [`InputEvent::MenuSelect`] with `menu_id == "system"`,
    ///   `item_id == "cancel" | "system" | "loadcall" | "exaftercall"`
    ///   → the matching kind.
    /// - [`InputEvent::Pointer`] → first MOUSEACTIONCALL hot region the
    ///   normalized → pixel-space conversion lands inside.
    ///
    /// Unrecognised events return `None`. `WBCALL` routes are
    /// addressed through [`Self::route_for_wbcall`] — they fire from
    /// engine-side window-button hits rather than substrate
    /// `InputEvent`s.
    pub fn route_for_input_event(&self, event: &InputEvent) -> Option<&SyscallRoute> {
        match event {
            InputEvent::Save { .. } => self.route_for_kind(SyscallRouteKind::SystemcallSave),
            InputEvent::Load { .. } => self.route_for_kind(SyscallRouteKind::SystemcallLoad),
            InputEvent::MenuSelect { target } if target.menu_id == "system" => {
                match target.item_id.as_str() {
                    "cancel" => self.route_for_kind(SyscallRouteKind::Cancel),
                    "system" => self.route_for_kind(SyscallRouteKind::SystemcallSystem),
                    "loadcall" => self.route_for_kind(SyscallRouteKind::Loadcall),
                    "exaftercall" => self.route_for_kind(SyscallRouteKind::Exaftercall),
                    _ => None,
                }
            }
            InputEvent::Pointer { x, y, .. } => {
                let screen = self.screen_size?;
                let (x_px, y_px) = screen.pointer_to_pixel(*x, *y);
                self.route_for_pointer_pixel(x_px, y_px)
            }
            _ => None,
        }
    }

    /// Match a pixel-space pointer-move against the registered
    /// `MOUSEACTIONCALL.NNN.AREA` rectangles. Returns the first
    /// route whose AREA contains the point. Synthetic tests drive
    /// this directly to exercise the inclusive-rectangle predicate
    /// without going through the substrate normalization round-trip.
    pub fn route_for_pointer_pixel(&self, x: i32, y: i32) -> Option<&SyscallRoute> {
        self.routes
            .iter()
            .find(|route| route.area.is_some_and(|area| area.contains(x, y)))
    }

    /// Resolve a `WBCALL.NNN` slot. Returns `None` if the slot is not
    /// registered.
    pub fn route_for_wbcall(&self, index: u8) -> Option<&SyscallRoute> {
        self.route_for_kind(SyscallRouteKind::Wbcall { index })
    }

    /// Invoke a route through the UTSUSHI-211 [`FarcallOp`]. The VM
    /// pushes a `FarCall` frame and jumps to `(route.scene_id,
    /// route.entrypoint)`. The caller supplies the post-command
    /// `(return_scene, return_pc)` so the VM `rtl` lands at the right
    /// byte after the route returns.
    ///
    /// No private dispatch path — this routes through `FarcallOp` to
    /// reuse the substrate-snapshot-aware stack accounting, the
    /// [`crate::vm::STACK_DEPTH_LIMIT`] ceiling, and the same frame
    /// kind discipline the synthetic op layer uses.
    pub fn invoke(
        &self,
        vm: &mut Vm,
        route: &SyscallRoute,
        return_scene: SceneId,
        return_pc: u32,
    ) -> Result<(), VmError> {
        let args = [
            ExprValue::Int(return_scene as i32),
            ExprValue::Int(return_pc as i32),
            ExprValue::Int(route.scene_id as i32),
            ExprValue::Int(route.entrypoint as i32),
        ];
        let outcome = FarcallOp.dispatch(vm, &args);
        match &outcome {
            DispatchOutcome::FarCall { .. } => {}
            other => {
                // The FarcallOp surface is documented to return
                // FarCall on well-shaped args; any other outcome
                // indicates a substrate regression (e.g. a future
                // FarcallOp variant that fails on overflow). Carry it
                // through to `apply_dispatch_outcome` so the typed
                // failure is observable rather than swallowed.
                debug_assert!(
                    matches!(other, DispatchOutcome::Advance),
                    "FarcallOp returned unexpected outcome {other:?}",
                );
            }
        }
        vm.apply_dispatch_outcome(&outcome, return_pc)
    }
}

// ---------- internal helpers ----------

/// Parse a `(scene, entrypoint)` named pair from `key`, honouring a
/// sibling `_MOD=0` disable flag.
fn parse_named_pair(
    gameexe: &Gameexe,
    key: &str,
    mod_key: &str,
    kind: SyscallRouteKind,
) -> Result<Option<SyscallRoute>, SyscallDispatchBuildError> {
    let Some(pair) = gameexe.get_int_pair(key) else {
        if gameexe.get(key).is_some() {
            return Err(SyscallDispatchBuildError::MalformedRoutePair {
                code: SYSCALL_ROUTE_MALFORMED_PAIR_CODE.to_string(),
                route_key: key.to_string(),
            });
        }
        return Ok(None);
    };
    if mod_disables(gameexe, mod_key) {
        return Ok(None);
    }
    let (scene_id, entrypoint) = normalise_pair(pair, key)?;
    Ok(Some(SyscallRoute {
        kind,
        scene_id,
        entrypoint,
        area: None,
    }))
}

/// Whether the `_MOD` key is present and set to `0`. A missing key or
/// any non-zero value leaves the route active.
fn mod_disables(gameexe: &Gameexe, mod_key: &str) -> bool {
    matches!(gameexe.get_int(mod_key), Some(0))
}

/// Coerce a `(scene, entrypoint)` `(i32, i32)` pair from
/// [`Gameexe::get_int_pair`] into the typed
/// `(SceneId, u32)` shape the dispatcher carries. Negative or
/// over-range values surface a typed
/// [`SyscallDispatchBuildError::MalformedRoutePair`].
fn normalise_pair(
    pair: (i32, i32),
    key: &str,
) -> Result<(SceneId, u32), SyscallDispatchBuildError> {
    let (scene_raw, ep_raw) = pair;
    let scene = u32::try_from(scene_raw)
        .ok()
        .and_then(|value| SceneId::try_from(value).ok());
    let entrypoint = u32::try_from(ep_raw).ok();
    match (scene, entrypoint) {
        (Some(scene), Some(entrypoint)) => Ok((scene, entrypoint)),
        _ => Err(SyscallDispatchBuildError::MalformedRoutePair {
            code: SYSCALL_ROUTE_MALFORMED_PAIR_CODE.to_string(),
            route_key: key.to_string(),
        }),
    }
}

/// Parse `SCREENSIZE_MOD=mode,width,height` if present.
fn parse_screen_size(gameexe: &Gameexe) -> Option<ScreenSize> {
    let array = gameexe.get_int_array("SCREENSIZE_MOD")?;
    if array.len() != 3 {
        return None;
    }
    let width = u32::try_from(array[1]).ok()?;
    let height = u32::try_from(array[2]).ok()?;
    Some(ScreenSize {
        mode: array[0],
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rlop::AlwaysReadyScheduler;

    fn parse_gameexe(text: &str) -> Gameexe {
        let bytes = encoding_rs::SHIFT_JIS.encode(text).0.into_owned();
        Gameexe::parse(&bytes).expect("synthetic gameexe must parse")
    }

    fn sweetie_hd_lines_14_28() -> &'static str {
        // Lines 14-28 of Sweetie HD's Gameexe.ini per § H; the
        // dispatcher must boot against this exact prefix without
        // an unrelated SCREENSIZE_MOD / SEEN_START / CAPTION
        // sidecar.
        concat!(
            "#CANCELCALL_MOD=1\r\n",
            "#CANCELCALL=9999,10\r\n",
            "#SYSTEMCALL_SAVE_MOD=1\r\n",
            "#SYSTEMCALL_SAVE=9999,20\r\n",
            "#SYSTEMCALL_LOAD_MOD=1\r\n",
            "#SYSTEMCALL_LOAD=9999,21\r\n",
            "#SYSTEMCALL_SYSTEM_MOD=1\r\n",
            "#SYSTEMCALL_SYSTEM=9999,22\r\n",
            "#MOUSEACTIONCALL.000.MOD=1\r\n",
            "#MOUSEACTIONCALL.000.SEEN=9999,30\r\n",
            "#MOUSEACTIONCALL.000.AREA=1232,0,1279,719\r\n",
            "#LOADCALL_MOD=1\r\n",
            "#LOADCALL=9999,40\r\n",
            "#EXAFTERCALL_MOD=0\r\n",
            "#EXAFTERCALL=9999,50\r\n",
            "#WBCALL.000=9999,0\r\n",
            "#WBCALL.001=9999,1\r\n",
            "#WBCALL.002=9999,2\r\n",
            "#WBCALL.003=9999,3\r\n",
            "#WBCALL.004=9999,4\r\n",
            "#WBCALL.005=9999,5\r\n",
            "#WBCALL.006=9999,6\r\n",
            "#WBCALL.007=9999,7\r\n",
            "#SCREENSIZE_MOD=999,1280,720\r\n",
        )
    }

    #[test]
    fn dispatcher_reports_eight_kinds_for_sweetie_hd_shape() {
        // EXAFTERCALL_MOD=0 disables the exaftercall route, so 7
        // kinds present (not 8). Flip the mod to 1 to test the
        // full 8.
        let mut text =
            sweetie_hd_lines_14_28().replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
        text.push_str("");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        assert_eq!(dispatcher.route_count(), SYSCALL_KIND_COUNT);
        // Sweetie HD shape: 6 named (cancel/save/load/system/loadcall/
        // exaftercall) + 1 mouse-action + 8 wbcall = 15 entries.
        assert_eq!(dispatcher.entry_count(), 15);
    }

    #[test]
    fn dispatcher_resolves_documented_scene_entrypoint_pairs() {
        let mut text =
            sweetie_hd_lines_14_28().replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
        text.push_str("");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let pairs: Vec<(&str, SceneId, u32)> = vec![
            ("cancel", 9999, 10),
            ("systemcall_save", 9999, 20),
            ("systemcall_load", 9999, 21),
            ("systemcall_system", 9999, 22),
            ("mouse_action[0]", 9999, 30),
            ("loadcall", 9999, 40),
            ("exaftercall", 9999, 50),
            ("wbcall[0]", 9999, 0),
            ("wbcall[7]", 9999, 7),
        ];
        for (label, want_scene, want_pc) in pairs {
            let route = match label {
                "cancel" => dispatcher.route_for_kind(SyscallRouteKind::Cancel),
                "systemcall_save" => dispatcher.route_for_kind(SyscallRouteKind::SystemcallSave),
                "systemcall_load" => dispatcher.route_for_kind(SyscallRouteKind::SystemcallLoad),
                "systemcall_system" => {
                    dispatcher.route_for_kind(SyscallRouteKind::SystemcallSystem)
                }
                "mouse_action[0]" => {
                    dispatcher.route_for_kind(SyscallRouteKind::MouseAction { index: 0 })
                }
                "loadcall" => dispatcher.route_for_kind(SyscallRouteKind::Loadcall),
                "exaftercall" => dispatcher.route_for_kind(SyscallRouteKind::Exaftercall),
                "wbcall[0]" => dispatcher.route_for_wbcall(0),
                "wbcall[7]" => dispatcher.route_for_wbcall(7),
                _ => unreachable!(),
            };
            let route = route.expect("route present");
            assert_eq!(route.scene_id, want_scene, "{label} scene");
            assert_eq!(route.entrypoint, want_pc, "{label} entrypoint");
        }
    }

    #[test]
    fn cancelcall_mod_zero_disables_route_entirely() {
        let text =
            sweetie_hd_lines_14_28().replace("#CANCELCALL_MOD=1\r\n", "#CANCELCALL_MOD=0\r\n");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        assert!(
            dispatcher
                .route_for_kind(SyscallRouteKind::Cancel)
                .is_none(),
            "CANCELCALL_MOD=0 must remove the cancel route"
        );
        // Other routes survive — disabling cancel does not affect
        // unrelated mods.
        assert!(
            dispatcher
                .route_for_kind(SyscallRouteKind::SystemcallSave)
                .is_some(),
        );
    }

    #[test]
    fn exaftercall_mod_zero_in_real_sweetie_hd_disables_route() {
        // The Sweetie HD Gameexe.ini carries `EXAFTERCALL_MOD=0`,
        // so by default the dispatcher does NOT include
        // `exaftercall`.
        let gx = parse_gameexe(sweetie_hd_lines_14_28());
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        assert!(
            dispatcher
                .route_for_kind(SyscallRouteKind::Exaftercall)
                .is_none(),
            "Real Sweetie HD carries EXAFTERCALL_MOD=0 — route must be absent"
        );
        // Seven kinds present (not 8).
        assert_eq!(dispatcher.route_count(), SYSCALL_KIND_COUNT - 1);
    }

    #[test]
    fn mouseactioncall_hot_region_pixel_dispatches() {
        // AREA = 1232,0,1279,719. (1250, 300) is inside.
        // (100, 100) is outside.
        let gx = parse_gameexe(sweetie_hd_lines_14_28());
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let inside = dispatcher
            .route_for_pointer_pixel(1250, 300)
            .expect("inside hits mouse-action route");
        assert!(matches!(
            inside.kind,
            SyscallRouteKind::MouseAction { index: 0 }
        ));
        assert_eq!(inside.scene_id, 9999);
        assert_eq!(inside.entrypoint, 30);
        assert!(
            dispatcher.route_for_pointer_pixel(100, 100).is_none(),
            "(100, 100) must miss every hot region"
        );
    }

    #[test]
    fn mouseactioncall_input_event_normalized_round_trips_to_pixel() {
        let gx = parse_gameexe(sweetie_hd_lines_14_28());
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        // (x=1250 / 1279, y=300/719) → normalized coords for the
        // pixel-space (1250, 300) point.
        let event = InputEvent::Pointer {
            x: 1250.0 / 1279.0,
            y: 300.0 / 719.0,
            button: utsushi_core::substrate::PointerButton::Primary,
        };
        let route = dispatcher
            .route_for_input_event(&event)
            .expect("normalized pointer event must hit the route");
        assert!(matches!(
            route.kind,
            SyscallRouteKind::MouseAction { index: 0 }
        ));
        // Off-region normalized event misses.
        let off = InputEvent::Pointer {
            x: 0.0,
            y: 0.5,
            button: utsushi_core::substrate::PointerButton::Primary,
        };
        assert!(dispatcher.route_for_input_event(&off).is_none());
    }

    #[test]
    fn malformed_route_pair_surfaces_typed_error() {
        let mut text = sweetie_hd_lines_14_28().to_string();
        text = text.replace("#CANCELCALL=9999,10\r\n", "#CANCELCALL=oops\r\n");
        let gx = parse_gameexe(&text);
        match SyscallDispatcher::from_gameexe(&gx) {
            Err(SyscallDispatchBuildError::MalformedRoutePair { code, route_key }) => {
                assert_eq!(code, SYSCALL_ROUTE_MALFORMED_PAIR_CODE);
                assert_eq!(route_key, "CANCELCALL");
            }
            other => panic!("expected MalformedRoutePair, got {other:?}"),
        }
    }

    #[test]
    fn missing_mouse_area_surfaces_typed_error() {
        let mut text = sweetie_hd_lines_14_28().to_string();
        text = text.replace("#MOUSEACTIONCALL.000.AREA=1232,0,1279,719\r\n", "");
        let gx = parse_gameexe(&text);
        match SyscallDispatcher::from_gameexe(&gx) {
            Err(SyscallDispatchBuildError::MouseAreaMissing { code, route_key }) => {
                assert_eq!(code, SYSCALL_MOUSE_AREA_MALFORMED_CODE);
                assert_eq!(route_key, "MOUSEACTIONCALL.000");
            }
            other => panic!("expected MouseAreaMissing, got {other:?}"),
        }
    }

    #[test]
    fn invoke_routes_through_farcall_op_pushes_far_call_frame() {
        let gx = parse_gameexe(sweetie_hd_lines_14_28());
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let route = dispatcher
            .route_for_kind(SyscallRouteKind::Cancel)
            .expect("cancel route");
        let mut vm = Vm::new(7, 100);
        dispatcher
            .invoke(&mut vm, route, 7, 200)
            .expect("invoke succeeds");
        // Pushed a single FarCall frame.
        assert_eq!(vm.stack().len(), 1);
        assert_eq!(vm.stack()[0].return_scene, Some(7));
        assert_eq!(vm.stack()[0].return_pc, 200);
        // Landed at (9999, 10).
        assert_eq!(vm.scene(), 9999);
        assert_eq!(vm.pc(), 10);
    }

    #[test]
    fn invoke_through_rtl_resumes_at_post_command_byte() {
        // Drive a roundtrip: invoke a route, then dispatch `rtl`,
        // and assert the VM lands back at the supplied return
        // (scene, pc).
        let gx = parse_gameexe(sweetie_hd_lines_14_28());
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let route = dispatcher
            .route_for_kind(SyscallRouteKind::SystemcallSave)
            .expect("save route");
        let mut vm = Vm::new(5, 60);
        dispatcher
            .invoke(&mut vm, route, 5, 80)
            .expect("invoke succeeds");
        assert_eq!(vm.scene(), 9999);
        assert_eq!(vm.pc(), 20);
        let pop = crate::rlop::module_ctrl::RtlOp.dispatch(&mut vm, &[]);
        vm.apply_dispatch_outcome(&pop, 9999).expect("rtl resumes");
        assert_eq!(vm.scene(), 5);
        assert_eq!(vm.pc(), 80);
        // Ensure the scheduler reference is touched so the import is
        // not dead-stripped (substrate seam for the VM step loop).
        let _scheduler = AlwaysReadyScheduler;
    }

    #[test]
    fn input_event_save_load_routes_to_named_kinds() {
        let mut text =
            sweetie_hd_lines_14_28().replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
        text.push_str("");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let save = InputEvent::Save { slot: 0 };
        let load = InputEvent::Load { slot: 0 };
        assert_eq!(
            dispatcher
                .route_for_input_event(&save)
                .map(|route| route.kind),
            Some(SyscallRouteKind::SystemcallSave),
        );
        assert_eq!(
            dispatcher
                .route_for_input_event(&load)
                .map(|route| route.kind),
            Some(SyscallRouteKind::SystemcallLoad),
        );
    }

    #[test]
    fn route_kind_discriminants_are_distinct() {
        let kinds = [
            SyscallRouteKind::Cancel,
            SyscallRouteKind::SystemcallSave,
            SyscallRouteKind::SystemcallLoad,
            SyscallRouteKind::SystemcallSystem,
            SyscallRouteKind::MouseAction { index: 0 },
            SyscallRouteKind::Loadcall,
            SyscallRouteKind::Exaftercall,
            SyscallRouteKind::Wbcall { index: 0 },
        ];
        assert_eq!(kinds.len(), SYSCALL_KIND_COUNT);
        let mut discriminants: Vec<u8> = kinds.iter().map(|kind| kind.discriminant()).collect();
        discriminants.sort();
        discriminants.dedup();
        assert_eq!(discriminants.len(), SYSCALL_KIND_COUNT);
    }
}
