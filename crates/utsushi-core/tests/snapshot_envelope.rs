//! Integration test for the snapshot envelope tier (UTSUSHI-223).
//!
//! Asserts the three deliverables the spec calls out:
//!
//! 1. **Const-asserted tier ceilings** — `Small = 16 KiB`,
//!    `Medium = 256 KiB`, `Large = 4 MiB`.
//! 2. **Medium-class round trip on a simulated RealLive scene-1 shape**
//!    — `int_bank: 1000 × i32`, `str_bank: 200 × String≈32 chars`,
//!    `graphics: 4 layers × {asset_id, transform, blend_mode}`. The
//!    serialized form must land between 64 KiB and 256 KiB and be
//!    byte-equal through `serialize → deserialize → serialize`.
//! 3. **Small-class overflow surfaces typed
//!    `SnapshotEnvelopeOverflow { envelope_class: Small, observed_bytes,
//!    limit_bytes: 16384 }`** and writes nothing — `Snapshot` value is
//!    never constructed and no output buffer escapes.
//! 4. **Second engine family round trip** — MV/MZ-shaped `.rpgsave`
//!    state object with `$gameSystem` / `$gameMap` / `$gameVariables`
//!    sub-objects, ~50 KiB total, through the Medium envelope.

use utsushi_core::{
    AssetId, EvidenceTier, Inspectable, Snapshot, SnapshotEnvelope, SnapshotError,
    SnapshotManifest, SnapshotRequest, StatePath, StateTree, StateValue, take_snapshot,
};

// =====================================================================
// 1. Const-asserted tier ceilings.
// =====================================================================

#[test]
fn small_envelope_max_bytes_returns_sixteen_kib() {
    const _CHECK: () = assert!(SnapshotEnvelope::Small.max_bytes() == 16 * 1024);
    assert_eq!(SnapshotEnvelope::Small.max_bytes(), 16 * 1024);
}

#[test]
fn medium_envelope_max_bytes_returns_two_hundred_fifty_six_kib() {
    const _CHECK: () = assert!(SnapshotEnvelope::Medium.max_bytes() == 256 * 1024);
    assert_eq!(SnapshotEnvelope::Medium.max_bytes(), 256 * 1024);
}

#[test]
fn large_envelope_max_bytes_returns_four_mib() {
    const _CHECK: () = assert!(SnapshotEnvelope::Large.max_bytes() == 4 * 1024 * 1024);
    assert_eq!(SnapshotEnvelope::Large.max_bytes(), 4 * 1024 * 1024);
}

#[test]
fn manifest_carries_envelope_class_field_for_each_tier() {
    for envelope_class in [
        SnapshotEnvelope::Small,
        SnapshotEnvelope::Medium,
        SnapshotEnvelope::Large,
    ] {
        let manifest = SnapshotManifest::new("port-fixture", envelope_class);
        assert_eq!(manifest.inspectable_id, "port-fixture");
        assert_eq!(manifest.envelope_class, envelope_class);
    }
}

// =====================================================================
// 2. Medium-class round trip on a simulated RealLive Sweetie HD scene-1
//    state shape: int bank (1000 entries × i32) + str bank
//    (200 entries × ~32-char String) + 4 graphics layers with
//    {asset_id, affine transform, blend_mode}.
// =====================================================================

const REALLIVE_INSPECTABLE_ID: &str = "reallive-sweetie-hd";
const REALLIVE_INT_BANK_ENTRIES: usize = 1000;
const REALLIVE_STR_BANK_ENTRIES: usize = 200;
const REALLIVE_STR_LEN: usize = 32;
const REALLIVE_GRAPHICS_LAYERS: usize = 4;

struct SimulatedRealLivePort;

impl Inspectable for SimulatedRealLivePort {
    fn inspectable_id(&self) -> &'static str {
        REALLIVE_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();

        // RealLive int bank: A[0..999] = i (deterministic seed value).
        // Stored as `port.int_bank.<idx>` per-entry leaves so the path
        // taxonomy is honored.
        for idx in 0..REALLIVE_INT_BANK_ENTRIES {
            let path = StatePath::parse(&format!("port.int_bank.a_{idx}")).expect("int bank path");
            tree.insert(path, StateValue::Int { value: idx as i64 })?;
        }

        // RealLive str bank: S[0..199] = "scene_1_str_<idx>_padding..."
        // (32-char strings).
        for idx in 0..REALLIVE_STR_BANK_ENTRIES {
            let path = StatePath::parse(&format!("port.str_bank.s_{idx}")).expect("str bank path");
            let value = format!("{:width$}", format!("s_{idx}"), width = REALLIVE_STR_LEN);
            tree.insert(path, StateValue::String { value })?;
        }

        // Graphics: 4 layers; each layer carries asset_id + affine
        // transform (tx/ty/sx/sy/rot) + blend_mode. The transform fields
        // land as individual leaves so each is path-keyed and diffable.
        for layer in 0..REALLIVE_GRAPHICS_LAYERS {
            let asset_path = StatePath::parse(&format!("port.graphics.layer_{layer}.asset"))
                .expect("layer asset path");
            tree.insert(
                asset_path,
                StateValue::AssetId {
                    value: AssetId::parse(&format!("vfs://www/g00/scene_1_layer_{layer}.png"))
                        .expect("asset id"),
                },
            )?;
            for (axis, value) in [("tx", 0), ("ty", 1), ("sx", 1), ("sy", 1), ("rot", 0)] {
                let path =
                    StatePath::parse(&format!("port.graphics.layer_{layer}.transform_{axis}"))
                        .expect("transform leaf path");
                tree.insert(path, StateValue::Int { value })?;
            }
            let blend_path = StatePath::parse(&format!("port.graphics.layer_{layer}.blend_mode"))
                .expect("blend mode path");
            tree.insert(
                blend_path,
                StateValue::String {
                    value: "normal".to_string(),
                },
            )?;
        }

        Ok(tree)
    }
}

#[test]
fn reallive_sweetie_hd_scene_1_round_trips_byte_equal_through_medium_envelope() {
    let port = SimulatedRealLivePort;
    let manifest = SnapshotManifest::new(REALLIVE_INSPECTABLE_ID, SnapshotEnvelope::Medium);
    let request = SnapshotRequest::new(
        "reallive-roundtrip-run",
        "2026-06-23T12:00:00Z",
        EvidenceTier::E2,
    )
    .with_envelope_class(manifest.envelope_class)
    .with_tick(1);

    let snapshot = take_snapshot(&port, &request).expect("medium envelope snapshot");

    // Serialize → deserialize → serialize → byte-equal compare.
    let bytes_a = serde_json::to_vec(&snapshot).expect("serialize a");
    let value: serde_json::Value = serde_json::from_slice(&bytes_a).expect("deserialize roundtrip");
    let restored = Snapshot::from_json_value(value).expect("restored snapshot validates");
    let bytes_b = serde_json::to_vec(&restored).expect("serialize b");
    assert_eq!(
        bytes_a, bytes_b,
        "canonical serialized form must be byte-equal on round trip"
    );
    assert_eq!(restored, snapshot, "restored snapshot must equal original");

    // Size must land between 64 KiB and 256 KiB (Medium ceiling).
    let observed = bytes_a.len();
    assert!(
        observed >= 64 * 1024,
        "RealLive Sweetie HD scene-1 snapshot below 64 KiB floor: observed={observed}"
    );
    assert!(
        observed <= SnapshotEnvelope::Medium.max_bytes(),
        "RealLive Sweetie HD scene-1 snapshot above Medium ceiling: observed={observed} ceiling={}",
        SnapshotEnvelope::Medium.max_bytes()
    );

    // Print the byte count so the test log reports the actual figure.
    eprintln!(
        "reallive_sweetie_hd_scene_1 medium snapshot size = {observed} bytes \
         (floor=65536, ceiling={})",
        SnapshotEnvelope::Medium.max_bytes()
    );

    // The declared envelope class is carried on the wire.
    assert_eq!(restored.envelope_class(), SnapshotEnvelope::Medium);
}

// =====================================================================
// 3. Small-class overflow returns typed `SnapshotEnvelopeOverflow` and
//    no output is constructed.
// =====================================================================

const OVERSIZE_INSPECTABLE_ID: &str = "oversize-small-port";

struct OversizeSmallPort;

impl Inspectable for OversizeSmallPort {
    fn inspectable_id(&self) -> &'static str {
        OVERSIZE_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        // Build a state tree whose serialized form exceeds the Small
        // tier's 16 KiB ceiling. 300 string leaves × 64 chars each ≈
        // 19.2 KiB raw payload before JSON overhead.
        let mut tree = StateTree::new();
        for idx in 0..300u32 {
            let path = StatePath::parse(&format!("port.entry_{idx}")).expect("path");
            tree.insert(
                path,
                StateValue::String {
                    value: "x".repeat(64),
                },
            )?;
        }
        Ok(tree)
    }
}

#[test]
fn small_envelope_overflow_returns_typed_error_and_writes_nothing() {
    let port = OversizeSmallPort;
    let manifest = SnapshotManifest::new(OVERSIZE_INSPECTABLE_ID, SnapshotEnvelope::Small);
    let request = SnapshotRequest::new(
        "small-overflow-run",
        "2026-06-23T12:00:00Z",
        EvidenceTier::E2,
    )
    .with_envelope_class(manifest.envelope_class)
    .with_tick(1);

    let result: Result<Snapshot, SnapshotError> = take_snapshot(&port, &request);

    match result {
        Err(SnapshotError::SnapshotEnvelopeOverflow {
            envelope_class,
            observed_bytes,
            limit_bytes,
        }) => {
            assert_eq!(envelope_class, SnapshotEnvelope::Small);
            assert_eq!(limit_bytes, 16 * 1024);
            assert!(
                observed_bytes > limit_bytes,
                "observed_bytes={observed_bytes} must exceed limit_bytes={limit_bytes}"
            );
            eprintln!("small overflow observed_bytes={observed_bytes} limit_bytes={limit_bytes}");
        }
        Err(other) => panic!("expected SnapshotEnvelopeOverflow; got {other:?}"),
        Ok(_) => panic!("expected SnapshotEnvelopeOverflow; got Ok"),
    }

    // "writes nothing" — the substrate's `take_snapshot` is pure: a
    // failed call returns `Err` without yielding a `Snapshot` value.
    // There is no on-disk side effect for the substrate to roll back.
    // We assert the in-memory equivalent: no `Snapshot` was bound.
    assert!(
        take_snapshot(&port, &request).is_err(),
        "repeat call also fails; no cached partial result leaked"
    );
}

// =====================================================================
// 4. Second engine family round trip — MV/MZ `.rpgsave` shape.
// =====================================================================

const MVMZ_INSPECTABLE_ID: &str = "mv-mz-rpgsave";
const MVMZ_VARIABLE_ENTRIES: usize = 600;
const MVMZ_SWITCH_ENTRIES: usize = 200;

struct SimulatedMvMzPort;

impl Inspectable for SimulatedMvMzPort {
    fn inspectable_id(&self) -> &'static str {
        MVMZ_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();

        // $gameSystem: nested system state. Each leaf goes under a stable
        // path. The substrate's `port.*` namespace mirrors the
        // engine-port escape hatch.
        for (key, value) in [
            ("frame_count", 12_345_i64),
            ("save_count", 4_i64),
            ("battle_count", 17_i64),
            ("playtime_seconds", 18_300_i64),
            ("window_tone_r", -32_i64),
            ("window_tone_g", 0_i64),
            ("window_tone_b", 24_i64),
        ] {
            let path = StatePath::parse(&format!("port.game_system.{key}")).expect("system path");
            tree.insert(path, StateValue::Int { value })?;
        }
        for key in ["version_id", "save_id"] {
            let path = StatePath::parse(&format!("port.game_system.{key}")).expect("system path");
            tree.insert(
                path,
                StateValue::String {
                    value: format!("mvmz-{key}-token-padding-padding"),
                },
            )?;
        }

        // $gameMap: current map id + position + nested event states.
        for (key, value) in [
            ("map_id", 8_i64),
            ("player_x", 12_i64),
            ("player_y", 9_i64),
            ("scroll_x", 240_i64),
            ("scroll_y", 160_i64),
            ("interpreter_event_id", 42_i64),
        ] {
            let path = StatePath::parse(&format!("port.game_map.{key}")).expect("map path");
            tree.insert(path, StateValue::Int { value })?;
        }
        for event_idx in 0..40 {
            let path = StatePath::parse(&format!("port.game_map.events.evt_{event_idx}_label"))
                .expect("event path");
            tree.insert(
                path,
                StateValue::String {
                    value: format!("event-{event_idx}-name-padding-padding"),
                },
            )?;
        }

        // $gameVariables: large flat array of mixed-type variables (the
        // largest section of a real `.rpgsave`).
        for idx in 0..MVMZ_VARIABLE_ENTRIES {
            let path =
                StatePath::parse(&format!("port.game_variables.var_{idx}")).expect("variable path");
            tree.insert(
                path,
                StateValue::Int {
                    value: (idx as i64) * 7,
                },
            )?;
        }

        // $gameSwitches: boolean array.
        for idx in 0..MVMZ_SWITCH_ENTRIES {
            let path =
                StatePath::parse(&format!("port.game_switches.sw_{idx}")).expect("switch path");
            tree.insert(
                path,
                StateValue::Bool {
                    value: idx.is_multiple_of(3),
                },
            )?;
        }

        Ok(tree)
    }
}

#[test]
fn mv_mz_rpgsave_round_trips_byte_equal_through_medium_envelope() {
    let port = SimulatedMvMzPort;
    let manifest = SnapshotManifest::new(MVMZ_INSPECTABLE_ID, SnapshotEnvelope::Medium);
    let request = SnapshotRequest::new(
        "mvmz-roundtrip-run",
        "2026-06-23T12:00:00Z",
        EvidenceTier::E2,
    )
    .with_envelope_class(manifest.envelope_class)
    .with_tick(1);

    let snapshot = take_snapshot(&port, &request).expect("mv/mz medium snapshot");

    let bytes_a = serde_json::to_vec(&snapshot).expect("serialize a");
    let value: serde_json::Value = serde_json::from_slice(&bytes_a).expect("deserialize roundtrip");
    let restored = Snapshot::from_json_value(value).expect("restored snapshot validates");
    let bytes_b = serde_json::to_vec(&restored).expect("serialize b");
    assert_eq!(
        bytes_a, bytes_b,
        "MV/MZ canonical serialized form must be byte-equal on round trip"
    );
    assert_eq!(restored, snapshot);

    let observed = bytes_a.len();
    // Non-trivial size requirement: spec calls "~50 KiB total". Use
    // ≥32 KiB as the lower floor so the test is robust to small
    // formatting drift across serde-json versions; ceiling is the
    // Medium tier max.
    assert!(
        observed >= 32 * 1024,
        "MV/MZ snapshot below 32 KiB non-trivial floor: observed={observed}"
    );
    assert!(
        observed <= SnapshotEnvelope::Medium.max_bytes(),
        "MV/MZ snapshot above Medium ceiling: observed={observed}"
    );
    eprintln!(
        "mv_mz_rpgsave medium snapshot size = {observed} bytes \
         (floor=32768, ceiling={})",
        SnapshotEnvelope::Medium.max_bytes()
    );
    assert_eq!(restored.envelope_class(), SnapshotEnvelope::Medium);
}
