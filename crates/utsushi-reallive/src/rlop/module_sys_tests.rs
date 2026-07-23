use super::*;
use utsushi_core::EvidenceTier;
use utsushi_core::clock::{ClockOrigin, LogicalClock};
use utsushi_core::substrate::{
    InMemorySnapshotStore, Snapshot, SnapshotRef, SnapshotRequest, SnapshotStore, restore_snapshot,
    take_snapshot,
};

fn int_arg(value: i32) -> ExprValue {
    ExprValue::Int(value)
}

fn read_store(vm: &Vm) -> i32 {
    vm.banks().store() as i32
}

fn read_store_u32(vm: &Vm) -> u32 {
    vm.banks().store()
}

#[test]
fn sys_register_helper_populates_expected_count() {
    let mut registry = RlopRegistry::new();
    let runtime = Arc::new(SysRuntime::new(LogicalClockTick(0)));
    register_sys_rlops(&mut registry, runtime);
    assert_eq!(registry.len(), SYS_RLOP_COUNT);
    for module_type in LATTICE_TYPES {
        for op in SysOpcode::ALL {
            assert!(
                registry.get(op.rlop_key_for(module_type)).is_some(),
                "{op:?} must resolve for lattice type {module_type}",
            );
        }
    }
}

#[test]
fn sys_opcode_byte_values_are_distinct() {
    let mut seen = std::collections::HashSet::new();
    for op in SysOpcode::ALL {
        assert!(seen.insert(op.opcode()), "duplicate opcode for {op:?}");
    }
}

// Acceptance: `sys_rnd_deterministic_under_logical_clock`

#[test]
fn sys_rnd_deterministic_under_logical_clock() {
    // Two runtimes seeded from the same clock tick produce the
    // same rnd sequence.
    let tick = LogicalClockTick(42);
    let left = SysRuntime::new(tick);
    let right = SysRuntime::new(tick);
    let mut left_seq = Vec::new();
    let mut right_seq = Vec::new();
    for _ in 0..16 {
        left_seq.push(left.rnd_below(1000));
        right_seq.push(right.rnd_below(1000));
    }
    assert_eq!(left_seq, right_seq, "deterministic under shared clock tick");
    // Different tick → different stream (with overwhelming
    // probability — the test uses tick=0 vs tick=42 and asserts
    // the first 4 values differ, which is structurally impossible
    // to fail with the XorShift constants pinned above).
    let different = SysRuntime::new(LogicalClockTick(0));
    let mut different_seq = Vec::new();
    for _ in 0..4 {
        different_seq.push(different.rnd_below(1000));
    }
    assert_ne!(
        different_seq,
        left_seq[..4],
        "tick=0 and tick=42 must produce distinct streams",
    );
}

#[test]
fn sys_rnd_snapshot_store_round_trips_rng_state() {
    // Snapshot the rng state after a few calls; scribble it via
    // additional draws; restore; verify the next draw matches the
    // pre-scribble sequence.
    let runtime = SysRuntime::new(LogicalClockTick(7));
    // Pull three values to warm the rng.
    let warm: Vec<i32> = (0..3).map(|_| runtime.rnd_below(1000)).collect();
    // Snapshot the runtime's rng state.
    let request = SnapshotRequest::new("run-module-sys1", "2026-06-26T00:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let snapshot: Snapshot = take_snapshot(&runtime, &request).expect("snapshot");
    let store = InMemorySnapshotStore::new();
    store.insert(snapshot.clone()).expect("insert");
    // Pull two more values to record the post-snapshot sequence.
    let expected_post_snapshot: Vec<i32> = (0..2).map(|_| runtime.rnd_below(1000)).collect();
    // Continue scribbling.
    let _ = runtime.rnd_below(1000);
    let _ = runtime.rnd_below(1000);
    // Resolve + restore.
    let reference = SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    };
    let resolved = store.resolve(&reference).expect("resolve");
    let mut runtime_mut = runtime;
    restore_snapshot(&mut runtime_mut, &resolved).expect("restore");
    let restored: Vec<i32> = (0..2).map(|_| runtime_mut.rnd_below(1000)).collect();
    assert_eq!(
        restored, expected_post_snapshot,
        "rng state round-trip through SnapshotStore must reproduce the sequence",
    );
    // Sanity: the warm-up sequence was non-trivial.
    assert!(warm.iter().any(|v| *v != 0));
}

#[test]
fn sys_rnd_reseed_from_clock_changes_stream() {
    // Reseeding from a fresh tick rewrites the state. Pulling the
    // same number of draws produces a different sequence.
    let runtime = SysRuntime::new(LogicalClockTick(1));
    let pre: Vec<i32> = (0..4).map(|_| runtime.rnd_below(1000)).collect();
    runtime.reseed_from_clock(LogicalClockTick(999));
    let post: Vec<i32> = (0..4).map(|_| runtime.rnd_below(1000)).collect();
    assert_ne!(pre, post);
}

#[test]
fn sys_rnd_logical_clock_driven_advance_seeds_deterministically() {
    // Two LogicalClock instances with the same tick sequence
    // produce the same rnd sequence when used as seed bases.
    let mut left_clock = LogicalClock::starting_at(ClockOrigin::RunStart);
    let mut right_clock = LogicalClock::starting_at(ClockOrigin::RunStart);
    let mut left_seq = Vec::new();
    let mut right_seq = Vec::new();
    for _ in 0..4 {
        let left_tick = left_clock.tick();
        let right_tick = right_clock.tick();
        assert_eq!(left_tick, right_tick);
        let left_rt = SysRuntime::new(left_tick);
        let right_rt = SysRuntime::new(right_tick);
        left_seq.push(left_rt.rnd_below(1_000_000));
        right_seq.push(right_rt.rnd_below(1_000_000));
    }
    assert_eq!(left_seq, right_seq);
}

// Acceptance: per-op input/output tables (≥3 cases incl. boundary)

#[test]
fn sys_pcnt_three_cases() {
    let mut vm = Vm::new(1, 0);
    PcntOp.dispatch(&mut vm, &[int_arg(50), int_arg(200)]);
    assert_eq!(read_store(&vm), 25);
    PcntOp.dispatch(&mut vm, &[int_arg(7), int_arg(50)]);
    assert_eq!(read_store(&vm), 14);
    // Boundary: denominator=0 → 0 (no divide-by-zero panic).
    PcntOp.dispatch(&mut vm, &[int_arg(99), int_arg(0)]);
    assert_eq!(read_store(&vm), 0);
}

#[test]
fn sys_abs_three_cases() {
    let mut vm = Vm::new(1, 0);
    AbsOp.dispatch(&mut vm, &[int_arg(42)]);
    assert_eq!(read_store(&vm), 42);
    AbsOp.dispatch(&mut vm, &[int_arg(-7)]);
    assert_eq!(read_store(&vm), 7);
    // Boundary: i32::MIN saturates at i32::MAX (no overflow panic).
    AbsOp.dispatch(&mut vm, &[int_arg(i32::MIN)]);
    assert_eq!(read_store(&vm), i32::MAX);
}

#[test]
fn sys_power_three_cases() {
    let mut vm = Vm::new(1, 0);
    PowerOp.dispatch(&mut vm, &[int_arg(2), int_arg(10)]);
    assert_eq!(read_store(&vm), 1024);
    PowerOp.dispatch(&mut vm, &[int_arg(7), int_arg(0)]);
    assert_eq!(read_store(&vm), 1);
    // Boundary: huge exponent → saturated MAX.
    PowerOp.dispatch(&mut vm, &[int_arg(10), int_arg(20)]);
    assert_eq!(read_store(&vm), i32::MAX);
    // Bonus: negative exponent → 0.
    PowerOp.dispatch(&mut vm, &[int_arg(2), int_arg(-3)]);
    assert_eq!(read_store(&vm), 0);
}

#[test]
fn sys_sin_three_cases_including_table_pin() {
    // Pin the four cardinal table entries.
    let mut vm = Vm::new(1, 0);
    SinOp.dispatch(&mut vm, &[int_arg(0)]);
    assert_eq!(read_store(&vm), 0);
    SinOp.dispatch(&mut vm, &[int_arg(64)]);
    assert_eq!(read_store(&vm), 32768);
    SinOp.dispatch(&mut vm, &[int_arg(128)]);
    assert_eq!(read_store(&vm), 0);
    // Boundary: theta > 256 wraps via rem_euclid.
    SinOp.dispatch(&mut vm, &[int_arg(64 + 256)]);
    assert_eq!(read_store(&vm), 32768);
}

#[test]
fn sys_cos_three_cases() {
    let mut vm = Vm::new(1, 0);
    CosOp.dispatch(&mut vm, &[int_arg(0)]);
    assert_eq!(read_store(&vm), 32768);
    CosOp.dispatch(&mut vm, &[int_arg(64)]);
    assert_eq!(read_store(&vm), 0);
    CosOp.dispatch(&mut vm, &[int_arg(128)]);
    // sin(192) = -32768 ≡ cos(128) per the 256-step table.
    assert_eq!(read_store(&vm), -32768);
}

#[test]
fn sys_min_three_cases() {
    let mut vm = Vm::new(1, 0);
    MinOp.dispatch(&mut vm, &[int_arg(3), int_arg(7)]);
    assert_eq!(read_store(&vm), 3);
    MinOp.dispatch(&mut vm, &[int_arg(-7), int_arg(-3)]);
    assert_eq!(read_store(&vm), -7);
    // Boundary: equal arguments.
    MinOp.dispatch(&mut vm, &[int_arg(5), int_arg(5)]);
    assert_eq!(read_store(&vm), 5);
}

#[test]
fn sys_max_three_cases() {
    let mut vm = Vm::new(1, 0);
    MaxOp.dispatch(&mut vm, &[int_arg(3), int_arg(7)]);
    assert_eq!(read_store(&vm), 7);
    MaxOp.dispatch(&mut vm, &[int_arg(-7), int_arg(-3)]);
    assert_eq!(read_store(&vm), -3);
    // Boundary: equal arguments.
    MaxOp.dispatch(&mut vm, &[int_arg(5), int_arg(5)]);
    assert_eq!(read_store(&vm), 5);
}

#[test]
fn sys_constrain_three_cases() {
    let mut vm = Vm::new(1, 0);
    ConstrainOp.dispatch(&mut vm, &[int_arg(5), int_arg(0), int_arg(10)]);
    assert_eq!(read_store(&vm), 5);
    ConstrainOp.dispatch(&mut vm, &[int_arg(-3), int_arg(0), int_arg(10)]);
    assert_eq!(read_store(&vm), 0);
    // Boundary: above-range.
    ConstrainOp.dispatch(&mut vm, &[int_arg(15), int_arg(0), int_arg(10)]);
    assert_eq!(read_store(&vm), 10);
}

#[test]
fn sys_rnd_op_writes_store_register() {
    // Dispatching the op writes through the substrate VarBanks
    // store-register surface — not a private cache.
    let runtime = Arc::new(SysRuntime::new(LogicalClockTick(7)));
    let op = RndOp::new(runtime);
    let mut vm = Vm::new(1, 0);
    op.dispatch(&mut vm, &[int_arg(100)]);
    let value = read_store_u32(&vm);
    assert!(value < 100, "rnd(100) must land in [0, 100), got {value}",);
}

#[test]
fn sys_rnd_zero_max_returns_zero() {
    let runtime = SysRuntime::new(LogicalClockTick(42));
    assert_eq!(runtime.rnd_below(0), 0);
    assert_eq!(runtime.rnd_below(1), 0);
}

#[test]
fn sys_runtime_restore_rejects_zero_state() {
    // Zero state is a fixed point in XorShift64; the snapshot
    // path rejects it typed.
    let mut runtime = SysRuntime::new(LogicalClockTick(1));
    let mut tree = StateTree::new();
    tree.insert(
        StatePath::parse(MANIFEST_PATH).unwrap(),
        StateValue::String {
            value: SYS_RUNTIME_MANIFEST.to_string(),
        },
    )
    .unwrap();
    tree.insert(
        StatePath::parse(RNG_STATE_PATH).unwrap(),
        StateValue::Uint { value: 0 },
    )
    .unwrap();
    let err = runtime.restore_state(&tree).unwrap_err();
    assert!(
        matches!(err, SnapshotError::RestoreValueOutOfRange { .. }),
        "got {err:?}",
    );
}
