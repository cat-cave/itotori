use super::*;
use std::sync::Mutex;

use utsushi_core::substrate::{ChoiceIndex, SinkCapability, SinkError, SinkKind, SinkResult};

use crate::rlop::{LongOpReadiness, LongOpScheduler};
use crate::var_banks::VarBanks;

struct CollectingSink {
    lines: Mutex<Vec<TextLine>>,
    reject_after: Option<usize>,
}

impl CollectingSink {
    fn new() -> Self {
        Self {
            lines: Mutex::new(Vec::new()),
            reject_after: None,
        }
    }

    fn rejecting_after(emitted: usize) -> Self {
        Self {
            lines: Mutex::new(Vec::new()),
            reject_after: Some(emitted),
        }
    }
}

impl TextSurfaceSink for CollectingSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        let mut lines = self.lines.lock().expect("lock");
        if self.reject_after == Some(lines.len()) {
            return Err(SinkError::UnsupportedKind {
                sink: SinkKind::TextSurface,
                adapter_id: "reject-second-choice".to_string(),
                reason: "test sink rejects one choice".to_string(),
            });
        }
        lines.push(line);
        Ok(())
    }
}

#[test]
fn select_variant_all_covers_every_select_opcode() {
    // The six SELECT variants cover rlvm `Sel` opcodes {0,1,2,3,4,14}
    // (the setup-only `objbtn_init` = 20 is not a select).
    assert_eq!(SelectVariant::ALL.len(), 6);
    let opcodes: std::collections::BTreeSet<u16> =
        SelectVariant::ALL.iter().map(|v| v.opcode()).collect();
    assert_eq!(
        opcodes,
        [0u16, 1, 2, 3, 4, 14].into_iter().collect(),
        "SELECT variants must map to the rlvm Sel select opcodes"
    );
}

#[test]
fn register_sel_rlops_populates_expected_count() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(SelRuntime::with_sink(sink));
    let mut registry = RlopRegistry::new();
    let count = register_sel_rlops(&mut registry, runtime);
    assert_eq!(count, SEL_RLOP_COUNT);
    assert_eq!(registry.len(), SEL_RLOP_COUNT);
}

#[test]
fn register_sel_rlops_covers_every_variant() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(SelRuntime::with_sink(sink));
    let mut registry = RlopRegistry::new();
    register_sel_rlops(&mut registry, runtime);
    for variant in SelectVariant::ALL {
        assert!(
            registry.get(variant.rlop_key()).is_some(),
            "missing variant: {variant:?}"
        );
    }
    // The `objbtn_init` button-object setup op is also registered.
    assert!(
        registry
            .get(RlopKey::new(
                SEL_MODULE_TYPE,
                SEL_MODULE_ID,
                OPCODE_OBJBTN_INIT
            ))
            .is_some(),
        "objbtn_init setup op missing"
    );
}

#[test]
fn register_sel_rlops_covers_exact_rlvm_oracle_opcode_set() {
    // rlvm `SelModule` (`module_sel.cc`) registers EXACTLY these opcodes:
    //   0 select_w, 1 select, 2 select_s2, 3 select_s
    //   4 select_objbtn, 14 select_objbtn_cancel, 20 objbtn_init.
    // The port must register that set — no more, no less. In particular
    // opcode 120 (a retired synthetic alias) must be ABSENT.
    const ORACLE_OPCODES: &[u16] = &[0, 1, 2, 3, 4, 14, 20];
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(SelRuntime::with_sink(sink));
    let mut registry = RlopRegistry::new();
    register_sel_rlops(&mut registry, runtime);

    // Every oracle opcode is registered at (0, 2, opcode).
    for &opcode in ORACLE_OPCODES {
        assert!(
            registry
                .get(RlopKey::new(SEL_MODULE_TYPE, SEL_MODULE_ID, opcode))
                .is_some(),
            "rlvm Sel opcode {opcode} not registered"
        );
    }
    // The count equals the oracle set size — combined with all seven keys
    // present and `register_sel_rlops` touching only Sel keys, this proves
    // EXACTLY {0,1,2,3,4,14,20} is registered (no extras).
    assert_eq!(ORACLE_OPCODES.len(), SEL_RLOP_COUNT);
    assert_eq!(registry.len(), SEL_RLOP_COUNT);
    // The retired synthetic opcode 120 is absent (rlvm has no such opcode).
    assert!(
        registry
            .get(RlopKey::new(SEL_MODULE_TYPE, SEL_MODULE_ID, 120))
            .is_none(),
        "synthetic opcode 120 must not be registered"
    );
    // Opcodes 3 and 14 are real Sel operations.
    assert!(
        registry
            .get(RlopKey::new(
                SEL_MODULE_TYPE,
                SEL_MODULE_ID,
                OPCODE_SELECT_S3
            ))
            .is_some(),
        "select_s (opcode 3) must be a real Sel op"
    );
    assert!(
        registry
            .get(RlopKey::new(
                SEL_MODULE_TYPE,
                SEL_MODULE_ID,
                OPCODE_SELECT_OBJBTN_CANCEL
            ))
            .is_some(),
        "select_objbtn_cancel (opcode 14) must be a real Sel op"
    );
}

#[test]
fn variant_str_pin() {
    assert_eq!(SelectVariant::Select.as_str(), "sel.select");
    assert_eq!(SelectVariant::SelectS.as_str(), "sel.select_s");
    assert_eq!(SelectVariant::SelectW.as_str(), "sel.select_w");
    assert_eq!(SelectVariant::SelectS3.as_str(), "sel.select_s3");
    assert_eq!(SelectVariant::SelectObjbtn.as_str(), "sel.select_objbtn");
    assert_eq!(
        SelectVariant::SelectObjbtnCancel.as_str(),
        "sel.select_objbtn_cancel"
    );
}

#[test]
fn objbtn_opcode_is_real_rlvm_value_four() {
    // The real RealLive `select_objbtn` opcode is 4 (rlvm
    // `AddOpcode(4, 0, "select_objbtn")`). The old fictional value 3 has
    // zero observed occurrences.
    assert_eq!(OPCODE_SELECT_OBJBTN, 4);
    assert_eq!(SelectVariant::SelectObjbtn.opcode(), 4);
    assert_eq!(OPCODE_OBJBTN_INIT, 20);
    assert_eq!(OPCODE_SELECT_OBJBTN_CANCEL, 14);
    // The button-object SETUP opcodes are the real modality signal.
    assert_eq!(SelectVariant::BUTTON_OBJECT_SETUP_OPCODES, &[20u16, 4, 14]);
}

#[test]
fn objbtn_init_is_a_noop() {
    let mut vm = Vm::new(1, 0);
    assert!(matches!(
        ObjbtnInitOp::new().dispatch(&mut vm, &[]),
        DispatchOutcome::Advance
    ));
}

#[path = "tests_object_buttons.rs"]
mod object_buttons;

#[path = "tests_runtime.rs"]
mod runtime;
