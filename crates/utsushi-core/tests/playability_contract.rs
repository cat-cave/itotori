//! Public synthetic proof for the engine-neutral playability contract.
//!
//! This mini-program deliberately contains no corpus data. A green result
//! proves the harness detects input/branch causality; it does not establish
//! that any real installation is playable.

use std::convert::Infallible;
use std::process::Command;

use utsushi_core::{
    CanonicalState, ClockOrigin, InputEvent, InputGate, InputKind, LogicalClockTick, Observation,
    PlayabilityDriver, PlayabilityError, PublicContractStatus, ReplayEntry, ReplayMetadata,
    SemanticEvent, StatePath, StateTree, StateValue, replay_in_fresh_process, replay_log, run,
};

const FRESH_PROCESS_WORKER_ARG: &str = "--utsushi-playability-fresh-process-worker";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProgramPoint {
    Intro,
    Choice,
    Branch(u16),
}

#[derive(Clone, Debug)]
struct ProgramSession {
    point: ProgramPoint,
}

#[derive(Clone, Copy)]
struct TwoOptionProgram {
    /// Deliberate mutation seam: the broken implementation substitutes option
    /// zero for every selected option, like a precomputed trace player.
    force_first_option: bool,
}

impl TwoOptionProgram {
    fn live() -> Self {
        Self {
            force_first_option: false,
        }
    }

    fn precomputed_first_option() -> Self {
        Self {
            force_first_option: true,
        }
    }
}

impl PlayabilityDriver for TwoOptionProgram {
    type Session = ProgramSession;
    type Error = Infallible;

    fn boot_clean(&self) -> Result<Self::Session, Self::Error> {
        // This is the synthetic equivalent of a new process: each call owns a
        // newly allocated session with no state shared from any prior replay.
        Ok(ProgramSession {
            point: ProgramPoint::Intro,
        })
    }

    fn await_gate(&self, session: &mut Self::Session) -> Result<InputGate, Self::Error> {
        let gate = match session.point {
            ProgramPoint::Intro => InputGate {
                accepted: vec![InputKind::Advance],
                choice_options: Vec::new(),
            },
            ProgramPoint::Choice => InputGate {
                accepted: vec![InputKind::Choice],
                choice_options: vec!["option-0".to_string(), "option-1".to_string()],
            },
            ProgramPoint::Branch(_) => InputGate {
                accepted: Vec::new(),
                choice_options: Vec::new(),
            },
        };
        Ok(gate)
    }

    fn apply_input(
        &self,
        session: &mut Self::Session,
        input: &InputEvent,
    ) -> Result<Observation, Self::Error> {
        let semantic_events = match (&session.point, input) {
            (ProgramPoint::Intro, InputEvent::Advance {}) => {
                session.point = ProgramPoint::Choice;
                vec![SemanticEvent::Transition {
                    state: "choice-presented".to_string(),
                }]
            }
            (ProgramPoint::Choice, InputEvent::Choice { index, .. }) => {
                let committed = if self.force_first_option {
                    0
                } else {
                    index.get()
                };
                session.point = ProgramPoint::Branch(committed);
                vec![
                    SemanticEvent::ChoiceCommitted { index: committed },
                    SemanticEvent::Transition {
                        state: format!("branch-{committed}"),
                    },
                ]
            }
            _ => Vec::new(),
        };
        Ok(Observation {
            consumed: vec![input.clone()],
            semantic_events,
        })
    }

    fn canonical_state(&self, session: &Self::Session) -> Result<CanonicalState, Self::Error> {
        let point = match session.point {
            ProgramPoint::Intro => "intro".to_string(),
            ProgramPoint::Choice => "choice".to_string(),
            ProgramPoint::Branch(index) => format!("branch-{index}"),
        };
        let mut state = StateTree::new();
        state
            .insert(
                StatePath::parse("port.program_point").expect("valid synthetic state path"),
                StateValue::String { value: point },
            )
            .expect("valid synthetic state");
        state
            .insert(
                StatePath::parse("port.surface_kind").expect("valid synthetic state path"),
                StateValue::String {
                    value: "synthetic".to_string(),
                },
            )
            .expect("valid synthetic state");
        Ok(CanonicalState::new(state).expect("state tree validates"))
    }
}

fn two_option_log(selected: u16) -> utsushi_core::ReplayLog {
    replay_log(
        ReplayMetadata::new(
            "public-contract-run",
            "synthetic-playability",
            "v1",
            ClockOrigin::RunStart,
            0,
            Some("public-contract-only".to_string()),
        ),
        [
            ReplayEntry {
                tick: LogicalClockTick(1),
                event: InputEvent::advance(),
            },
            ReplayEntry {
                tick: LogicalClockTick(2),
                event: InputEvent::choice(selected),
            },
        ],
    )
    .expect("synthetic script is a valid immutable replay log")
}

#[test]
fn synthetic_two_option_scenario_proves_distinct_choice_checkpoints() {
    let driver = TwoOptionProgram::live();
    let first = run(&driver, two_option_log(0)).expect("option zero replays");
    let second = run(&driver, two_option_log(1)).expect("option one replays");

    assert_eq!(first.public_status, PublicContractStatus::NotEstablished);
    assert_eq!(second.public_status, PublicContractStatus::NotEstablished);
    assert_ne!(
        first.checkpoints[1].state_sha256, second.checkpoints[1].state_sha256,
        "the two options must reach distinct immediate semantic checkpoints"
    );
}

#[test]
fn choice_replay_rejects_precomputed_first_option() {
    let error = run(
        &TwoOptionProgram::precomputed_first_option(),
        two_option_log(1),
    )
    .expect_err("a first-option trace substitution must be rejected");

    assert!(matches!(
        error,
        PlayabilityError::ChoiceCommitMismatch {
            expected: 1,
            observed: Some(0)
        }
    ));
    assert_eq!(
        error.to_string(),
        "choice commit mismatch: expected index 1, observed Some(0)"
    );
}

#[test]
fn fresh_process_replay_produces_identical_causal_checkpoints() {
    let proof = replay_in_fresh_process(&TwoOptionProgram::live(), two_option_log(1))
        .expect("new clean process replay must match first execution");

    assert_eq!(proof.first.checkpoints, proof.fresh.checkpoints);
    assert_eq!(proof.first.replay_log, proof.fresh.replay_log);

    let first_child = fresh_process_checkpoints();
    let second_child = fresh_process_checkpoints();
    assert_eq!(
        first_child, second_child,
        "two OS processes must replay the same immutable checkpoints"
    );
}

fn fresh_process_checkpoints() -> String {
    let output = Command::new(std::env::current_exe().expect("test executable path"))
        .args([
            "--exact",
            "fresh_process_worker_emits_checkpoints",
            "--nocapture",
            "--",
            FRESH_PROCESS_WORKER_ARG,
        ])
        .output()
        .expect("start fresh replay process");
    assert!(
        output.status.success(),
        "fresh replay process failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("worker stdout is UTF-8");
    stdout
        .lines()
        .find_map(|line| line.strip_prefix("PLAYABILITY_CHECKPOINTS="))
        .map(str::to_string)
        .expect("fresh replay process emitted checkpoints")
}

#[test]
fn fresh_process_worker_emits_checkpoints() {
    if !std::env::args().any(|arg| arg == FRESH_PROCESS_WORKER_ARG) {
        return;
    }
    let run = run(&TwoOptionProgram::live(), two_option_log(1))
        .expect("child process replays the immutable script");
    let checkpoints = serde_json::to_string(&run.checkpoints).expect("checkpoints serialize");
    println!("PLAYABILITY_CHECKPOINTS={checkpoints}");
}
