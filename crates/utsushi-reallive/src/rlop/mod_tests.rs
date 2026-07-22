use super::*;

struct AdvanceOp;
impl RLOperation for AdvanceOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Advance
    }
}

#[test]
fn registry_register_then_get_round_trips() {
    let mut registry = RlopRegistry::new();
    let key = RlopKey::new(0x01, 0x02, 0x0010);
    assert!(registry.is_empty());
    let prior = registry.register(key, Arc::new(AdvanceOp));
    assert!(prior.is_none());
    assert_eq!(registry.len(), 1);
    let op = registry.get(key).expect("registered op resolves");
    // dispatch must compile through the dyn trait pointer.
    let _ = op;
    assert_eq!(
        registry.resolve(key).map(|(_, provenance)| provenance),
        Some(RlopImplementationProvenance::Semantic),
    );
}

#[test]
fn missing_key_lookup_returns_none_not_panic() {
    let registry = RlopRegistry::new();
    assert!(registry.get(RlopKey::new(0, 0, 0)).is_none());
}

#[test]
fn never_ready_scheduler_keeps_longop_pending() {
    let mut scheduler = NeverReadyScheduler;
    let mut op = LongOp::new(LongOpId(1), vec![]);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
}

#[test]
fn always_ready_scheduler_consumes_longop_immediately() {
    let mut scheduler = AlwaysReadyScheduler;
    let mut op = LongOp::new(LongOpId(1), vec![]);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
}

#[test]
fn after_n_polls_scheduler_observes_pending_then_ready() {
    let mut scheduler = AfterNPollsScheduler::new(2);
    let mut op = LongOp::new(LongOpId(1), vec![]);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
}

#[test]
fn expr_value_accessors_round_trip() {
    let int_val = ExprValue::Int(42);
    let bytes_val = ExprValue::Bytes(vec![0x82, 0xa0]);
    assert_eq!(int_val.as_int(), Some(42));
    assert!(int_val.as_bytes().is_none());
    assert!(bytes_val.as_int().is_none());
    assert_eq!(bytes_val.as_bytes(), Some(&[0x82, 0xa0][..]));
}

#[test]
fn longop_id_display_renders_as_hex() {
    let id = LongOpId(0xdead_beef);
    assert_eq!(format!("{id}"), "longop:00000000deadbeef");
}

#[test]
fn rlop_key_display_renders_as_module_lattice() {
    let key = RlopKey::new(0x01, 0x52, 0x000a);
    assert_eq!(format!("{key}"), "rlop[01/52/000a]");
}
