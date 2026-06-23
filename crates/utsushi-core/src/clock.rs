//! Deterministic logical clock for replay-driven runtimes.
//!
//! `LogicalClock` is a plain `u64` counter monotonically advanced by the
//! recording / replay driver. There is no implicit mapping to wall-clock time;
//! adapters that want a frame counter implement their own surface and tick the
//! clock once per consumed input.
//!
//! `LogicalClock` intentionally does NOT implement [`Default`] — callers must
//! pick a [`ClockOrigin`] explicitly so the replay tail can be anchored
//! correctly. There is no interior mutability; all mutation flows through
//! `&mut self` so the recording loop cannot share a clock across threads
//! without explicit synchronization.

use serde::{Deserialize, Serialize};

use crate::input::InputError;

/// Logical clock tick. WASM-portable, additive over the embed ABI.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[serde(transparent)]
pub struct LogicalClockTick(pub u64);

impl LogicalClockTick {
    /// Returns the underlying `u64`.
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// What `LogicalClockTick(0)` anchors against.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockOrigin {
    /// Tick 0 is when the runtime begins driving the recorded session.
    RunStart,
    /// Tick 0 is when a recorded snapshot was restored. Used by snapshot
    /// primitives (UTSUSHI-023) so log tails can be replayed against a
    /// restored state.
    SnapshotRestore,
}

/// Deterministic logical clock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogicalClock {
    origin: ClockOrigin,
    current: LogicalClockTick,
}

impl LogicalClock {
    /// Construct a clock anchored at the given origin. The initial tick is 0.
    pub fn starting_at(origin: ClockOrigin) -> Self {
        Self {
            origin,
            current: LogicalClockTick(0),
        }
    }

    /// Origin used to anchor this clock.
    pub fn origin(&self) -> ClockOrigin {
        self.origin
    }

    /// Current tick value.
    pub fn now(&self) -> LogicalClockTick {
        self.current
    }

    /// Advance the clock by one and return the post-tick value.
    pub fn tick(&mut self) -> LogicalClockTick {
        // We bound the counter to `u64::MAX - 1` so the increment cannot
        // overflow inside a single deterministic run. `u64::MAX` ticks would
        // require sub-nanosecond input across the age of the universe; the
        // check is defense-in-depth, not a practical concern.
        let next = self
            .current
            .0
            .checked_add(1)
            .expect("logical clock tick overflow");
        self.current = LogicalClockTick(next);
        self.current
    }

    /// Advance the clock to the given target. Returns
    /// [`InputError::ClockBacktrack`] if the target is strictly less than the
    /// current tick. Advancing to the same tick is a no-op.
    pub fn advance_to(&mut self, target: LogicalClockTick) -> Result<(), InputError> {
        if target < self.current {
            return Err(InputError::clock_backtrack(self.current, target));
        }
        self.current = target;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_clock_tick_returns_strictly_monotonic_values() {
        let mut clock = LogicalClock::starting_at(ClockOrigin::RunStart);
        assert_eq!(clock.now(), LogicalClockTick(0));
        let a = clock.tick();
        let b = clock.tick();
        let c = clock.tick();
        assert_eq!(a, LogicalClockTick(1));
        assert_eq!(b, LogicalClockTick(2));
        assert_eq!(c, LogicalClockTick(3));
        assert!(a < b && b < c);
    }

    #[test]
    fn logical_clock_advance_to_accepts_equal_or_greater_target() {
        let mut clock = LogicalClock::starting_at(ClockOrigin::RunStart);
        clock.tick();
        clock.tick();
        // equal target is a no-op
        clock.advance_to(LogicalClockTick(2)).unwrap();
        assert_eq!(clock.now(), LogicalClockTick(2));
        clock.advance_to(LogicalClockTick(10)).unwrap();
        assert_eq!(clock.now(), LogicalClockTick(10));
    }

    #[test]
    fn logical_clock_advance_to_rejects_backtrack_with_typed_error() {
        let mut clock = LogicalClock::starting_at(ClockOrigin::RunStart);
        clock.advance_to(LogicalClockTick(5)).unwrap();
        let error = clock.advance_to(LogicalClockTick(2)).unwrap_err();
        match error {
            InputError::ClockBacktrack { from, to, code } => {
                assert_eq!(from, LogicalClockTick(5));
                assert_eq!(to, LogicalClockTick(2));
                assert_eq!(code, "utsushi.clock.backtrack");
            }
            other => panic!("expected ClockBacktrack, got {other:?}"),
        }
        // backtrack rejection must NOT have mutated the clock
        assert_eq!(clock.now(), LogicalClockTick(5));
    }

    #[test]
    fn logical_clock_two_instances_with_same_input_produce_same_tick_sequence() {
        let mut left = LogicalClock::starting_at(ClockOrigin::RunStart);
        let mut right = LogicalClock::starting_at(ClockOrigin::RunStart);
        let mut left_history = Vec::new();
        let mut right_history = Vec::new();
        for _ in 0..16 {
            left_history.push(left.tick());
            right_history.push(right.tick());
        }
        assert_eq!(left_history, right_history);
    }

    #[test]
    fn clock_origin_round_trips_through_serde() {
        for origin in [ClockOrigin::RunStart, ClockOrigin::SnapshotRestore] {
            let value = serde_json::to_value(origin).unwrap();
            let back: ClockOrigin = serde_json::from_value(value).unwrap();
            assert_eq!(origin, back);
        }
        assert_eq!(
            serde_json::to_value(ClockOrigin::RunStart).unwrap(),
            serde_json::json!("run_start")
        );
        assert_eq!(
            serde_json::to_value(ClockOrigin::SnapshotRestore).unwrap(),
            serde_json::json!("snapshot_restore")
        );
    }

    #[test]
    fn logical_clock_tick_serializes_transparently_as_u64() {
        let tick = LogicalClockTick(42);
        let value = serde_json::to_value(tick).unwrap();
        assert_eq!(value, serde_json::json!(42));
        let back: LogicalClockTick = serde_json::from_value(value).unwrap();
        assert_eq!(back, tick);
    }

    #[test]
    fn logical_clock_origin_is_preserved_across_ticks() {
        let mut clock = LogicalClock::starting_at(ClockOrigin::SnapshotRestore);
        clock.tick();
        clock.tick();
        assert_eq!(clock.origin(), ClockOrigin::SnapshotRestore);
    }

    #[test]
    fn logical_clock_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<LogicalClock>();
        assert_send_sync::<LogicalClockTick>();
        assert_send_sync::<ClockOrigin>();
    }
}
