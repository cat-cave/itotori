//! WBCALL namespace enumeration and validation for the syscall dispatcher.

use super::{
    SYSCALL_ROUTE_MALFORMED_PAIR_CODE, SceneId, SyscallDispatchBuildError, SyscallRoute,
    SyscallRouteKind,
};
use crate::gameexe::Gameexe;

/// Add every declared `WBCALL.NNN` window-button route to `routes`.
///
/// RealLive imposes no fixed slot count here (the engine indexes
/// `WBCALL` by the buttons a window declares), so every declared,
/// well-shaped index is registered rather than walking a hardcoded
/// window. A declared key that is not a bare `WBCALL.NNN` scalar route
/// — a stray `WBCALL` with no index, non-numeric digits, or an index
/// that overflows the slot-index type — surfaces a `MalformedRoutePair`
/// rather than being silently dropped.
pub(super) fn append_wbcall_routes(
    gameexe: &Gameexe,
    routes: &mut Vec<SyscallRoute>,
) -> Result<(), SyscallDispatchBuildError> {
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
    Ok(())
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
/// [`Gameexe::get_int_pair`] into the typed `(SceneId, u32)` shape the
/// dispatcher carries. Negative or over-range values surface a typed
/// [`SyscallDispatchBuildError::MalformedRoutePair`].
pub(super) fn normalise_pair(
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
