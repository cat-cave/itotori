//! `utsushi-reallive-jump-resume` — deterministic jump / resume to a
//! `(scene, line, frame)` target for ANY RealLive project.
//!
//! A reviewer running the RealLive runtime needs to jump to a specific spot
//! and annotate it *reproducibly*: the same target must always land on the
//! identical frame / state so the annotation stays pinned. This module owns
//! the ENGINE-GENERAL, GAME-AGNOSTIC addressing model that makes that
//! possible — nothing here references a game, a title, or a hardcoded scene.
//!
//! # Addressing (resolved from the decode, never hardcoded)
//!
//! [`JumpTarget`] names a spot at one of three granularities, each resolvable
//! purely from the decoded scene-dispatch structure the runtime already owns:
//!
//! - [`JumpTarget::Scene`] — the start of a scene (`pc 0`). A positional seek
//!   via the decoded dispatch graph.
//! - [`JumpTarget::Line`] — a source line WITHIN a scene, addressed by the
//!   compiler's [`BytecodeElement::MetaLine`](crate::BytecodeElement::MetaLine)
//!   `line_number` marker. [`resolve_line_pc`] maps `(scene, line_number)` to
//!   the marker's byte-offset pc straight out of the decode. Also a positional
//!   seek.
//! - [`JumpTarget::Frame`] — the Nth rendered message/frame in the scene's
//!   DETERMINISTIC branch-following play-order stream. Reached by
//!   fast-forwarding the intervening execution
//!   ([`crate::ReplayEngine::jump_to`]).
//!
//! # Determinism + the reviewer seam
//!
//! [`crate::ReplayEngine::jump_to`] resolves a [`JumpTarget`] and drives the
//! runtime to it, returning a [`JumpLanding`]. The landing is a pure function
//! of `(store, target)` — the drive uses a deterministic headless input policy
//! and the fixed-seed clock/RNG — so jumping to the same target lands on the
//! identical `(scene, pc)` + [`Vm::control_fingerprint`](crate::Vm) every time.
//!
//! [`JumpTarget::address`] renders a stable, reproducible address string (and
//! [`JumpTarget::from_address`] parses it back), so a reviewer annotation can
//! pin to a target and RE-LAND on it in a later session. [`JumpLanding::anchor`]
//! pairs that address with the landed-state fingerprint — a fully reproducible
//! annotation anchor.

use serde::{Deserialize, Serialize};

use crate::bytecode_element::BytecodeElement;
use crate::vm::{Scene, SceneId};

/// URI scheme prefix every [`JumpTarget`] address carries. The `scene/`
/// segment always follows so a bare scene, a scene+line, and a scene+frame
/// share one parseable root.
pub const JUMP_ADDRESS_PREFIX: &str = "reallive://scene/";

/// A reproducible jump / resume target for the RealLive runtime, resolved
/// from the decoded scene structure (never a hardcoded game reference).
///
/// Serializes to a stable JSON shape and to a [`JumpTarget::address`] string,
/// so a reviewer annotation can persist the target and re-land on it in a
/// later session ([`JumpTarget::from_address`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JumpTarget {
    /// The start of `scene` (`pc 0`). A positional seek via the dispatch graph.
    Scene {
        /// Destination scene id.
        scene: SceneId,
    },
    /// A source LINE within `scene`, addressed by the compiler's
    /// [`BytecodeElement::MetaLine`](crate::BytecodeElement::MetaLine)
    /// `line_number`. Resolved to a byte-offset pc by [`resolve_line_pc`].
    Line {
        /// Scene the line lives in.
        scene: SceneId,
        /// Compiler source-line number (the `MetaLine` marker value).
        line_number: u16,
    },
    /// The Nth rendered message/FRAME (0-based) in `scene`'s deterministic
    /// branch-following play-order stream. Reached by fast-forwarding
    /// execution.
    Frame {
        /// Scene the play-order stream starts from.
        scene: SceneId,
        /// 0-based index into the deterministic play-order message stream.
        frame_index: usize,
    },
}

impl JumpTarget {
    /// The entry scene this target is addressed within. Every granularity
    /// roots at a scene, so a caller can validate the scene exists before
    /// resolving the finer address.
    pub fn entry_scene(&self) -> SceneId {
        match self {
            Self::Scene { scene } | Self::Line { scene, .. } | Self::Frame { scene, .. } => *scene,
        }
    }

    /// Render the stable, reproducible address string for this target. The
    /// reviewer seam: an annotation pins to this string and re-lands on it via
    /// [`Self::from_address`].
    ///
    /// - `reallive://scene/<scene>`
    /// - `reallive://scene/<scene>/line/<line_number>`
    /// - `reallive://scene/<scene>/frame/<frame_index>`
    pub fn address(&self) -> String {
        match self {
            Self::Scene { scene } => format!("{JUMP_ADDRESS_PREFIX}{scene}"),
            Self::Line { scene, line_number } => {
                format!("{JUMP_ADDRESS_PREFIX}{scene}/line/{line_number}")
            }
            Self::Frame { scene, frame_index } => {
                format!("{JUMP_ADDRESS_PREFIX}{scene}/frame/{frame_index}")
            }
        }
    }

    /// Parse an [`Self::address`] string back into a [`JumpTarget`]. Inverse of
    /// [`Self::address`] — round-trips exactly. Returns a typed
    /// [`JumpAddressError`] on any malformed input (never a silent default).
    pub fn from_address(address: &str) -> Result<Self, JumpAddressError> {
        let rest = address
            .strip_prefix(JUMP_ADDRESS_PREFIX)
            .ok_or_else(|| JumpAddressError::new(address, "missing 'reallive://scene/' prefix"))?;
        let mut parts = rest.split('/');
        let scene_str = parts
            .next()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| JumpAddressError::new(address, "missing scene id"))?;
        let scene: SceneId = scene_str
            .parse()
            .map_err(|_| JumpAddressError::new(address, "scene id is not a u16"))?;

        match parts.next() {
            None => Ok(Self::Scene { scene }),
            Some("line") => {
                let value = parts
                    .next()
                    .ok_or_else(|| JumpAddressError::new(address, "missing line number"))?;
                let line_number = value
                    .parse()
                    .map_err(|_| JumpAddressError::new(address, "line number is not a u16"))?;
                Self::ensure_end(address, parts)?;
                Ok(Self::Line { scene, line_number })
            }
            Some("frame") => {
                let value = parts
                    .next()
                    .ok_or_else(|| JumpAddressError::new(address, "missing frame index"))?;
                let frame_index = value
                    .parse()
                    .map_err(|_| JumpAddressError::new(address, "frame index is not an integer"))?;
                Self::ensure_end(address, parts)?;
                Ok(Self::Frame { scene, frame_index })
            }
            Some(other) => Err(JumpAddressError::new(
                address,
                format!("unknown granularity segment '{other}' (expected 'line' or 'frame')"),
            )),
        }
    }

    fn ensure_end<'a>(
        address: &str,
        mut parts: impl Iterator<Item = &'a str>,
    ) -> Result<(), JumpAddressError> {
        match parts.next() {
            None => Ok(()),
            Some(extra) => Err(JumpAddressError::new(
                address,
                format!("trailing address segment '{extra}'"),
            )),
        }
    }
}

/// The point the runtime landed on for a [`JumpTarget`], plus the reproducible
/// state identity a reviewer annotation pins to.
///
/// Two landings compare equal iff every field matches — so a test proves
/// determinism by asserting `jump_to(t) == jump_to(t)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpLanding {
    /// The target that was resolved.
    pub target: JumpTarget,
    /// Scene the runtime landed in.
    pub scene: SceneId,
    /// Byte-offset pc the runtime landed on within `scene`.
    pub pc: u32,
    /// The full deterministic VM state fingerprint at the landing point
    /// ([`Vm::control_fingerprint`](crate::Vm)). Identical across runs for the
    /// same target — the STATE identity a reviewer annotation pins to.
    pub control_fingerprint: u64,
    /// For a [`JumpTarget::Frame`] landing, the 0-based frame index reached;
    /// `None` for a positional (scene / line) seek.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_index: Option<usize>,
    /// For a [`JumpTarget::Frame`] landing, the message rendered at the landed
    /// frame — the exact text the reviewer sees on screen. `None` for a
    /// positional seek (which lands on a source position, not a rendered
    /// message).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landed_line: Option<utsushi_core::substrate::TextLine>,
    /// Steps the runtime fast-forwarded to reach the target (`0` for a
    /// positional seek, which lands without driving execution).
    pub steps_fast_forwarded: u32,
}

impl JumpLanding {
    /// The reproducible annotation anchor: the target address paired with the
    /// landed-state fingerprint. A reviewer annotation stores this string; a
    /// later session re-lands via [`JumpTarget::from_address`] and confirms the
    /// fingerprint matches, proving the annotation is still pinned to the same
    /// state.
    pub fn anchor(&self) -> String {
        format!(
            "{}@{:016x}",
            self.target.address(),
            self.control_fingerprint
        )
    }
}

/// Resolve a `(scene, line_number)` source-line address to the byte-offset pc
/// of that line's [`BytecodeElement::MetaLine`](crate::BytecodeElement::MetaLine)
/// marker, straight out of the decode. Returns `None` when the scene declares
/// no marker for `line_number` (so the caller surfaces a typed miss rather than
/// silently landing at `pc 0`).
///
/// Engine-general: consumes only the decoded element list every RealLive scene
/// carries; no game-specific knowledge.
pub fn resolve_line_pc(scene: &Scene, line_number: u16) -> Option<u32> {
    scene.elements.iter().find_map(|element| match element {
        BytecodeElement::MetaLine {
            line_number: n,
            byte_offset,
            ..
        } if *n == line_number => u32::try_from(*byte_offset).ok(),
        _ => None,
    })
}

/// Typed error resolving a [`JumpTarget`] against a runtime store.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JumpError {
    /// The target's scene is absent from the store.
    #[error("utsushi.reallive.jump.scene_not_found: scene={0}")]
    SceneNotFound(SceneId),
    /// The target named a source line the scene does not declare.
    #[error("utsushi.reallive.jump.line_not_found: scene={scene} line_number={line_number}")]
    LineNotFound {
        /// Scene the line was sought in.
        scene: SceneId,
        /// Requested source-line number.
        line_number: u16,
    },
    /// The deterministic play-order stream ended before the requested frame
    /// index — it emitted only `available` frames. Names how far the stream
    /// reached so a caller can clamp.
    #[error(
        "utsushi.reallive.jump.frame_not_reached: scene={scene} requested={requested} \
         available={available}"
    )]
    FrameNotReached {
        /// Scene the frame stream started from.
        scene: SceneId,
        /// Frame index requested.
        requested: usize,
        /// Frames the deterministic stream actually emitted.
        available: usize,
    },
}

/// Typed error parsing a [`JumpTarget::address`] string.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("utsushi.reallive.jump.address_parse: {reason} (input={input:?})")]
pub struct JumpAddressError {
    /// The offending input string.
    pub input: String,
    /// Why the parse failed.
    pub reason: String,
}

impl JumpAddressError {
    fn new(input: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            input: input.into(),
            reason: reason.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene_with_lines() -> Scene {
        // Two source-line markers back to back, byte-aligned (3 bytes each).
        let elements = vec![
            BytecodeElement::MetaLine {
                line_number: 5,
                byte_offset: 0,
                byte_len: 3,
            },
            BytecodeElement::MetaLine {
                line_number: 42,
                byte_offset: 3,
                byte_len: 3,
            },
        ];
        Scene::new(7, elements).expect("scene builds")
    }

    #[test]
    fn resolve_line_pc_maps_line_number_to_marker_offset() {
        let scene = scene_with_lines();
        assert_eq!(resolve_line_pc(&scene, 5), Some(0));
        assert_eq!(resolve_line_pc(&scene, 42), Some(3));
        // A line the scene never declares resolves to a typed miss.
        assert_eq!(resolve_line_pc(&scene, 999), None);
    }

    #[test]
    fn address_round_trips_for_every_granularity() {
        let cases = [
            JumpTarget::Scene { scene: 2031 },
            JumpTarget::Line {
                scene: 9030,
                line_number: 128,
            },
            JumpTarget::Frame {
                scene: 1,
                frame_index: 7,
            },
        ];
        for target in cases {
            let address = target.address();
            let parsed = JumpTarget::from_address(&address).expect("address parses");
            assert_eq!(parsed, target, "round-trip for {address}");
        }
    }

    #[test]
    fn address_strings_are_stable_and_documented() {
        assert_eq!(
            JumpTarget::Scene { scene: 2031 }.address(),
            "reallive://scene/2031"
        );
        assert_eq!(
            JumpTarget::Line {
                scene: 9030,
                line_number: 128
            }
            .address(),
            "reallive://scene/9030/line/128"
        );
        assert_eq!(
            JumpTarget::Frame {
                scene: 1,
                frame_index: 7
            }
            .address(),
            "reallive://scene/1/frame/7"
        );
    }

    #[test]
    fn from_address_rejects_malformed_input() {
        for bad in [
            "scene/1",                      // missing prefix
            "reallive://scene/",            // missing scene id
            "reallive://scene/notanumber",  // scene not u16
            "reallive://scene/1/line",      // missing line value
            "reallive://scene/1/line/x",    // line not u16
            "reallive://scene/1/bogus/3",   // unknown granularity
            "reallive://scene/1/frame/3/x", // trailing segment
        ] {
            assert!(
                JumpTarget::from_address(bad).is_err(),
                "must reject {bad:?}"
            );
        }
    }

    #[test]
    fn anchor_pairs_address_with_fingerprint() {
        let landing = JumpLanding {
            target: JumpTarget::Frame {
                scene: 1,
                frame_index: 3,
            },
            scene: 4,
            pc: 128,
            control_fingerprint: 0xdead_beef,
            frame_index: Some(3),
            landed_line: None,
            steps_fast_forwarded: 42,
        };
        assert_eq!(
            landing.anchor(),
            "reallive://scene/1/frame/3@00000000deadbeef"
        );
    }

    #[test]
    fn target_serde_round_trips() {
        let target = JumpTarget::Frame {
            scene: 12,
            frame_index: 4,
        };
        let json = serde_json::to_string(&target).expect("serialize");
        let back: JumpTarget = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, target);
    }
}
