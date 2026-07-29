# Playability program

## Decision and scope

This program makes `playable` a bounded, evidence-bearing status for one
engine, content digest, patch digest, port build, environment, and scenario
manifest. It extends—not replaces—the existing bounded deterministic-route
proposal in [playability-e2e.md](playability-e2e.md): a route proof is useful,
but is not reference fidelity or a claim about untested routes.

No process exit, capability declaration, trace row, non-black frame, layer
count, or absent input is a pass. A result is `passed`, `failed`,
`not_applicable`, `not_established`, or `evidence_invalid`; the last three are
never styled or aggregated as pass. Every `not_applicable` names the discovery
evidence that established absence. Every missing required field or artifact is
`evidence_invalid`, not a partial success.

All replay identities pin content, patch, port build, adapter, environment,
locale, font set, renderer, virtual-clock policy, RNG seed, and schema. A
mismatch refuses replay. State is canonical, sorted, redacted, and versioned;
wall time, host paths, and artifact locations are excluded.

## 1. Capability ladder

The rungs are cumulative. “Observation” is the artifact a reviewer receives,
not a producer-supplied boolean. The stated failure is mandatory: a rung that
cannot take that red path is not a gate.

| Rung                                  | Acceptance predicate                                                                                                                                                                                                                                                                                                                           | Observation that proves it                                                                                                                                            | Limit and required failure                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0 — decoded bytes                    | The pinned input digest decodes into the engine's declared structural units with zero fatal decode errors. The manifest records total/decoded/rejected unit counts.                                                                                                                                                                            | Content-free decode report, input digest, parser version, and rejected-unit reasons.                                                                                  | It says nothing about execution. Missing input, zero decoded units, count mismatch, or an unclassified rejection fails; an empty scan cannot pass.                                                                            |
| C1 — content reaches a player gate    | A clean port executes decoded content until it renders non-empty player-facing text or a choice and emits a gate from that same session.                                                                                                                                                                                                       | Immutable trace joins content load, surface digest/frame, gate kind, ordered choice count, logical tick, and discovery candidates/rejections.                         | It does not prove the next action works. A synthetic gate, empty surface, exhausted budget, or gate without a visible surface fails.                                                                                          |
| C2 — causal player control            | At each scripted gate, the exact input is accepted once, causes a semantic event, and reaches the asserted immediate canonical checkpoint. For a choice, every selected index commits the same index and at least one pair differs immediately.                                                                                                | Replay log; gate/input/consumption/event/checkpoint chain; canonical state digests.                                                                                   | It does not prove rendered output or persistence. Early/late/unconsumed/extra input, missing event, wrong commit, or equal required branch pair fails.                                                                        |
| C3 — observed play surface            | Each claimed text, choice, backlog, timing, or audio operation has its corresponding visible or audible observation at fixed logical ticks.                                                                                                                                                                                                    | Lossless checkpoint frames plus bounds/glyph diagnostics; PCM windows and transport markers where audio is claimed; a private visual verdict for each selected frame. | A state change can still paint nothing or audio metadata can still be silent. Missing frame/verdict, incoherent or illegible private frame, out-of-bounds text, missing decoder/channel, or silent required PCM window fails. |
| C4 — durable route                    | The required route scenarios succeed through the player boundary: advance, choice, persisted save/load across process replacement, text presentation, and applicable backlog, speed, auto, volume, and voice controls.                                                                                                                         | Scenario result matrix, saved-state and fresh-process comparisons, paired control experiments, and C3 artifacts.                                                      | It proves only the selected route. An in-memory save, setting with no behavior change, auto transition with injected advance, or unsupported required control fails.                                                          |
| C5 — patched route                    | Original and patched runs use the same approved log; structural checkpoints, gate arity, commits, and save/load agree while each selected changed surface matches its private target digest and differs from its source digest.                                                                                                                | Paired private result bundle; redacted public derivative; target/source digest report; glyph, encoding, layout, and redaction verdicts.                               | It does not judge translation quality or establish reference fidelity. Missing expectation, unchanged replacement, lookalike route, encoding/layout failure, or public redaction leak fails.                                  |
| C6 — reproducible audited playability | C4 or C5 replays twice from clean processes with byte-identical normalized logs, events, checkpoints, and fixed-tick frame digests; a qualified reviewer can inspect the joined evidence.                                                                                                                                                      | Signed result manifest, hashes and sizes, private scrub sequence, public redacted sequence, audit acknowledgement, and replay refusal on identity mismatch.           | It does not certify all routes or physical speakers. Any replay mismatch, stale/missing/unmanaged artifact, missing review record, or unpinned environment fails.                                                             |
| C7 — completion certified             | A signed completion manifest enumerates every supported start mode and terminal completion class for this content. From every listed start, a player-input replay reaches each listed terminal class through C6, and the manifest accounts for every structurally reachable terminal class as covered, excluded with evidence, or unsupported. | Completion inventory, discovery coverage report, per-terminal replay package, terminal frame/semantic checkpoint, and human audit of the private sequences.           | It does not prove an omitted mode or unmodelled terminal is complete. Missing inventory coverage, an unexplained discovered terminal, terminal reached without player-causal input, or any failed constituent C6 run fails.   |

`C4` is the existing bounded playability level. `C7` is the only rung allowed
to say a human can play this declared content to completion. Neither permits an
E4/reference-fidelity label without a separate approved comparison.

## 2. Verification

### Evidence package and chosen visual proof

Choose deterministic screenshot sequences, not video, as the proof artifact.
Capture lossless frames at every assertion checkpoint and fixed logical tick;
index them with the input, gate, event, state digest, frame digest, and audio
marker. The gate compares exact RGBA only in the pinned renderer environment.
The audit surface is a scrub sequence of those joined records.

Video is useful for failure triage and a newly approved baseline, but is not a
gate. A Playwright recording is tied to browser-context lifecycle and adds
browser scheduling, codec, viewport, and encoder variability; it also observes
the review client rather than an engine-owned framebuffer. A direct engine
video would still be lossy and expensive to store. Deterministic frames cost
more files and need a pinned renderer, but localize a diff to a logical event,
are lossless, and make exact replay possible. Video's dominant flake is
codec/browser timing; frames' is renderer/font/environment drift, controlled
by pinning and rejected on mismatch. This follows the existing recommendation
and its cited evidence in `docs/proposals/playability-e2e.md` (“Visual proof
and artifact contract”).

Machine evidence remains authoritative for behavior: video and frames cannot
replace input causality or canonical state. Perceptual hashes only deduplicate
the audit index. On failure or explicit audit approval, derive a private short
video from the fixed frames; never parse it for pass/fail.

### Scenario families

Both families are engine-neutral Gherkin feature suites. Every `expected`
value resolves from a signed private expectation bundle; an absent value fails
the step definition.

| Family           | Required scenarios                                                                                                                                                                                                                                                                                                                 | Pass observation                                                                                                                               | Counterfactual that must fail                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch-validation | paired original/patched replay; same gate and structural checkpoints; selected changed surface is target, differs from source, has valid encoding/glyph coverage/layout; redaction derivative is safe                                                                                                                              | Paired logs, checkpoints, private frames, target/source digests, public derivative and vision verdict                                          | Original text remains; arbitrary replacement renders; a route is replaced by a lookalike; target expectation is absent; public artifact leaks.                                                 |
| Game-correctness | advance blocks without input then consumes one input; each choice commits its own index and diverges; save/load survives a fresh process; backlog returns to present; speed changes completion ticks; auto advances only with virtual time; volume changes mixed PCM while transport continues; voice decodes, mixes, and advances | Gate/event chain, fresh-process state comparison, surface sequence, fixed-tick glyph counts, control-run logs, PCM windows, and frame evidence | Trace player advances without input; all choices select the first branch; memory snapshot substitutes for a save; settings are metadata only; harness injects advance; audio event has no PCM. |

The public synthetic contract test already demonstrates the choice mutation:
`crates/utsushi-core/tests/playability_contract.rs`,
`choice_replay_rejects_precomputed_first_option`, fails with “expected index
1, observed Some(0)” when selection is forced to the first option. Every real
adapter must run an equivalent mutation suite for its input, save, auto, audio,
and visual seams before it can issue a private result.

### Copyright boundary and reviewer workflow

Write full-fidelity frames, PCM, target expectations, state permitted by
policy, and derived failure video only to the private managed artifact path.
It is access-controlled and never committed or placed in database JSON. Create
public artifacts only by redacting private sources; they contain opaque handles,
hashes, counts, geometry, logical ticks, and redacted thumbnails—not dialogue,
art, audio, source paths, or content names. A failed redaction blocks public
upload while retaining private failure evidence.

A reviewer skims: (1) the scenario matrix for red/invalid/unsupported rows;
(2) the joined scrub sequence at each named checkpoint and input; (3) only the
private frame/PCM/diff linked by a suspicious row; and (4) the paired structural
view for a patch. The dashboard computes counts from trace and artifact rows,
verifies every listed hash and byte size before linking it, and makes an absent
artifact `evidence_invalid`. The existing storage boundary is measured in
`docs/utsushi-runtime-artifacts.md`; the mandatory private/public visual
verdict policy is measured in `docs/utsushi-fidelity-policy.md`.

## 3. Auditing and CI

### Measured baseline

`.github/workflows/real-bytes-oracle.yml` defines `ground-truth` and
`browser-e2e` with `[self-hosted, itotori-corpora]`, nightly scheduling, and
fail-loud commands. The direct history query on this tree's repository,
`gh api repos/cat-cave/itotori/actions/workflows/real-bytes-oracle.yml/runs?per_page=100`,
returned 19 runs on 2026-07-28: 18 cancelled and one queued. Querying each
run's jobs showed 18 cancelled `ground-truth` and 18 cancelled `browser-e2e`,
all with empty `runner_name`; the current two jobs are queued. The runner API
query returned `[]`. Thus neither strict job has been assigned a runner in the
measured history; no real-playability pass exists. This is measured current
state, not an inference from a green synthetic lane.

| Lane and cadence             | Runner and inputs                                                                                                       | Runs                                                                                                          | Result and failure rule                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-change public            | Hosted runner; synthetic inputs only; every change and merge queue                                                      | Contract/schema/mutation suites, redaction-shape tests, and a small deterministic adapter conformance fixture | Proves shared machinery detects its named failures, never that private content plays. Missing fixture, zero scenario count, or mutation that stays green fails.                                                                   |
| Opt-in private probe         | Explicitly configured private machine; manual or labelled request                                                       | C0–C5 investigation against one staged installation                                                           | Produces private evidence only; it cannot set fleet status. Required corpus/profile/preflight absence fails rather than green-skips. This is the existing private-proof lane in `.github/workflows/real-bytes-private-proof.yml`. |
| Strict nightly and on demand | Trusted self-hosted runner labelled `self-hosted` and `itotori-corpora`; read-only staged corpora; private expectations | C0–C6 for selected manifests, synthetic-vs-real drift, and audit publication                                  | Sole authority for a real C4–C6 status. Missing required corpus, content mismatch, renderer, toolchain, artifact store, or private expectation is red/`not_established`, never pass or skip.                                      |
| Strict completion audit      | Same trusted runner; triggered on approved completion-manifest change and on demand                                     | C7 inventory, all terminal packages, and reviewer acknowledgement                                             | Does not inherit prior route status. An unaccounted terminal, missing audit record, or a constituent failure fails completion.                                                                                                    |
| Review-client browser        | Pinned browser runner; redacted fixtures/artifact API; per-change plus strict cadence                                   | The dashboard's filtering, timeline, access boundary, and redacted display                                    | Proves review UI only, never engine execution. Missing pinned browser or visual baseline fails.                                                                                                                                   |

The strict runner must provide: a registered online runner with those labels;
read-only private corpus mounts and private expectation access; isolated
per-run save/artifact storage; the exact approved profile; Nix and the
lock-pinned browser/font environment; the port toolchain; private artifact
upload credentials; no public artifact credential capable of reading private
payloads; and a clean-process launcher. Preflight emits a versioned capability
report and fails before scenarios if any item is absent. `docs/dev/ci-lanes.md`
measures the existing separation of per-gate, strict, private-proof, and
browser lanes, including the pinned-browser requirement.

### Waves

1. Establish the shared replay/result schema, synthetic mutation corpus, C0–C3
   evidence writer, public redaction tests, and status vocabulary. A deliberately
   gutted causal dispatcher must red-test in this wave.
2. Add one engine adapter and one private manifest through C4; wire fresh
   process, real persistence, frames, and PCM. It remains `not_established`
   until the strict runner completes it.
3. Provision and preflight the strict runner; publish private evidence plus
   redacted derivatives; enable strict C4–C6 and the audit dashboard.
4. Add patch-validation and completion manifests; run C5 and C7 only after
   their private expectations and terminal inventories are approved.
5. Repeat the constant-shape engine onboarding described below; periodically
   re-run all registered manifests and inspect drift/failure artifacts.

## 4. Scaling beyond twenty engines

The governing acceptance test is engine number 21: it adds data and one
adapter, not a conditional to shared code. The shared runner must never switch
on engine identity; it calls only the adapter contract and validates generic
typed evidence. A new engine is rejected in review if a shared-module diff
contains engine-name branching.

| Shared machinery                                                                                                                                                                                      | Per-engine adapter                                                                                                                                                                                                                                       | Per-installation data                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay executor; schema; canonical-state validator; scenario interpreter; artifact writer/redactor; exact-frame and PCM assertions; mutation framework; dashboard matrix/timeline; status aggregation | `PlayabilityDriver` implementation: boot, gate, input lowering, semantic events, state projection, virtual clock, persistent save, frame capture, PCM capture, discovery enumerator, and stable unsupported reasons; one synthetic conformance miniature | Opaque content handle/digests; feature declaration; discovery budgets; approved anchor/log; private expected outputs; applicability evidence; completion inventory where claimed |

The registry seams are explicit. `RuntimeAdapterRegistry` remains the dispatch
registry and continues to register `EnginePortAdapter<EnginePort>` as measured
in `crates/utsushi-core/src/lib/runtime_capture/execution_adapter.rs` and
`crates/utsushi-core/src/port/runtime_adapter.rs`. Add a parallel
`PlayabilityAdapterRegistry`, keyed only by the adapter descriptor ID, whose
entries are engine-owned factories for the existing `PlayabilityDriver`
contract (`crates/utsushi-core/src/playability.rs`). The factory creates an
opaque session; shared code sees no engine state. The manifest selects an
entry by data, validates its declared contract/version, and otherwise fails
`adapter_not_registered`. The two registries share descriptor identity and
artifact policy, not per-engine control flow.

Engine 21 therefore supplies exactly one adapter package, one synthetic
mutation fixture, and at least two independent installation manifests with
their private expectations. It changes no shared scenario and no dashboard
branch. Its cost is a small constant in repository surfaces, while honest
content discovery/review remains variable and is recorded rather than hidden.

## 5. Anti-false-green rules

1. **Presence is asserted.** Every required manifest field, scenario, selected
   checkpoint, artifact, private expectation, corpus preflight, and coverage
   count has a non-zero assertion. Absent input has no default pass path.
2. **The named action is asserted after it happens.** Gates prove the port
   accepted an input; consumption and semantic event prove it acted; state plus
   frame/PCM prove the claimed result. No gate asserts only the preparatory
   step named before it.
3. **Each semantic claim has a counterfactual.** Advance has a no-input blocked
   control; choice has a selected-index/different-state control; save has a
   process-replacement control; auto has an auto-off time control; volume and
   voice have PCM controls; patches have source/target and route-identity
   controls. The listed counterfactual must turn the scenario red.
4. **Unsupported is evidence, not omission.** Drivers emit a stable unsupported
   reason. Required unsupported features fail; optional ones need positive
   discovery evidence before `not_applicable`. Budget exhaustion is failed
   discovery, never an empty pass.
5. **Synthetic success remains labelled.** The current contract returns
   `NotEstablished`, as measured in `crates/utsushi-core/src/playability.rs`.
   No hosted or synthetic badge may promote an installation or engine.
6. **Audit validates bytes, not counters.** The consumer recomputes scenario
   counts from logs/artifacts, validates file hash and size, and joins every
   review frame to its causal checkpoint. Missing, stale, or producer-only
   evidence invalidates the result.
7. **Mutations stay live.** Public CI mutates shared causality; every adapter
   mutates its lowering/persistence/audio/render seams. If a required mutation
   remains green, it blocks publication of every result using that code/build.

## Unverified items

- The required strict runner's corpus mount layout, private expectation store,
  credential isolation, and clean-process launcher are unverified because the
  measured runner API returned no registered runners; they are provisioning
  requirements, not claims that they exist.
- A completion inventory for any private installation is unverified: no private
  corpus or completion manifest was available in this worktree, and no game
  name or private content was inspected.
- Storage retention duration and current private-artifact access-control
  configuration are unverified. The program requires the boundary above, but
  this proposal did not query the artifact provider.
