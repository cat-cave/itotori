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
pub use types::{
    HotRegion, SYSCALL_KIND_COUNT, SYSCALL_MISSING_SCREEN_SIZE_CODE,
    SYSCALL_MOUSE_AREA_MALFORMED_CODE, SYSCALL_ROUTE_MALFORMED_PAIR_CODE, ScreenSize,
    SyscallDispatchBuildError, SyscallDispatchError, SyscallRoute, SyscallRouteKind,
};

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

        // WBCALL.NNN window-button routes — enumerate the namespace the
        // game actually declares straight from the Gameexe tree. RealLive
        // imposes no fixed slot count here (the engine indexes `WBCALL` by
        // the buttons a window declares), so every declared, well-shaped
        // index is registered rather than walking a hardcoded window. A
        // declared key that is not a bare `WBCALL.NNN` scalar route — a
        // stray `WBCALL` with no index, non-numeric digits, or an index
        // that overflows the slot-index type — surfaces a typed
        // `MalformedRoutePair` rather than being silently dropped.
        for key in gameexe.list_namespace("WBCALL") {
            let Some(index) = parse_wbcall_index(key) else {
                return Err(SyscallDispatchBuildError::MalformedRoutePair {
                    code: SYSCALL_ROUTE_MALFORMED_PAIR_CODE.to_string(),
                    route_key: key.to_string(),
                });
            };
            let Some(pair) = gameexe.get_int_pair(key) else {
                return Err(SyscallDispatchBuildError::MalformedRoutePair {
                    code: SYSCALL_ROUTE_MALFORMED_PAIR_CODE.to_string(),
                    route_key: key.to_string(),
                });
            };
            let (scene_id, entrypoint) = normalise_pair(pair, key)?;
            routes.push(SyscallRoute {
                kind: SyscallRouteKind::Wbcall { index },
                scene_id,
                entrypoint,
                area: None,
            });
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

/// Parse the `NNN` slot index out of a declared `WBCALL.NNN` namespace
/// key (already upper-cased by the Gameexe key normaliser). Returns
/// `None` when the key is not a bare `WBCALL.<digits>` scalar route —
/// a stray `WBCALL` with no index, a non-numeric suffix, or an index
/// that overflows the slot-index type — so the caller can surface a
/// typed diagnostic instead of silently dropping the declared key.
fn parse_wbcall_index(key: &str) -> Option<u8> {
    let suffix = key.strip_prefix("WBCALL.")?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    suffix.parse::<u8>().ok()
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
mod tests {
    use super::*;
    use crate::rlop::AlwaysReadyScheduler;

    fn parse_gameexe(text: &str) -> Gameexe {
        let bytes = encoding_rs::SHIFT_JIS.encode(text).0.into_owned();
        Gameexe::parse(&bytes).expect("synthetic gameexe must parse")
    }

    // Synthetic § H route shape used by the unit tests. Deliberately
    // authored at an 800x600 screen (NOT any staged corpus resolution)
    // with a right-edge hot region, so the pointer round-trip proves the
    // dispatcher works at whatever screen size the game declares — the
    // geometry is driven by `SCREENSIZE_MOD`, never a baked-in canvas.
    const SCREEN_W: u32 = 800;
    const SCREEN_H: u32 = 600;
    const SCREENSIZE_LINE: &str = "#SCREENSIZE_MOD=1,800,600\r\n";

    fn reallive_real_bytes_lines_14_28() -> &'static str {
        // The § H syscall route prefix; the dispatcher must boot against
        // it without an unrelated SEEN_START / CAPTION sidecar.
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
            "#MOUSEACTIONCALL.000.AREA=752,0,799,599\r\n",
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
            "#SCREENSIZE_MOD=1,800,600\r\n",
        )
    }

    #[test]
    fn dispatcher_reports_eight_kinds_for_reallive_real_bytes_shape() {
        // EXAFTERCALL_MOD=0 disables the exaftercall route, so 7
        // kinds present (not 8). Flip the mod to 1 to test the
        // full 8.
        let mut text = reallive_real_bytes_lines_14_28()
            .replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
        text.push_str("");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        assert_eq!(dispatcher.route_count(), SYSCALL_KIND_COUNT);
        // § H shape: 6 named (cancel/save/load/system/loadcall/
        // exaftercall) + 1 mouse-action + 8 wbcall = 15 entries.
        assert_eq!(dispatcher.entry_count(), 15);
    }

    #[test]
    fn dispatcher_resolves_documented_scene_entrypoint_pairs() {
        let mut text = reallive_real_bytes_lines_14_28()
            .replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
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
    fn mouseactioncall_scan_discovers_non_contiguous_indices() {
        // A sparse MOUSEACTIONCALL namespace: `000` and `002` are
        // present but `001` is absent. The scan must not stop at the
        // gap — both `000` and `002` have to be discovered, while the
        // missing `001` stays unrouted.
        let mut text = reallive_real_bytes_lines_14_28().to_string();
        text.push_str("#MOUSEACTIONCALL.002.MOD=1\r\n");
        text.push_str("#MOUSEACTIONCALL.002.SEEN=9999,32\r\n");
        text.push_str("#MOUSEACTIONCALL.002.AREA=10,20,30,40\r\n");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");

        let route0 = dispatcher
            .route_for_kind(SyscallRouteKind::MouseAction { index: 0 })
            .expect("index 000 must be discovered");
        assert_eq!(route0.entrypoint, 30, "index 000 entrypoint");

        let route2 = dispatcher
            .route_for_kind(SyscallRouteKind::MouseAction { index: 2 })
            .expect("index 002 must be discovered past the 001 gap");
        assert_eq!(route2.entrypoint, 32, "index 002 entrypoint");

        assert!(
            dispatcher
                .route_for_kind(SyscallRouteKind::MouseAction { index: 1 })
                .is_none(),
            "absent index 001 must stay unrouted",
        );
    }

    #[test]
    fn cancelcall_mod_zero_disables_route_entirely() {
        let text = reallive_real_bytes_lines_14_28()
            .replace("#CANCELCALL_MOD=1\r\n", "#CANCELCALL_MOD=0\r\n");
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
    fn exaftercall_mod_zero_in_real_bytes_disables_route() {
        // The § H fixture carries `EXAFTERCALL_MOD=0`, so by default the
        // dispatcher does NOT include `exaftercall`.
        let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        assert!(
            dispatcher
                .route_for_kind(SyscallRouteKind::Exaftercall)
                .is_none(),
            "EXAFTERCALL_MOD=0 — route must be absent"
        );
        // Seven kinds present (not 8).
        assert_eq!(dispatcher.route_count(), SYSCALL_KIND_COUNT - 1);
        // Pin the *entry* count too, not only the kind count. The full
        // EXAFTERCALL_MOD=1 shape has 15 entries (6 named scalar + 1
        // MOUSEACTIONCALL + 8 WBCALL); disabling EXAFTERCALL drops exactly
        // one named scalar route, so the real-bytes EXAFTERCALL_MOD=0 path
        // must carry 14. The kind-count assertion alone would not catch a
        // regression that double-adds a route in this MOD=0 case.
        assert_eq!(dispatcher.entry_count(), 14);
    }

    #[test]
    fn mouseactioncall_hot_region_pixel_dispatches() {
        // AREA = 752,0,799,599. (780, 300) is inside.
        // (100, 100) is outside.
        let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let inside = dispatcher
            .route_for_pointer_pixel(780, 300)
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
        let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        // Normalized coords for the pixel-space (780, 300) point on the
        // fixture's declared 800x600 screen: divide by `dim - 1`.
        let event = InputEvent::Pointer {
            x: 780.0 / (SCREEN_W - 1) as f32,
            y: 300.0 / (SCREEN_H - 1) as f32,
            button: utsushi_core::substrate::PointerButton::Primary,
        };
        let route = dispatcher
            .route_for_input_event(&event)
            .expect("pointer dispatch must not error with a known screen size")
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
        assert!(
            dispatcher
                .route_for_input_event(&off)
                .expect("pointer dispatch must not error with a known screen size")
                .is_none()
        );
    }

    #[test]
    fn pointer_event_without_screen_size_emits_missing_diagnostic() {
        // Drop SCREENSIZE_MOD but keep the MOUSEACTIONCALL hot region.
        // A pointer event can no longer be lowered to pixel space, so
        // the dispatcher must surface the typed missing-screen-size
        // diagnostic rather than silently returning `None`.
        let text = reallive_real_bytes_lines_14_28().replace(SCREENSIZE_LINE, "");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        assert!(
            dispatcher.screen_size().is_none(),
            "SCREENSIZE_MOD was removed — screen size must be absent"
        );
        let event = InputEvent::Pointer {
            x: 0.5,
            y: 0.5,
            button: utsushi_core::substrate::PointerButton::Primary,
        };
        match dispatcher.route_for_input_event(&event) {
            Err(SyscallDispatchError::MissingScreenSize { code }) => {
                assert_eq!(code, SYSCALL_MISSING_SCREEN_SIZE_CODE);
            }
            other => panic!("expected MissingScreenSize diagnostic, got {other:?}"),
        }
    }

    #[test]
    fn zero_dimension_screen_size_is_rejected_not_silently_zeroed() {
        // A present-but-degenerate `SCREENSIZE_MOD` (a zero width or a
        // zero height) cannot index a pixel grid: the old path parsed
        // it into `ScreenSize { width: 0,.. }`, bypassing the
        // `MissingScreenSize` guard while `pointer_to_pixel` collapsed
        // that axis to `0` — silently mis-routing every pointer
        // hot-region dispatch. The corrected `parse_screen_size`
        // rejects the degenerate shape so the typed diagnostic fires.
        for degenerate in ["#SCREENSIZE_MOD=1,0,600\r\n", "#SCREENSIZE_MOD=1,800,0\r\n"] {
            let text = reallive_real_bytes_lines_14_28().replace(SCREENSIZE_LINE, degenerate);
            let gx = parse_gameexe(&text);
            let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
            assert!(
                dispatcher.screen_size().is_none(),
                "degenerate SCREENSIZE_MOD {degenerate:?} must not parse into a usable screen size"
            );
            // A pointer event that previously vanished into the zeroed
            // axis must now surface the typed missing-screen-size
            // diagnostic instead of silently corrupting dispatch.
            let event = InputEvent::Pointer {
                x: 780.0 / (SCREEN_W - 1) as f32,
                y: 300.0 / (SCREEN_H - 1) as f32,
                button: utsushi_core::substrate::PointerButton::Primary,
            };
            match dispatcher.route_for_input_event(&event) {
                Err(SyscallDispatchError::MissingScreenSize { code }) => {
                    assert_eq!(code, SYSCALL_MISSING_SCREEN_SIZE_CODE);
                }
                other => panic!(
                    "degenerate SCREENSIZE_MOD {degenerate:?} must surface MissingScreenSize, got {other:?}"
                ),
            }
        }
    }

    #[test]
    fn pointer_event_without_screen_size_or_hot_region_returns_none() {
        // No SCREENSIZE_MOD and no MOUSEACTIONCALL route: the missing
        // screen size disables no pointer dispatch, so the honest
        // answer is `Ok(None)` rather than a false-positive diagnostic.
        let mut text = reallive_real_bytes_lines_14_28()
            .replace(SCREENSIZE_LINE, "")
            .replace("#MOUSEACTIONCALL.000.MOD=1\r\n", "")
            .replace("#MOUSEACTIONCALL.000.SEEN=9999,30\r\n", "")
            .replace("#MOUSEACTIONCALL.000.AREA=752,0,799,599\r\n", "");
        text.push_str("");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let event = InputEvent::Pointer {
            x: 0.5,
            y: 0.5,
            button: utsushi_core::substrate::PointerButton::Primary,
        };
        assert!(matches!(dispatcher.route_for_input_event(&event), Ok(None)));
    }

    #[test]
    fn malformed_route_pair_surfaces_typed_error() {
        let mut text = reallive_real_bytes_lines_14_28().to_string();
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
        let mut text = reallive_real_bytes_lines_14_28().to_string();
        text = text.replace("#MOUSEACTIONCALL.000.AREA=752,0,799,599\r\n", "");
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
        let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
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
    fn wbcall_namespace_is_enumerated_not_capped_at_a_fixed_count() {
        // The dispatcher must register EVERY declared WBCALL slot, not a
        // hardcoded window: appending a 9th and 10th window-button slot
        // beyond the § H fixture's eight must extend the table, never
        // trip an artificial cap. This proves a RealLive game with a
        // different WBCALL count works.
        let mut text = reallive_real_bytes_lines_14_28().to_string();
        text.push_str("#WBCALL.008=9999,8\r\n");
        text.push_str("#WBCALL.009=9999,9\r\n");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        for index in 0u8..=9 {
            let route = dispatcher
                .route_for_wbcall(index)
                .unwrap_or_else(|| panic!("WBCALL.{index:03} must be registered"));
            assert_eq!(
                route.entrypoint, index as u32,
                "WBCALL.{index:03} entrypoint"
            );
        }
        // Exactly ten WBCALL entries — no phantom slots, none dropped.
        let wbcall_count = dispatcher
            .routes()
            .iter()
            .filter(|route| matches!(route.kind, SyscallRouteKind::Wbcall { .. }))
            .count();
        assert_eq!(wbcall_count, 10, "every declared WBCALL slot is registered");
    }

    #[test]
    fn wbcall_sparse_namespace_registers_only_declared_slots() {
        // A non-contiguous WBCALL namespace (declare 000, 002, 005; leave
        // 001/003/004 absent) must register exactly the declared slots —
        // enumeration follows the Gameexe, it neither fills gaps nor
        // stops at the first hole.
        let mut text: String = reallive_real_bytes_lines_14_28()
            .lines()
            .filter(|line| !line.starts_with("#WBCALL."))
            .collect::<Vec<_>>()
            .join("\r\n");
        text.push_str("\r\n#WBCALL.000=9999,100\r\n");
        text.push_str("#WBCALL.002=9999,102\r\n");
        text.push_str("#WBCALL.005=9999,105\r\n");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let mut declared: Vec<u8> = dispatcher
            .routes()
            .iter()
            .filter_map(|route| match route.kind {
                SyscallRouteKind::Wbcall { index } => Some(index),
                _ => None,
            })
            .collect();
        declared.sort_unstable();
        assert_eq!(
            declared,
            vec![0, 2, 5],
            "only declared WBCALL slots register"
        );
    }

    #[test]
    fn wbcall_malformed_pair_surfaces_typed_error_not_silent_drop() {
        // A declared WBCALL slot whose value is not a `(scene, entrypoint)`
        // pair must surface a typed diagnostic, never be silently dropped.
        let mut text = reallive_real_bytes_lines_14_28().to_string();
        text.push_str("#WBCALL.008=garbage\r\n");
        let gx = parse_gameexe(&text);
        match SyscallDispatcher::from_gameexe(&gx) {
            Err(SyscallDispatchBuildError::MalformedRoutePair { code, route_key }) => {
                assert_eq!(code, SYSCALL_ROUTE_MALFORMED_PAIR_CODE);
                assert_eq!(route_key, "WBCALL.008");
            }
            other => panic!("expected MalformedRoutePair, got: {other:?}"),
        }
    }

    #[test]
    fn require_far_call_outcome_rejects_non_far_call() {
        // The invoke() fallback must surface a typed error in *all*
        // build profiles (not a debug-only assert that silently advances
        // in release). Feed the pure helper a synthetic non-FarCall
        // outcome and assert the typed VmError.
        let advance = DispatchOutcome::Advance;
        match require_far_call_outcome(&advance, 9999, 200) {
            Err(VmError::UnexpectedDispatchOutcome {
                scene,
                pc,
                expected,
                found,
            }) => {
                assert_eq!(scene, 9999);
                assert_eq!(pc, 200);
                assert_eq!(expected, "far_call");
                assert_eq!(found, "advance");
            }
            other => panic!("expected UnexpectedDispatchOutcome, got: {other:?}"),
        }
        // A genuine FarCall outcome passes through unchanged.
        let far_call = DispatchOutcome::FarCall {
            return_scene: 1,
            return_pc: 2,
            target_scene: 3,
            target_pc: 4,
        };
        let passed = require_far_call_outcome(&far_call, 3, 2).expect("FarCall must pass through");
        assert!(matches!(passed, DispatchOutcome::FarCall { .. }));
    }

    #[test]
    fn invoke_through_rtl_resumes_at_post_command_byte() {
        // Drive a roundtrip: invoke a route, then dispatch `rtl`
        // and assert the VM lands back at the supplied return
        // (scene, pc).
        let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
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
        let _ = AlwaysReadyScheduler;
    }

    #[test]
    fn input_event_save_load_routes_to_named_kinds() {
        let mut text = reallive_real_bytes_lines_14_28()
            .replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
        text.push_str("");
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        let save = InputEvent::Save { slot: 0 };
        let load = InputEvent::Load { slot: 0 };
        assert_eq!(
            dispatcher
                .route_for_input_event(&save)
                .expect("save dispatch must not error")
                .map(|route| route.kind),
            Some(SyscallRouteKind::SystemcallSave),
        );
        assert_eq!(
            dispatcher
                .route_for_input_event(&load)
                .expect("load dispatch must not error")
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
        discriminants.sort_unstable();
        discriminants.dedup();
        assert_eq!(discriminants.len(), SYSCALL_KIND_COUNT);
    }
}
