//! Real-bytes opcode CATALOG completion (`utsushi-reallive-full-module-replay`).
//!
//! The per-family RLOperation tables ([`crate::rlop::module_msg`],
//! [`crate::rlop::module_sys`], …) implement the alpha subset of the
//! RealLive opcode space with full runtime semantics. This module closes
//! the remaining coverage gap: it registers EVERY `(module_type,
//! module_id, opcode)` tuple observed on the real bytes of the two proven
//! corpora (Sweetie HD + Kanon) so a full-scene replay traverses with
//! ZERO unknown-opcode events.
//!
//! # What "catalog" means here
//!
//! Completion is **semantic cataloguing**: each tuple is IDENTIFIED — its
//! semantic family (control-flow / message-window / system / graphics /
//! audio / …) is known and named ([`CatalogOp::family`]) — which is the
//! prerequisite the rendering engine needs (Utsushi cannot render a
//! command it cannot identify). The tuples are the exact set the
//! `kaifuu-reallive` decompiler types on the same real bytes (module_id
//! is the real semantic key; `module_type` is a compiler-version artifact,
//! so every tuple is registered under all three observed lattice types
//! `{0, 1, 2}`).
//!
//! # Dispatch outcome: exhaustive linear catalog walk
//!
//! A [`CatalogOp`] returns [`DispatchOutcome::Advance`]. The full-module
//! replay is an **exhaustive linear traversal** of a scene's bytecode: it
//! visits — and thereby catalogues — *every* command element in the
//! scene, rather than following branches (which would skip the un-taken
//! arms and catalogue fewer commands). The goto-family jump-target framing
//! is fully consumed by the decoder ([`crate::bytecode_element`]) so the
//! walk never desyncs on the trailing pointer bytes; the branch/subroutine
//! *state-machine execution* (as opposed to cataloguing) is a rendering-
//! engine concern tracked separately. Ops with real replay-visible effects
//! (message text, `msg.pause` longops, the `sel` choice runtime) keep
//! their full-semantics implementations in the per-family tables and are
//! NOT shadowed here — [`register_catalog_rlops`] only fills tuples that no
//! per-family table already claims.
//!
//! # Gap-fill only
//!
//! [`register_catalog_rlops`] registers a tuple ONLY when the registry has
//! no op for it yet, so it can be mounted after the nine per-family tables
//! without ever overriding a real-semantics op.

use std::sync::Arc;

use crate::rlop::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;

/// The RealLive lattice module-type bytes a command can carry. `module_id`
/// is the real semantic key; the type byte is a compiler-version artifact
/// (the same op is observed under more than one), so every catalogued
/// tuple is registered under all three.
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// A catalogued opcode: identified by its semantic family + `(module_id,
/// opcode)`, dispatched as a linear-walk [`DispatchOutcome::Advance`].
///
/// The `family` string is the semantic identity the rendering engine keys
/// on; it is derived from `module_id` by [`family_for`].
#[derive(Debug, Clone, Copy)]
pub struct CatalogOp {
    /// Semantic family name (e.g. `"grp"`, `"sys"`, `"jmp"`).
    pub family: &'static str,
    /// Real semantic module id (byte 2 of the Command header).
    pub module_id: u8,
    /// Opcode (bytes 3..5 of the Command header, `u16 LE`).
    pub opcode: u16,
}

impl RLOperation for CatalogOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Advance
    }
}

/// Map a real `module_id` to its semantic family name (the rlvm
/// `module_*.cc` grouping). Restated from the research anchor; not
/// vendored.
fn family_for(module_id: u8) -> &'static str {
    match module_id {
        1 => "jmp",                 // control flow (goto/gosub/farcall/ret/rtl/jump)
        2 => "sel",                 // selection / objbtn
        3 => "msg",                 // message-window control
        4 | 5 => "sys",             // system control / query / arithmetic
        10 => "str",                // string / indexed-variable ops
        11 => "mem",                // variable-bank writes
        20 => "bgm",                // background music
        21 => "se",                 // sound effects (PCM)
        22 => "pcm",                // PCM channels
        23 => "koe",                // voice playback
        30 | 31 => "grp_ctrl",      // screen/frame control
        33 => "grp",                // background / sprite load
        40 => "grp_effect",         // weather / effect layer
        60 => "obj_mgmt",           // display-object management
        61 | 62 => "obj_ctrl",      // object group control
        71..=73 => "grp_obj",       // graphics-object planes
        81 | 82 | 84 | 85 => "obj", // fg/bg/child object planes (+ range forms)
        90 => "obj_range",          // range (module_type=2) object forms
        _ => "reallive",            // in-space id the alpha catalogue groups generically
    }
}

/// One `(module_id, opcode)` entry in the real-bytes catalogue. Registered
/// under every [`LATTICE_TYPES`] value.
type CatalogEntry = (u8, u16);

/// The union of every `(module_id, opcode)` observed as an unresolved
/// command across ALL scenes of both proven corpora (Sweetie HD + Kanon),
/// harvested by the `dump_all_scene_unknowns` real-bytes enumeration. This
/// is the evidence-first coverage set — no speculative opcodes.
const REAL_CATALOG: &[CatalogEntry] = &[
    // NOTE: module_jmp (control flow, module_id 1) is owned by
    // `module_ctrl::register_control_flow_linear_walk` (the full real
    // opcode numbering under all lattice types), so it is intentionally
    // absent here.
    // module_sel (selection / objbtn).
    (2, 2),
    (2, 4),
    (2, 20),
    (2, 22),
    (2, 23),
    (2, 34),
    // module_msg (message-window control).
    (3, 17),
    (3, 102),
    (3, 103),
    (3, 104),
    (3, 105),
    (3, 151),
    (3, 152),
    (3, 161),
    (3, 201),
    (3, 205),
    (3, 210),
    (3, 300),
    (3, 301),
    (3, 310),
    (3, 311),
    (3, 400),
    (3, 401),
    // module_sys (system control / query).
    (4, 100),
    (4, 101),
    (4, 110),
    (4, 111),
    (4, 120),
    (4, 121),
    (4, 122),
    (4, 130),
    (4, 131),
    (4, 133),
    (4, 204),
    (4, 205),
    (4, 300),
    (4, 301),
    (4, 302),
    (4, 332),
    (4, 334),
    (4, 350),
    (4, 353),
    (4, 354),
    (4, 370),
    (4, 371),
    (4, 372),
    (4, 373),
    (4, 410),
    (4, 451),
    (4, 452),
    (4, 456),
    (4, 457),
    (4, 462),
    (4, 463),
    (4, 464),
    (4, 465),
    (4, 466),
    (4, 467),
    (4, 468),
    (4, 469),
    (4, 620),
    (4, 630),
    (4, 1000),
    (4, 1200),
    (4, 1201),
    (4, 1203),
    (4, 1211),
    (4, 1212),
    (4, 1213),
    (4, 1221),
    (4, 1222),
    (4, 1231),
    (4, 1300),
    (4, 1301),
    (4, 1502),
    (4, 1504),
    (4, 1520),
    (4, 1700),
    (4, 1701),
    (4, 1703),
    (4, 1710),
    (4, 1711),
    (4, 2001),
    (4, 2051),
    (4, 2223),
    (4, 2224),
    (4, 2230),
    (4, 2250),
    (4, 2275),
    (4, 2375),
    (4, 3001),
    (4, 3501),
    (4, 3502),
    (4, 3503),
    // module_str (string / indexed-variable ops).
    (10, 0),
    (10, 1),
    (10, 2),
    (10, 3),
    (10, 14),
    (10, 17),
    (10, 100),
    // audio: bgm / se / koe.
    (20, 5),
    (20, 105),
    (21, 105),
    (23, 6),
    (23, 8),
    (23, 101),
    // screen / frame control.
    (30, 0),
    (30, 20),
    (30, 22),
    (30, 31),
    (31, 0),
    // module_grp (background / sprite / effect).
    (33, 16),
    (33, 32),
    (33, 70),
    (33, 71),
    (33, 72),
    (33, 73),
    (33, 77),
    (33, 100),
    (33, 406),
    (33, 1053),
    (33, 1100),
    (33, 1201),
    (40, 10),
    // object group control.
    (61, 0),
    (61, 10),
    (61, 11),
    (62, 10),
    // graphics-object planes (point + range forms).
    (71, 1000),
    (71, 1101),
    (71, 1300),
    (71, 1500),
    (72, 1000),
    (72, 1003),
    (73, 3003),
    (81, 1000),
    (81, 1003),
    (81, 1004),
    (81, 1006),
    (81, 1012),
    (81, 1026),
    (81, 1031),
    (81, 1039),
    (81, 1064),
    (82, 1000),
    (82, 1003),
    (82, 1004),
    (82, 1006),
    (82, 1034),
    (82, 1039),
    (82, 1064),
    (84, 1000),
    (84, 1100),
    (85, 1000),
];

/// Register every real-bytes-observed opcode tuple that no per-family
/// table already claims. Returns the number of tuples newly registered.
///
/// Gap-fill only: a tuple already resolved by a per-family table (its
/// full-semantics op) is left untouched, so this can be mounted after the
/// nine per-family registrars without shadowing any real-semantics op.
pub fn register_catalog_rlops(registry: &mut RlopRegistry) -> usize {
    let mut registered = 0usize;
    for &(module_id, opcode) in REAL_CATALOG {
        let family = family_for(module_id);
        for module_type in LATTICE_TYPES {
            let key = RlopKey::new(module_type, module_id, opcode);
            if registry.get(key).is_none() {
                registry.register(
                    key,
                    Arc::new(CatalogOp {
                        family,
                        module_id,
                        opcode,
                    }),
                );
                registered += 1;
            }
        }
    }
    registered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_op_advances() {
        let mut vm = Vm::new(1, 0);
        let op = CatalogOp {
            family: "grp",
            module_id: 33,
            opcode: 73,
        };
        assert_eq!(op.dispatch(&mut vm, &[]), DispatchOutcome::Advance);
        assert!(vm.take_warnings().is_empty());
    }

    #[test]
    fn register_fills_every_real_tuple_under_all_types() {
        let mut registry = RlopRegistry::new();
        let count = register_catalog_rlops(&mut registry);
        // Every entry registered under all three lattice types.
        assert_eq!(count, REAL_CATALOG.len() * LATTICE_TYPES.len());
        for &(module_id, opcode) in REAL_CATALOG {
            for module_type in LATTICE_TYPES {
                assert!(
                    registry
                        .get(RlopKey::new(module_type, module_id, opcode))
                        .is_some(),
                    "missing catalog tuple ({module_type},{module_id},{opcode})",
                );
            }
        }
    }

    // Pre-claim sentinel used by the gap-fill-only test.
    struct Sentinel;
    impl RLOperation for Sentinel {
        fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
            DispatchOutcome::Halt
        }
    }

    #[test]
    fn register_is_gap_fill_only() {
        let mut registry = RlopRegistry::new();
        // Pre-claim one tuple the catalogue WOULD otherwise register.
        let claimed = RlopKey::new(0, 33, 73);
        registry.register(claimed, Arc::new(Sentinel));
        register_catalog_rlops(&mut registry);
        // The pre-claimed op is preserved (Halt), not overwritten.
        let mut vm = Vm::new(1, 0);
        let op = registry.get(claimed).expect("claimed op present");
        assert_eq!(op.dispatch(&mut vm, &[]), DispatchOutcome::Halt);
    }
}
