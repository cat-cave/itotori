//! System-call dispatch wired to Gameexe routes.
//!
//! Builds a typed dispatch table from the RealLive syscall routes
//! documented in `docs/research/reallive-engine.md` § H, then
//! lowers a substrate [`InputEvent`] or a pixel-space pointer-move into
//! a [`SyscallRoute`] that the VM event loop invokes through the
//! [`FarcallOp`]. No private dispatch path — every route
//! invocation goes through the existing control-flow [`FarcallOp`]
//! so the call stack, frame-kind discipline, and stack-depth ceiling
//! are reused verbatim (acceptance criterion #4).
//!
//! # Route kinds
//!
//! The dispatcher recognises **eight** route kinds covering § H:
//!
//! Kind | Gameexe key | `_MOD` key
//! --------------------------------- | -------------------------------- | --------------------------
//! [`SyscallRouteKind::Cancel`] | `CANCELCALL` | `CANCELCALL_MOD`
//! [`SyscallRouteKind::SystemcallSave`] | `SYSTEMCALL_SAVE` | `SYSTEMCALL_SAVE_MOD`
//! [`SyscallRouteKind::SystemcallLoad`] | `SYSTEMCALL_LOAD` | `SYSTEMCALL_LOAD_MOD`
//! [`SyscallRouteKind::SystemcallSystem`] | `SYSTEMCALL_SYSTEM` | `SYSTEMCALL_SYSTEM_MOD`
//! [`SyscallRouteKind::MouseAction`] | `MOUSEACTIONCALL.NNN.SEEN`+`AREA` | `MOUSEACTIONCALL.NNN.MOD`
//! [`SyscallRouteKind::Loadcall`] | `LOADCALL` | `LOADCALL_MOD`
//! [`SyscallRouteKind::Exaftercall`] | `EXAFTERCALL` | `EXAFTERCALL_MOD`
//! [`SyscallRouteKind::Wbcall`] | `WBCALL.NNN` | none (always active)
//!
//! The `MOUSEACTIONCALL.NNN` and `WBCALL.NNN` namespaces are enumerated
//! straight from the parsed Gameexe tree, so a game may declare any
//! number of pointer hot-regions and window-button callbacks. The route
//! count ([`SyscallDispatcher::route_count`]) reports the kind-distinct
//! total, which the acceptance criterion pins as "the dispatcher reports
//! its known routes"; the per-instance entry total varies with how many
//! `MOUSEACTIONCALL`/`WBCALL` slots the game declares.
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
//!   [`FarcallOp`] (see [`SyscallDispatcher::invoke`]).
//! - `_MOD=0` masks the route at parse time so a stale Gameexe with a
//!   disabled route cannot accidentally fire — the entry is not even
//!   in the table.

mod types;
mod wbcall;
pub use types::{
    HotRegion, SYSCALL_KIND_COUNT, SYSCALL_MISSING_SCREEN_SIZE_CODE,
    SYSCALL_MOUSE_AREA_MALFORMED_CODE, SYSCALL_ROUTE_MALFORMED_PAIR_CODE, ScreenSize,
    SyscallDispatchBuildError, SyscallDispatchError, SyscallRoute, SyscallRouteKind,
};
use wbcall::{append_wbcall_routes, normalise_pair};

use utsushi_core::substrate::InputEvent;

use crate::gameexe::Gameexe;
use crate::rlop::module_ctrl::FarcallOp;
use crate::rlop::{DispatchOutcome, ExprValue, RLOperation};
use crate::vm::{SceneId, Vm, VmError};

/// Typed dispatcher built from a parsed [`Gameexe`] tree. Holds the
/// six named scalar routes plus every declared `MOUSEACTIONCALL.NNN`
/// pointer hot-region and `WBCALL.NNN` window-button slot, and the
/// screen size used by the pointer normalization round-trip.
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

        // The six named scalar routes whose `_MOD` key gates them.
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

        // MOUSEACTIONCALL.NNN routes — enumerate the whole bounded
        // namespace. `NNN` is a `u8` index (see
        // [`SyscallRouteKind::MouseAction`]), so every addressable
        // slot is `000..=255`; the scan walks all of them and simply
        // skips absent slots rather than stopping at the first gap.
        // This keeps sparse, non-contiguous tables (e.g. `000` and
        // `002` present with `001` absent) fully discovered — the
        // namespace is enumerated by checking each slot, never by
        // trusting a "last index" sentinel.
        for index in 0..=u8::MAX {
            let seen_key = format!("MOUSEACTIONCALL.{index:03}.SEEN");
            let area_key = format!("MOUSEACTIONCALL.{index:03}.AREA");
            let mod_key = format!("MOUSEACTIONCALL.{index:03}.MOD");
            let Some(pair) = gameexe.get_int_pair(&seen_key) else {
                // No SEEN at this index — check it really is absent
                // (rather than malformed), then skip this slot and
                // keep scanning the rest of the namespace.
                if gameexe.get(&seen_key).is_some() {
                    return Err(SyscallDispatchBuildError::MalformedRoutePair {
                        code: SYSCALL_ROUTE_MALFORMED_PAIR_CODE.to_string(),
                        route_key: seen_key,
                    });
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

        append_wbcall_routes(gameexe, &mut routes)?;

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

    /// Number of *kind-distinct* routes the dispatcher carries, capped by
    /// [`SYSCALL_KIND_COUNT`]. Pinned by the real-bytes acceptance test
    /// (`syscall_routes_match_reallive_real_bytes`).
    pub fn route_count(&self) -> usize {
        let mut seen = [false; SYSCALL_KIND_COUNT];
        for route in &self.routes {
            seen[route.kind.discriminant() as usize] = true;
        }
        seen.iter().filter(|present| **present).count()
    }

    /// Total entry count: the six named scalar routes plus every declared
    /// `MOUSEACTIONCALL.NNN` and `WBCALL.NNN` slot, minus any `_MOD=0`-
    /// disabled entries.
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
    /// - [`InputEvent::MenuSelect`] with `menu_id == "system"`
    ///   `item_id == "cancel" | "system" | "loadcall" | "exaftercall"`
    ///   → the matching kind.
    /// - [`InputEvent::Pointer`] → first MOUSEACTIONCALL hot region the
    ///   normalized → pixel-space conversion lands inside.
    ///
    /// Unrecognised events return `Ok(None)`. `WBCALL` routes are
    /// addressed through [`Self::route_for_wbcall`] — they fire from
    /// engine-side window-button hits rather than substrate
    /// `InputEvent`s.
    ///
    /// # Errors
    ///
    /// - [`SyscallDispatchError::MissingScreenSize`] — a pointer event
    ///   arrived while a `MOUSEACTIONCALL` hot-region route is
    ///   registered but `SCREENSIZE_MOD` is missing or malformed, so
    ///   the normalized → pixel conversion cannot run. The dispatcher
    ///   surfaces the typed diagnostic rather than silently dropping
    ///   the pointer event.
    pub fn route_for_input_event(
        &self,
        event: &InputEvent,
    ) -> Result<Option<&SyscallRoute>, SyscallDispatchError> {
        let route = match event {
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
                let Some(screen) = self.screen_size else {
                    // `SCREENSIZE_MOD` is missing or malformed. If a
                    // hot-region route is registered the pointer event
                    // would otherwise vanish without a diagnostic — the
                    // exact silent-skip the audit finding pins. Surface
                    // the typed code instead of guessing a screen size.
                    if self.has_pointer_route() {
                        return Err(SyscallDispatchError::MissingScreenSize {
                            code: SYSCALL_MISSING_SCREEN_SIZE_CODE.to_string(),
                        });
                    }
                    // No hot-region route exists, so the missing screen
                    // size disables nothing — the pointer genuinely has
                    // no route to fire.
                    return Ok(None);
                };
                let (x_px, y_px) = screen.pointer_to_pixel(*x, *y);
                self.route_for_pointer_pixel(x_px, y_px)
            }
            _ => None,
        };
        Ok(route)
    }

    /// Whether the dispatch table carries at least one
    /// `MOUSEACTIONCALL` hot-region route — i.e. a pointer event could
    /// dispatch if the screen size were known.
    fn has_pointer_route(&self) -> bool {
        self.routes.iter().any(|route| route.area.is_some())
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

    /// Invoke a route through the [`FarcallOp`]. The VM
    /// pushes a `FarCall` frame and jumps to `(route.scene_id
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
        // The FarcallOp surface is documented to return FarCall on
        // well-shaped args. Any other outcome indicates a substrate
        // regression (e.g. a future FarcallOp variant that fails on
        // overflow). Surface it as a typed error in *all* build profiles
        // rather than forwarding it to `apply_dispatch_outcome` — a bare
        // `debug_assert` would let release builds silently apply the
        // unexpected outcome and corrupt control flow with no diagnostic.
        let outcome = require_far_call_outcome(&outcome, route.scene_id, return_pc)?;
        vm.apply_dispatch_outcome(outcome, return_pc)
    }
}

/// Stable diagnostic token for a [`DispatchOutcome`] variant. Used to
/// name the unexpected outcome in [`VmError::UnexpectedDispatchOutcome`]
/// without leaking the `Debug` form.
fn dispatch_outcome_token(outcome: &DispatchOutcome) -> &'static str {
    match outcome {
        DispatchOutcome::Advance => "advance",
        DispatchOutcome::Jump { .. } => "jump",
        DispatchOutcome::Subroutine { .. } => "subroutine",
        DispatchOutcome::FarCall { .. } => "far_call",
        DispatchOutcome::JumpToScene { .. } => "jump_to_scene",
        DispatchOutcome::FarCallToScene { .. } => "far_call_to_scene",
        DispatchOutcome::Return => "return",
        DispatchOutcome::ReturnFromCall => "return_from_call",
        DispatchOutcome::Yield { .. } => "yield",
        DispatchOutcome::Halt => "halt",
    }
}

/// Require that `FarcallOp` produced a [`DispatchOutcome::FarCall`].
/// Returns the borrowed outcome for application, or a typed
/// [`VmError::UnexpectedDispatchOutcome`] for any other shape.
///
/// Pulled out of [`SyscallDispatcher::invoke`] as a pure helper so the
/// regression test can feed a synthetic non-`FarCall` outcome: the live
/// `invoke` path always passes four well-typed `Int` args, so `FarcallOp`
/// cannot currently produce any other shape there.
fn require_far_call_outcome(
    outcome: &DispatchOutcome,
    route_scene: SceneId,
    return_pc: u32,
) -> Result<&DispatchOutcome, VmError> {
    match outcome {
        DispatchOutcome::FarCall { .. } => Ok(outcome),
        other => Err(VmError::UnexpectedDispatchOutcome {
            scene: route_scene,
            pc: return_pc,
            expected: "far_call",
            found: dispatch_outcome_token(other),
        }),
    }
}

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

/// Parse `SCREENSIZE_MOD=mode,width,height` if present.
///
/// A degenerate dimension (`width == 0` or `height == 0`) is treated as
/// malformed and yields `None`, exactly as an absent or non-3-int
/// `SCREENSIZE_MOD` does. A zero dimension cannot index a pixel grid:
/// [`ScreenSize::pointer_to_pixel`] would collapse that axis to `0`
/// silently mis-routing or vanishing every pointer hot-region dispatch.
/// Returning `None` instead routes the case through the existing
/// [`SyscallDispatchError::MissingScreenSize`] guard so the defect
/// surfaces as a typed diagnostic rather than corrupting dispatch.
fn parse_screen_size(gameexe: &Gameexe) -> Option<ScreenSize> {
    let array = gameexe.get_int_array("SCREENSIZE_MOD")?;
    if array.len() != 3 {
        return None;
    }
    let width = u32::try_from(array[1]).ok()?;
    let height = u32::try_from(array[2]).ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some(ScreenSize {
        mode: array[0],
        width,
        height,
    })
}

#[cfg(test)]
#[path = "syscall_tests.rs"]
mod tests;
