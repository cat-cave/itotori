//! Engine-neutral deterministic playability replay contract.
//!
//! This module deliberately proves the runner contract, not that any installed
//! content is playable. Real ports implement [`PlayabilityDriver`] behind this
//! boundary; the public CI fixture is synthetic and always reports
//! [`PublicContractStatus::NotEstablished`].

use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    InputEvent, InputKind, ReplayEntry, ReplayLog, ReplayLogBuilder, ReplayMetadata, StateTree,
};

/// Public-lane status. Synthetic contract success must never read as a title
/// or corpus pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicContractStatus {
    /// The harness contract ran, but no trusted corpus result exists.
    NotEstablished,
}

/// A player-input gate emitted by the same port session that will consume the
/// next input. Choice gates include the complete ordered option set as opaque
/// identifiers; ports must not manufacture a later, different option list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InputGate {
    /// Inputs the port is accepting at this exact point.
    pub accepted: Vec<InputKind>,
    /// Ordered opaque choice options, populated only when choice is accepted.
    pub choice_options: Vec<String>,
}

impl InputGate {
    /// Return whether this gate accepts `input`, including its choice bounds.
    pub fn accepts(&self, input: &InputEvent) -> bool {
        if !self.accepted.contains(&input.kind()) {
            return false;
        }
        match input {
            InputEvent::Choice { index, .. } => {
                usize::from(index.get()) < self.choice_options.len()
            }
            _ => true,
        }
    }
}

/// Semantic effect observed after an input is consumed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SemanticEvent {
    /// A choice was dispatched to the selected option.
    ChoiceCommitted { index: u16 },
    /// The port transitioned to a new named semantic state.
    Transition { state: String },
    /// A persisted slot was written through the player input boundary.
    SaveWritten { slot: u16 },
    /// A persisted slot was loaded through the player input boundary.
    SaveLoaded { slot: u16 },
}

/// Result of dispatching exactly one scripted event at an [`InputGate`].
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    /// Events the port says it consumed. The runner requires exactly one,
    /// equal to the scripted event.
    pub consumed: Vec<InputEvent>,
    /// Causal engine events emitted after consumption.
    pub semantic_events: Vec<SemanticEvent>,
}

/// Redacted, sorted state emitted by a port.
///
/// The validated [`StateTree`] rejects unknown namespaces and host-path-shaped
/// values, while its `BTreeMap` storage fixes serialization order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct CanonicalState(StateTree);

impl CanonicalState {
    /// Construct from a validated, redaction-safe state tree.
    pub fn new(state: StateTree) -> Result<Self, crate::SnapshotError> {
        state.validate()?;
        Ok(Self(state))
    }

    /// SHA-256 over the deterministic JSON representation.
    pub fn sha256(&self) -> String {
        let json = serde_json::to_vec(self).expect("BTreeMap-backed state serializes");
        let digest = Sha256::digest(json);
        format!("{digest:x}")
    }
}

/// A port adapter used by the playability runner.
///
/// `boot_clean` is a process boundary: a production implementation must start
/// a clean port process with no session memory from a previous run. The runner
/// calls it for every replay, so a cached trace or in-memory save cannot stand
/// in for input dispatch.
pub trait PlayabilityDriver {
    /// Opaque, engine-owned session state.
    type Session;
    /// Typed adapter failure.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Start a clean port process at the declared initial state.
    fn boot_clean(&self) -> Result<Self::Session, Self::Error>;
    /// Observe the next real player-input gate for `session`.
    fn await_gate(&self, session: &mut Self::Session) -> Result<InputGate, Self::Error>;
    /// Apply one input to that exact session.
    fn apply_input(
        &self,
        session: &mut Self::Session,
        input: &InputEvent,
    ) -> Result<Observation, Self::Error>;
    /// Return the redacted structural state from that exact session.
    fn canonical_state(&self, session: &Self::Session) -> Result<CanonicalState, Self::Error>;
}

/// A checkpoint tied to the final semantic event caused by one input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CausalCheckpoint {
    /// Logical tick of the scripted event.
    pub logical_tick: u64,
    /// The immediate causal event that led to this state.
    pub causal_event: SemanticEvent,
    /// Validated redacted structural state at this checkpoint.
    pub canonical_state: CanonicalState,
    /// Canonical redacted state digest.
    pub state_sha256: String,
}

/// Immutable evidence from one direct port replay.
#[derive(Clone, Debug, PartialEq)]
pub struct PlayabilityRun {
    /// Synthetic lane result is intentionally not a real-playability status.
    pub public_status: PublicContractStatus,
    /// Recorded immutable input log.
    pub replay_log: ReplayLog,
    /// One causal checkpoint per scripted input.
    pub checkpoints: Vec<CausalCheckpoint>,
}

/// Result of executing a log twice across independent clean process starts.
#[derive(Clone, Debug, PartialEq)]
pub struct FreshProcessReplay {
    /// First direct execution.
    pub first: PlayabilityRun,
    /// Independent clean-process execution of the same immutable log.
    pub fresh: PlayabilityRun,
}

/// Contract failures are explicit; none downgrade to a green skip.
#[derive(Debug)]
pub enum PlayabilityError {
    /// A port adapter returned an error.
    Driver(Box<dyn std::error::Error + Send + Sync>),
    /// The scripted input was not accepted at the observed gate.
    InputWithoutGate { input: InputKind },
    /// The port consumed zero, multiple, or a different input.
    InputNotConsumed { input: InputKind, observed: usize },
    /// A choice commit did not match the selected choice index.
    ChoiceCommitMismatch {
        expected: u16,
        observed: Option<u16>,
    },
    /// Consumption did not cause a semantic engine event.
    MissingSemanticEvent { input: InputKind },
    /// Two clean process replays did not emit identical evidence.
    FreshReplayMismatch,
    /// The replay log could not be constructed from the supplied script.
    ReplayLog(crate::InputError),
}

impl fmt::Display for PlayabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Driver(error) => write!(formatter, "playability driver failed: {error}"),
            Self::InputWithoutGate { input } => {
                write!(formatter, "input {input} had no matching gate")
            }
            Self::InputNotConsumed { input, observed } => write!(
                formatter,
                "input {input} was not consumed exactly once; observed {observed} consumption records"
            ),
            Self::ChoiceCommitMismatch { expected, observed } => write!(
                formatter,
                "choice commit mismatch: expected index {expected}, observed {observed:?}"
            ),
            Self::MissingSemanticEvent { input } => {
                write!(formatter, "input {input} caused no semantic event")
            }
            Self::FreshReplayMismatch => {
                formatter.write_str("fresh-process replay checkpoints differed")
            }
            Self::ReplayLog(error) => write!(formatter, "replay log rejected input: {error}"),
        }
    }
}

impl std::error::Error for PlayabilityError {}

/// Build an immutable replay log from a script using the existing substrate
/// wire format rather than a parallel playability-only log.
pub fn replay_log(
    metadata: ReplayMetadata,
    script: impl IntoIterator<Item = ReplayEntry>,
) -> Result<ReplayLog, PlayabilityError> {
    let mut builder = ReplayLogBuilder::new().metadata(metadata);
    for entry in script {
        builder
            .record(entry.tick, entry.event)
            .map_err(PlayabilityError::ReplayLog)?;
    }
    builder.build().map_err(PlayabilityError::ReplayLog)
}

/// Replay `log` directly against the port, enforcing input-gate causality.
pub fn run<D: PlayabilityDriver>(
    driver: &D,
    log: ReplayLog,
) -> Result<PlayabilityRun, PlayabilityError> {
    let mut session = driver.boot_clean().map_err(box_driver_error)?;
    let mut checkpoints = Vec::with_capacity(log.events().len());
    for entry in log.events() {
        let gate = driver.await_gate(&mut session).map_err(box_driver_error)?;
        if !gate.accepts(&entry.event) {
            return Err(PlayabilityError::InputWithoutGate {
                input: entry.event.kind(),
            });
        }
        let observation = driver
            .apply_input(&mut session, &entry.event)
            .map_err(box_driver_error)?;
        if observation.consumed.as_slice() != [entry.event.clone()] {
            return Err(PlayabilityError::InputNotConsumed {
                input: entry.event.kind(),
                observed: observation.consumed.len(),
            });
        }
        let causal_event = observation.semantic_events.last().cloned().ok_or(
            PlayabilityError::MissingSemanticEvent {
                input: entry.event.kind(),
            },
        )?;
        if let InputEvent::Choice { index, .. } = entry.event {
            let committed = observation
                .semantic_events
                .iter()
                .find_map(|event| match event {
                    SemanticEvent::ChoiceCommitted { index } => Some(*index),
                    _ => None,
                });
            if committed != Some(index.get()) {
                return Err(PlayabilityError::ChoiceCommitMismatch {
                    expected: index.get(),
                    observed: committed,
                });
            }
        }
        let state = driver.canonical_state(&session).map_err(box_driver_error)?;
        checkpoints.push(CausalCheckpoint {
            logical_tick: entry.tick.get(),
            causal_event,
            canonical_state: state.clone(),
            state_sha256: state.sha256(),
        });
    }
    Ok(PlayabilityRun {
        public_status: PublicContractStatus::NotEstablished,
        replay_log: log,
        checkpoints,
    })
}

/// Run an immutable log twice, requiring byte-for-byte equal causal evidence
/// across two independent [`PlayabilityDriver::boot_clean`] calls.
pub fn replay_in_fresh_process<D: PlayabilityDriver>(
    driver: &D,
    log: ReplayLog,
) -> Result<FreshProcessReplay, PlayabilityError> {
    let first = run(driver, log.clone())?;
    let fresh = run(driver, log)?;
    if first != fresh {
        return Err(PlayabilityError::FreshReplayMismatch);
    }
    Ok(FreshProcessReplay { first, fresh })
}

fn box_driver_error(error: impl std::error::Error + Send + Sync + 'static) -> PlayabilityError {
    PlayabilityError::Driver(Box::new(error))
}
