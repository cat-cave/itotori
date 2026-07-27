//! Exact overload addresses observed in the supported RealLive format.
//!
//! These are not a fallback table. Every entry creates a four-field registry
//! key after its canonical implementation has mounted, so VM dispatch still
//! fails closed for an unlisted overload byte. Reusing an implementation here
//! is explicit per exact key; a selector that gains distinct supported
//! semantics receives its own registry entry rather than a lookup fallback.

use super::{RlopKey, RlopRegistry};

type Variant = (u8, u8, u16, u8);

const VARIANTS: &[Variant] = &[
    (0, 1, 11, 1),
    (0, 1, 12, 1),
    (0, 2, 4, 1),
    (0, 2, 14, 1),
    (0, 2, 20, 1),
    (0, 2, 22, 1),
    (0, 3, 105, 1),
    (0, 3, 105, 2),
    (0, 3, 400, 1),
    (0, 3, 401, 1),
    (1, 4, 110, 1),
    (1, 4, 120, 1),
    (1, 4, 121, 1),
    (1, 4, 1000, 1),
    (1, 4, 1211, 1),
    (1, 4, 1212, 1),
    (1, 4, 1215, 1),
    (1, 10, 0, 1),
    (1, 10, 11, 1),
    (1, 10, 17, 1),
    (1, 11, 1, 1),
    (1, 11, 4, 1),
    (1, 20, 0, 1),
    (1, 21, 0, 1),
    (1, 21, 5, 1),
    (1, 23, 0, 1),
    (1, 23, 8, 1),
    (1, 33, 70, 2),
    (1, 33, 71, 2),
    (1, 33, 72, 2),
    (1, 33, 73, 4),
    (1, 33, 74, 4),
    (1, 33, 100, 2),
    (1, 33, 101, 2),
    (1, 33, 201, 3),
    (1, 33, 1053, 4),
    (1, 33, 1056, 4),
    (1, 33, 1100, 2),
    (1, 33, 1100, 3),
    (1, 33, 1201, 2),
    (1, 33, 1201, 3),
    (1, 40, 10, 1),
    (1, 60, 2, 1),
    (1, 71, 1000, 2),
    (1, 71, 1500, 2),
    (1, 72, 1000, 1),
    (1, 72, 1000, 2),
    (1, 82, 1064, 1),
    (1, 84, 1100, 1),
    (2, 1, 12, 1),
    (2, 1, 12, 2),
    (2, 1, 12, 3),
    (2, 1, 12, 4),
    (2, 1, 12, 5),
    (2, 61, 0, 1),
    (2, 71, 1000, 2),
    (2, 71, 1000, 3),
    (2, 71, 1005, 2),
    (2, 71, 1101, 2),
    (2, 71, 1200, 2),
    (2, 71, 1400, 2),
    (2, 81, 1025, 1),
    (2, 81, 1034, 1),
    (2, 81, 1064, 2),
    (2, 81, 2004, 2),
    (2, 90, 2004, 2),
];

/// Add every supported nonzero overload variant as an exact registry entry.
///
/// Each source address is overload zero because that is how the existing
/// operation registrars declare the canonical implementation. Raw-byte
/// addresses whose canonical operation is unsupported remain visible as
/// `MissingRlop`; this table never turns one into a silent no-op.
pub(crate) fn register_overload_variants(registry: &mut RlopRegistry) -> usize {
    let mut registered = 0;
    for &(module_type, module_id, opcode, overload) in VARIANTS {
        let source = RlopKey::new(module_type, module_id, opcode);
        if registry.get(source).is_some() {
            registry.register_overload_variant(
                RlopKey::with_overload(module_type, module_id, opcode, overload),
                source,
            );
            registered += 1;
        }
    }
    registered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rlop::{DispatchOutcome, ExprValue, RLOperation};
    use crate::vm::Vm;
    use std::sync::Arc;

    struct AdvanceOp;

    impl RLOperation for AdvanceOp {
        fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
            DispatchOutcome::Advance
        }
    }

    #[test]
    fn every_overload_variant_requires_its_canonical_operation() {
        let mut registry = RlopRegistry::new();
        for &(module_type, module_id, opcode, _) in VARIANTS {
            let canonical = RlopKey::new(module_type, module_id, opcode);
            if registry.get(canonical).is_none() {
                registry.register(canonical, Arc::new(AdvanceOp));
            }
        }
        assert_eq!(register_overload_variants(&mut registry), VARIANTS.len());
        for &(module_type, module_id, opcode, overload) in VARIANTS {
            assert!(
                registry
                    .get(RlopKey::with_overload(
                        module_type,
                        module_id,
                        opcode,
                        overload
                    ))
                    .is_some()
            );
        }
    }
}
