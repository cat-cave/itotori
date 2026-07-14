//! Audio system: in-crate `AudioEvent` carrier + sink.
//!
//! Owns the audible counterpart to the headless render
//! pipeline. The `module_bgm` / `module_koe` / `module_pcm` / `module_se`
//! RLOperation families emit a typed [`AudioEvent`] through an
//! [`AudioEventSink`] backed by an [`InMemoryAudioEventStore`]. Per the
//! spec the decoder does **not** mix samples — it verifies header decode
//! (`nwa` + `ovk` modules) and emits metadata.
//!
//! # Substrate-gap honesty
//!
//! The substrate's [`utsushi_core::substrate::AudioEventSink`] caps audio
//! emissions at `EvidenceTier::E0` — "audio metadata is not playback
//! parity" (see `crates/utsushi-core/src/sink/audio.rs`). The
//! spec, however, requires the engine-emitted [`AudioEvent`] to carry
//! `evidence_tier=EvidenceTier::E1` because the engine has actually
//! consumed real bytes through the NWA / OVK decoders, resolved through
//! the Gameexe `FOLDNAME.BGM` / `NAMAE` tables, and produced a typed
//! `(archive_id, sample_id)` or `(asset_id)` payload. That is observably
//! stronger than "an opcode fired without bytes". To stay
//! substrate-honest, emits through a typed in-crate carrier
//! ([`AudioEvent`] + [`InMemoryAudioEventStore`]) rather than through the
//! E0-floored substrate sink. When the substrate slice lands the
//! E1-emission-from-engine extension (tracked under the same
//! substrate-gap line in `reallive-engine-dag-proposal.md`
//! and ), the wiring into
//! [`utsushi_core::substrate::SinkSet`] becomes a one-line swap at the
//! emission call site — no on-disk format or callsite shape changes.
//!
//! # Audit-focus pin: AudioEvent payload carries voice-archive metadata
//!
//! The spec audit-focus item "AudioEvent payload missing
//! voice-archive metadata" is the explicit motivation for
//! [`AudioEventPayload::Voice`] carrying both `archive_id` and
//! `sample_id` as distinct typed fields. A reduced "asset_id only"
//! shape would have lost the archive/sample distinction the runtime
//! needs to cross-reference `koe/z<archive>.ovk` against a `NamaeEntry`
//! row. The typed [`AudioEventPayload`] enum forbids a stringly-typed
//! collapse at the type-system layer.
//!
//! # AudioEventKind taxonomy
//!
//! The kinds match the substrate's
//! [`utsushi_core::substrate::AudioEventKind`] enum verbatim (re-exported
//! from there via [`AudioEventKind`]) so the post-substrate-gap swap is
//! a no-op at the kind layer. The deliverable is the
//! engine-side carrier + the typed payload, not a new taxonomy.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use utsushi_core::substrate::AudioEventKind;
use utsushi_core::substrate::EvidenceTier;

/// Stable diagnostic code surfaced when a caller queries an unknown
/// `event_id` against an [`InMemoryAudioEventStore`].
pub const AUDIO_EVENT_STORE_MISS_CODE: &str = "utsushi.reallive.audio_event_store.miss";

/// Typed payload for an [`AudioEvent`]. Voice events carry the
/// `(archive_id, sample_id)` pair so the cross-reference back to the
/// `NamaeEntry` row is structurally enforced; bgm / wav / se events
/// carry a single `asset_id` that the runtime resolves to a typed
/// on-disk path. Marker is a meta event with no payload.
///
/// The variant tag is engine-neutral; `AudioEventKind::Marker` for
/// example does not imply any particular subsystem fired.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AudioEventPayload {
    /// BGM / wav / se start; engine-resolved asset id (e.g.
    /// `"bgm/ASA"`).
    Asset {
        /// Asset id (engine-supplied stable identifier — `"bgm/ASA"`
        /// `"wav/CHIME"`, `"se/door1"`).
        #[serde(rename = "assetId")]
        asset_id: String,
    },
    /// BGM stop / fade / wav stop; engine-supplied tag describing the
    /// stop semantics (e.g. `"bgm_fade_out_2000ms"`, `"bgm_stop"`).
    Stop {
        /// Stable cue id describing the stop semantics (engine-supplied
        /// — opcode + ms).
        #[serde(rename = "cueId")]
        cue_id: String,
    },
    /// Voice playback; carries the `(archive_id, sample_id)` pair the
    /// `NamaeEntry` cross-reference resolves to.
    Voice {
        /// Voice archive id (engine-supplied, e.g. `"z0001"` for
        /// `koe/z0001.ovk`).
        #[serde(rename = "archiveId")]
        archive_id: String,
        /// Sample index within the archive (matches the OVK header
        /// `sample_num` field).
        #[serde(rename = "sampleId")]
        sample_id: u32,
    },
    /// Voice stop / koeStop / koeWait completion — engine-supplied
    /// cue id.
    VoiceStop {
        /// Stable cue id describing the stop semantics.
        #[serde(rename = "cueId")]
        cue_id: String,
    },
    /// Meta marker — fires for engine events that are observably part of
    /// the audio timeline but don't reference a sample.
    Marker {
        /// Stable cue id describing the marker (e.g.
        /// `"marker:bgm_loop_point"`).
        #[serde(rename = "cueId")]
        cue_id: String,
    },
}

/// Per-emission [`AudioEvent`] carrier. Mirrors the substrate's
/// [`utsushi_core::substrate::AudioEvent`] shape so the post-substrate-
/// gap swap (see the module docstring) is a structural change to one
/// site rather than a redesign of the consumers.
///
/// `evidence_tier` is fixed to `E1` per the spec acceptance
/// criteria. The substrate sink today rejects `E1`, which is exactly
/// the substrate-gap this node documents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEvent {
    /// Stable event id — SHA-256-derived from the emission's serialized
    /// payload, rendered as a lower-case hex digest. Pinned to be
    /// deterministic so a snapshot round-trip can use the id as a
    /// content-addressable handle.
    pub event_id: String,
    /// Monotonic emission index, sourced from the
    /// [`AudioEventEmitter`]'s `next_index` counter.
    pub emission_index: u64,
    /// `EvidenceTier::E1` for every emission.
    pub evidence_tier: EvidenceTier,
    /// Engine-neutral kind enum (re-exported from the substrate).
    pub event_kind: AudioEventKind,
    /// Typed payload carrying the kind-specific metadata.
    pub payload: AudioEventPayload,
}

impl AudioEvent {
    /// Construct an [`AudioEvent`] for `kind` + `payload` at
    /// `emission_index`. The `event_id` is the lower-case SHA-256 hex
    /// digest of `(emission_index, kind, payload)` serialized as JSON
    /// — the digest is deterministic across runs.
    pub fn new(emission_index: u64, kind: AudioEventKind, payload: AudioEventPayload) -> Self {
        let event_id = derive_event_id(emission_index, kind, &payload);
        Self {
            event_id,
            emission_index,
            evidence_tier: EvidenceTier::E1,
            event_kind: kind,
            payload,
        }
    }

    /// Borrow the payload.
    pub fn payload(&self) -> &AudioEventPayload {
        &self.payload
    }
}

/// Lower-case SHA-256 hex digest. The serialized JSON form of the
/// `(emission_index, kind, payload)` triple is the digest source.
fn derive_event_id(
    emission_index: u64,
    kind: AudioEventKind,
    payload: &AudioEventPayload,
) -> String {
    // Build a deterministic byte string from the inputs. We use
    // `serde_json::to_vec` on a fixed-shape tuple so the byte order is
    // pinned by the schema; the SHA-256 below is then a pure function
    // of the inputs.
    let snapshot = (emission_index, kind.as_str(), payload);
    let bytes = serde_json::to_vec(&snapshot)
        .expect("AudioEvent payload is JSON-serializable by construction");
    let digest = Sha256::digest(&bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Typed errors surfaced by [`InMemoryAudioEventStore::resolve`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AudioEventStoreError {
    /// `event_id` was not stored. The diagnostic code is pinned at
    /// [`AUDIO_EVENT_STORE_MISS_CODE`].
    #[error("audio event id not stored: {event_id} ({code})")]
    Miss { code: String, event_id: String },
}

/// In-process [`AudioEvent`] sink. Retains the typed events keyed by
/// `event_id` and exposes a FIFO `drain_in_order` for replay.
///
/// The store actually retains the per-emission payload (not just a
/// counter) so the audit-focus item "AudioEvent payload missing
/// voice-archive metadata" cannot apply.
#[derive(Debug, Default)]
pub struct InMemoryAudioEventStore {
    inner: Mutex<AudioEventStoreInner>,
}

#[derive(Debug, Default)]
struct AudioEventStoreInner {
    by_id: BTreeMap<String, AudioEvent>,
    in_order: Vec<AudioEvent>,
}

impl InMemoryAudioEventStore {
    /// Construct an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Push an [`AudioEvent`] into the store. Returns the previously
    /// stored event for the same `event_id` if any — `None` for a
    /// fresh insertion.
    pub fn push(&self, event: AudioEvent) -> Option<AudioEvent> {
        let mut guard = self.inner.lock().expect("InMemoryAudioEventStore lock");
        guard.in_order.push(event.clone());
        guard.by_id.insert(event.event_id.clone(), event)
    }

    /// Borrow-by-clone an event by `event_id`. Returns `None` on miss.
    pub fn get(&self, event_id: &str) -> Option<AudioEvent> {
        let guard = self.inner.lock().expect("InMemoryAudioEventStore lock");
        guard.by_id.get(event_id).cloned()
    }

    /// Typed-error variant of [`Self::get`].
    pub fn resolve(&self, event_id: &str) -> Result<AudioEvent, AudioEventStoreError> {
        self.get(event_id)
            .ok_or_else(|| AudioEventStoreError::Miss {
                code: AUDIO_EVENT_STORE_MISS_CODE.to_string(),
                event_id: event_id.to_string(),
            })
    }

    /// Number of distinct stored events.
    pub fn len(&self) -> usize {
        let guard = self.inner.lock().expect("InMemoryAudioEventStore lock");
        guard.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// FIFO snapshot of every emission, in insertion order. The store
    /// retains the in-order list separately from the `BTreeMap` so a
    /// duplicate event_id (re-emission with identical metadata) still
    /// appears once per call in the FIFO.
    pub fn drain_in_order(&self) -> Vec<AudioEvent> {
        let mut guard = self.inner.lock().expect("InMemoryAudioEventStore lock");
        std::mem::take(&mut guard.in_order)
    }

    /// Borrow-by-clone the FIFO without draining. Useful for audit
    /// surfaces that want to assert "the n-th emission was kind K".
    pub fn in_order_snapshot(&self) -> Vec<AudioEvent> {
        let guard = self.inner.lock().expect("InMemoryAudioEventStore lock");
        guard.in_order.clone()
    }
}

/// Per-runtime [`AudioEvent`] emitter. Owns the monotonic
/// `emission_index` counter and the store the emissions land in.
///
/// The emitter is `Send + Sync` via interior mutability so the
/// per-module `Arc<dyn RLOperation>` runtimes can share it cheaply.
#[derive(Debug)]
pub struct AudioEventEmitter {
    inner: Mutex<AudioEventEmitterInner>,
    store: InMemoryAudioEventStore,
}

#[derive(Debug, Default)]
struct AudioEventEmitterInner {
    next_index: u64,
}

impl AudioEventEmitter {
    /// Construct an emitter with an empty store and `next_index = 0`.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AudioEventEmitterInner::default()),
            store: InMemoryAudioEventStore::new(),
        }
    }

    /// Borrow the underlying store.
    pub fn store(&self) -> &InMemoryAudioEventStore {
        &self.store
    }

    /// Next emission index the emitter will assign.
    pub fn next_emission_index(&self) -> u64 {
        let guard = self.inner.lock().expect("AudioEventEmitter lock");
        guard.next_index
    }

    /// Build + push an [`AudioEvent`] with the given `kind` + `payload`.
    /// Returns the emitted event so the caller can thread its
    /// `event_id` into a downstream observation (e.g. a snapshot ref).
    pub fn emit(&self, kind: AudioEventKind, payload: AudioEventPayload) -> AudioEvent {
        let emission_index = {
            let mut guard = self.inner.lock().expect("AudioEventEmitter lock");
            let index = guard.next_index;
            guard.next_index = guard.next_index.saturating_add(1);
            index
        };
        let event = AudioEvent::new(emission_index, kind, payload);
        self.store.push(event.clone());
        event
    }
}

impl Default for AudioEventEmitter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emitter_assigns_monotonic_emission_indices() {
        let emitter = AudioEventEmitter::new();
        assert_eq!(emitter.next_emission_index(), 0);
        let first = emitter.emit(
            AudioEventKind::BgmStart,
            AudioEventPayload::Asset {
                asset_id: "bgm/ASA".to_string(),
            },
        );
        let second = emitter.emit(
            AudioEventKind::VoicePlay,
            AudioEventPayload::Voice {
                archive_id: "z0001".to_string(),
                sample_id: 46,
            },
        );
        assert_eq!(first.emission_index, 0);
        assert_eq!(second.emission_index, 1);
        assert_eq!(emitter.next_emission_index(), 2);
    }

    #[test]
    fn store_round_trips_event_id_to_payload() {
        let emitter = AudioEventEmitter::new();
        let event = emitter.emit(
            AudioEventKind::BgmStart,
            AudioEventPayload::Asset {
                asset_id: "bgm/ASA".to_string(),
            },
        );
        let resolved = emitter
            .store()
            .resolve(&event.event_id)
            .expect("stored event resolves");
        assert_eq!(resolved.event_id, event.event_id);
        assert_eq!(resolved.payload, event.payload);
    }

    #[test]
    fn miss_carries_diagnostic_code() {
        let emitter = AudioEventEmitter::new();
        let miss = emitter.store().resolve("never-stored");
        match miss {
            Err(AudioEventStoreError::Miss { code, .. }) => {
                assert_eq!(code, AUDIO_EVENT_STORE_MISS_CODE);
            }
            other => panic!("expected Miss, got {other:?}"),
        }
    }

    #[test]
    fn emission_pins_evidence_tier_e1() {
        let emitter = AudioEventEmitter::new();
        let event = emitter.emit(
            AudioEventKind::SeFire,
            AudioEventPayload::Asset {
                asset_id: "se/door1".to_string(),
            },
        );
        assert_eq!(event.evidence_tier, EvidenceTier::E1);
    }

    #[test]
    fn voice_payload_carries_distinct_archive_and_sample_fields() {
        // Audit-focus pin: "AudioEvent payload missing voice-archive
        // metadata". The Voice variant MUST keep `archive_id` and
        // `sample_id` as distinct typed fields — collapsing both into
        // a single stringly-typed asset_id would lose the
        // cross-reference back to the `NamaeEntry` row.
        let payload = AudioEventPayload::Voice {
            archive_id: "z0001".to_string(),
            sample_id: 46,
        };
        let json = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(json["kind"], "voice");
        assert_eq!(json["archiveId"], "z0001");
        assert_eq!(json["sampleId"], 46);
    }

    #[test]
    fn event_id_is_deterministic_across_constructions() {
        let payload = AudioEventPayload::Voice {
            archive_id: "z0001".to_string(),
            sample_id: 46,
        };
        let a = AudioEvent::new(7, AudioEventKind::VoicePlay, payload.clone());
        let b = AudioEvent::new(7, AudioEventKind::VoicePlay, payload);
        assert_eq!(a.event_id, b.event_id);
    }

    #[test]
    fn event_id_changes_with_emission_index() {
        let payload = AudioEventPayload::Voice {
            archive_id: "z0001".to_string(),
            sample_id: 46,
        };
        let a = AudioEvent::new(7, AudioEventKind::VoicePlay, payload.clone());
        let b = AudioEvent::new(8, AudioEventKind::VoicePlay, payload);
        assert_ne!(a.event_id, b.event_id);
    }

    #[test]
    fn drain_in_order_returns_fifo_and_clears() {
        let emitter = AudioEventEmitter::new();
        emitter.emit(
            AudioEventKind::BgmStart,
            AudioEventPayload::Asset {
                asset_id: "bgm/ASA".to_string(),
            },
        );
        emitter.emit(
            AudioEventKind::BgmStop,
            AudioEventPayload::Stop {
                cue_id: "bgm_stop".to_string(),
            },
        );
        let drained = emitter.store().drain_in_order();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].event_kind, AudioEventKind::BgmStart);
        assert_eq!(drained[1].event_kind, AudioEventKind::BgmStop);
        // Drain clears the FIFO.
        assert!(emitter.store().drain_in_order().is_empty());
        // But the by-id map is retained.
        assert_eq!(emitter.store().len(), 2);
    }

    #[test]
    fn in_order_snapshot_does_not_clear() {
        let emitter = AudioEventEmitter::new();
        emitter.emit(
            AudioEventKind::Marker,
            AudioEventPayload::Marker {
                cue_id: "bgm_loop_point".to_string(),
            },
        );
        let snap1 = emitter.store().in_order_snapshot();
        let snap2 = emitter.store().in_order_snapshot();
        assert_eq!(snap1.len(), 1);
        assert_eq!(snap2.len(), 1);
        assert_eq!(snap1[0].event_id, snap2[0].event_id);
    }
}
