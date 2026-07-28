# Playability E2E: a proof that a game port can be played

## Decision

`playable` is a **bounded, reproducible claim about an engine port and a
particular installed content set**. It is not a synonym for “a process
launched”, “some trace events arrived”, “the frame changed”, or “a dashboard
opened.” A content set is playable at the proposed `P1` level only when a
deterministic replay, starting from a declared clean state, proves every
applicable player-facing operation below by observing both the input boundary
and the resulting engine state. The run must be repeatable in a fresh process,
with the same inputs producing the same checkpoints and review artifacts.

The initial level is deliberately narrower than whole-game certification: it
proves that a real, input-gated route of the installed work is usable and that
the port's common player controls work on that route. It does **not** prove
every route, every platform, translation quality, or pixel identity with a
commercial runtime. Claims beyond this level need additional scenario coverage
or reference-runtime comparison. This is consistent with the repository's
existing E0–E4 evidence policy: deterministic replay is E1, a captured frame
is E2, and reference fidelity is E4 only when an actual comparison exists.

The implementation should call the resulting suite `playability-e2e`, but it
must run the port directly. A browser is a review client, not the system under
test. No shipped job may launch or shell out to a retail executable; a
reference runtime may be used only in a separate, human-authorized validation
exercise to establish an approved private baseline.

## The definition, including its limits

For an engine `E`, installed content digest `C`, port revision `R`, and
scenario `S`, write `Run(E,C,R,S,I)` for executing a script `I` under a fixed
virtual environment. A scenario passes only if all of these are true:

1. **Real input gate.** The port reports that a player action is currently
   accepted, including the kind of action and (for a choice) the complete
   ordered option set. The runner injects the next scripted event only at that
   gate. It is an error to consume an event early, late, twice, or without a
   gate.
2. **Causal effect.** The port emits a semantic event caused by that input and
   reaches the asserted checkpoint. A checkpoint is a canonical, redacted
   state snapshot plus a state digest; it includes control position, call/return
   state, variables and flags permitted by the port, active text/choice
   surface, persistent-save identity, settings, audio transport, and logical
   clock. The frame counter, a layer count, and a screenshot hash are not a
   checkpoint on their own.
3. **Observable player result.** The scenario's relevant user-visible surface
   is observed: rendered text/glyph progression, choice UI, backlog UI, mixed
   audio samples, or a framebuffer checkpoint. A state-only assertion cannot
   prove a display or audio operation.
4. **Reproducibility.** A second clean-process replay of the immutable log has
   byte-identical canonical event and checkpoint records (excluding declared
   artifact paths and elapsed wall time). It must reproduce every asserted
   semantic checkpoint and every exact framebuffer digest at fixed logical
   capture ticks. A mismatch is a failure, not a retry.
5. **Pinned inputs.** The replay records the content digest, patch digest,
   port build digest, adapter version, engine configuration digest, font and
   renderer identity, virtual-clock policy, locale, and RNG seed. Any mismatch
   refuses replay rather than silently using “close enough” content.

`P1 playable` means that the title manifest has selected and passed all
applicable core scenarios in the engine matrix below, with at least one
two-option route whose alternatives produce distinct immediate semantic
checkpoints. A title whose discovered route has no applicable voice or audio
asset is marked `not_applicable` for that one scenario with an evidence record
showing the discovery result; it may not call an empty scan a pass. Save/load,
advance, choice, and text presentation are core and cannot be made
`not_applicable` for a title that claims P1.

This is a **port correctness** definition. It catches a port that ignores a
choice, loses saves, paints nothing useful, or changes a setting without
changing behavior. It cannot establish that an intentionally different but
self-consistent port exactly matches the original product. That is a separate
E4 comparison, and the dashboard must never label P1 as reference fidelity.

## Engine matrix and scenario discovery

The first three drivers are RealLive, Siglus, and Softpal. They use one common
`PlayabilityDriver` contract; only their lowering of engine state and input is
engine-specific.

| Driver | Required P1 route proof | Engine-specific observation required | What is not accepted as proof |
| --- | --- | --- | --- |
| RealLive | Text advance, a presented choice and both commits, persisted save/load, history, settings, and every discovered applicable timed/audio control | Interpreter control state; text-window/backlog state; save serialization; mixer/voice transport; deterministic software framebuffer | A script offset alone, a text trace without the text window, or an in-memory save clone |
| Siglus | Text/advance or pointer input, menu/choice selection, restart-safe persisted save/load where the content exposes it, and applicable controls | Scene VM state, ordered input dispatch, menu hit/commit state, fixed-frame rendering, settings and audio state | A mouse-coordinate click that has no confirmed target, a non-black framebuffer, or a title/menu transition alone |
| Softpal | Advance and selection, state transition through the VM, persisted save/load, and applicable text, history, timing, and audio controls | VM program/control state, input wait kind, point/route transition, text surface, sound transport, fixed logical time | Enumerating early empty points, reaching a numeric point, or counting draw commands |

### Discovery is evidence, not a shortcut

Each title has a content-addressed manifest with no title text. It names an
engine, an opaque corpus handle, the expected feature set, target locale,
private expected-output bundle, and two generic search budgets:

```yaml
engine: softpal
corpusHandle: engine-ordinal-variant
requiredFeatures: [advance, choice, save_load, text, backlog, text_speed]
optionalFeatures: [auto, audio_volume, voice]
search:
  maxLogicalTicks: 200000
  maxCandidateGates: 256
  requireChoiceOptionsAtLeast: 2
```

The driver starts from the engine-declared entry point and uses a fixed
exploration policy solely to find a qualifying route. It records every
candidate gate, its kind, the number of options, whether non-empty text was
rendered, and why a candidate was rejected. A candidate is qualifying only
after an actual text surface is rendered and an input gate is consumed. For an
audio scenario it additionally requires a decodable cue; for save/load it
requires a legal save gate. Exhausting either budget produces
`playability.anchor_not_found`, not a green empty result.

The final P1 script is then **pinned** to a content-derived semantic anchor:
the canonical pre-gate state digest, gate kind, ordered option count, and a
salted digest of the visible text/option stream. It is not pinned to a source
filename, an address, a scene label, an opaque route number, or a title. On a
future content change the anchor must be re-discovered and approved; a fuzzy
“nearest” match is prohibited.

The following table makes the false-green question explicit. These are
mandatory assertions, not optional diagnostics.

| Player operation | Pass condition | It could falsely pass if… | Required guard |
| --- | --- | --- | --- |
| Launch and reach a route | A real input gate occurs after non-empty text is rendered | The driver reports a synthetic gate or stops at empty content | Gate is emitted by the port while executing content; the event trace links it to a framebuffer/text-surface capture and the discovery record lists rejected empty candidates |
| Advance | An `advance` event consumed at a text gate causes the next text/control checkpoint | A precomputed trace advances regardless of input | Run the same prefix once without the event and require it to remain blocked, then with the event and require exactly one consumption plus a new checkpoint |
| Choice | Each selected index is presented, committed, and reaches its own asserted checkpoint | All indexes are mapped to the first branch | Record the option list before injection; replay each selected index from the same snapshot; require the committed index to equal the event and at least one pair to differ in canonical state immediately after commit |
| Save/load | A save written through the player operation survives process replacement; load restores it | A memory snapshot or stale save is substituted | Terminate the port, create a fresh instance, load the named slot, compare the full allowed state snapshot, then replay the next event and compare the result |
| Volume | Changing volume changes the mixed output of a known cue while transport continues | Only the settings value changes | Assert mixer gain and a deterministic sample-window measurement: high volume has non-silent samples, mute is silent within the defined numeric tolerance, and cue position advances in both runs |
| Auto mode | With auto enabled, virtual time alone causes the documented next advance | The harness injects an advance or the VM fast-forwards unconditionally | The post-toggle log contains no advance/text event; the trace names auto as cause; disabling auto under the identical time advance remains blocked |
| Voice | A discovered voice cue decodes, enters the voice channel, and advances sample position | An event is emitted but no audio plays | Require decoder-ready, active channel, non-silent mixed sample window, and advancing transport; do not accept metadata-only audio events |
| Backlog | Earlier rendered text is shown by the backlog UI and returning restores the current page | History exists only in an internal list | Snapshot historical text-surface digests, navigate through actual backlog input, observe the displayed order and cursor, then return and compare current surface |
| Text speed | Two configured speeds give different deterministic reveal completion ticks and correct final text | The setting is stored but ignored | Measure rendered glyph/cluster count at fixed virtual ticks; require monotonic reveal, expected ordering of completion ticks, and equal final text-surface digest |
| Localized patch | Patched execution reaches the same structural checkpoints while each selected displayed unit equals the private expected target digest and has no encoding/layout violation | The original text or arbitrary replacement is still rendered | Pair unpatched and patched runs from the same log; compare control-flow/choice/save state, verify displayed target digest against the patch expectation, verify it differs from the source digest where changed, and inspect its rendered bounds/glyph coverage |

For every driver, an unsupported required operation is a `failed` scenario
with a stable reason. A capability declaration, a count of layers, a different
image hash, and a successful process exit are never upgrade paths to `passed`.

## Draft executable specifications

The feature files below are intentionally engine-neutral. The test runner
binds `a playable installation` to one manifest and one port driver. Values
such as text and option content stay in the private expectation bundle; the
public report uses salted digests and counts.

### `features/game-works-correctly/core-playability.feature`

```gherkin
Feature: A player can use the core controls on a deterministic game route
  Background:
    Given a clean content-addressed installation and a pinned port build
    And virtual time, locale, fonts, renderer, settings, and random seed are pinned
    And a qualifying route has rendered non-empty text and is waiting for player input
    And I record every accepted player input at its logical tick

  Scenario: Advancing text requires and consumes player input
    Given the route is blocked at a text advance gate
    When I advance once
    Then the port records one consumed advance event at that gate
    And it reaches the expected next semantic checkpoint
    And the same prefix without that input remains blocked at the gate
    And a clean-process replay reaches the same checkpoint

  Scenario: Each selected choice commits the option the player selected
    Given a visible choice has at least two ordered options
    When I choose option 0 from a restored pre-choice snapshot
    And I choose option 1 from the same restored pre-choice snapshot
    Then each run records the presented option order and its selected index
    And each run records a commit whose selected index equals its input
    And the immediate semantic checkpoints of the two commits are different
    And clean-process replay reproduces both checkpoints

  Scenario: Saving and loading restores a persisted player state
    Given I am at a legal save gate with a captured semantic checkpoint
    When I save to a vacant slot
    And I advance to a different checkpoint
    And I terminate the port and start a fresh port instance
    And I load that slot through the player input boundary
    Then the restored semantic checkpoint equals the saved checkpoint
    And replaying the next input reaches the same post-save checkpoint as before

  Scenario: Volume setting changes audible output without stopping playback
    Given a discovered audio cue is playing through the mixer
    When I set the applicable volume to a high value and capture a fixed sample window
    And I set the same volume to mute and capture the same virtual-time window
    Then both runs show advancing cue transport
    And the high-volume window is non-silent
    And the muted window is silent within the declared numeric tolerance

  Scenario: Auto mode advances only because virtual time elapsed
    Given the route is blocked at an auto-eligible text gate
    When I enable auto mode and advance virtual time by the configured dwell interval
    Then the next text checkpoint is reached with no injected advance input
    And the trace attributes that transition to auto mode
    When I disable auto mode and advance the identical virtual time
    Then the route remains blocked at its text gate

  Scenario: A voice cue actually reaches the mixed output
    Given a discovered voice cue is eligible to play
    When I trigger that cue through the route
    Then the decoder is ready and the voice channel is active
    And a fixed mixed sample window is non-silent
    And voice transport advances over virtual time

  Scenario: Backlog shows previous displayed text and returns to the present
    Given I have displayed at least three distinct text pages
    And I have captured each page's private text-surface digest in display order
    When I open backlog and navigate to the oldest captured page
    Then the displayed backlog surface equals that page's digest
    And the backlog cursor and display order are correct
    When I return to the present page
    Then the current displayed surface equals the pre-backlog current surface

  Scenario: Text speed changes glyph reveal timing without changing final text
    Given the same unrevealed text page is restored twice from one snapshot
    When I set the first run to slow text speed and tick virtual time
    And I set the second run to fast text speed and tick virtual time
    Then each run reports monotonically increasing rendered glyph or cluster counts
    And the fast run completes before the slow run
    And both completed text surfaces have the same private digest
```

### `features/patch-validation/localized-playability.feature`

```gherkin
Feature: A patched installation preserves playable behavior and displays its target text
  Background:
    Given paired original and patched installations with pinned content and patch digests
    And one approved deterministic input log and private expected target-output bundle

  Scenario: A localized route retains behavior and renders the expected target units
    When I replay the log against each installation in a fresh process
    Then their structural checkpoints, choice arity, commit indexes, and save/load results match
    And every selected patched text surface matches its expected private target digest
    And every changed patched text surface differs from its source digest
    And every selected patched text surface has valid encoding, supported glyph coverage, and in-bounds layout
    And private reference frames and public redacted derivatives are emitted for review

  Scenario: A patch cannot replace a route with a lookalike
    Given a checkpoint immediately before a recorded player input
    When I replay the next input against the patched installation
    Then the exact expected gate kind consumes it once
    And the expected structural post-input checkpoint is reached
    And the patched visible target unit is linked to that checkpoint
```

The Gherkin is not itself a test oracle. Step definitions must resolve every
`expected` value from the run's signed private expectation bundle, and must
fail if a field is absent. A step that merely checks an event exists is a
broken step definition.

## Determinism and input replay contract

The repository already has a useful substrate: `ReplayLog` carries a schema,
adapter version, logical clock origin, seed, strictly monotonic input ticks,
and asset references. `InputEvent` already models advance, indexed choice,
auto, save, load, logical menu selection, and pointer input. The playability
layer should extend its metadata and validate its use; it should not create an
incompatible log format.

### Driver interface

Each engine implements this conceptual interface. `observe()` and
`canonical_state()` must execute the same port instance and state as
`apply_input()`; a second, precomputed observer is forbidden.

```text
boot(environment, content, patch) -> Session
restore_persistent_save(session, slot) -> Session
tick(session, logical_delta) -> Observation
await_gate(session, budget) -> Gate
apply_input(session, InputEvent) -> Observation
canonical_state(session, redaction_key) -> CanonicalState
capture_rgba(session) -> RgbaFrame
capture_audio(session, duration) -> PcmWindow
shutdown(session) -> PersistedSaveSet
```

`Observation` has typed events for `gate_presented`, `input_consumed`,
`choice_committed`, `text_surface`, `save_written`, `save_loaded`,
`settings_changed`, `auto_advanced`, `voice_started`, `audio_transport`, and
`unsupported`. The driver must emit an `unsupported` event for a real missing
feature; it may not silently omit the event. Canonical state is a sorted,
typed, redaction-safe tree. Its digest is SHA-256 over canonical JSON; it
excludes wall clock, host paths, thread identifiers, artifact URIs, and raw
copyrighted text/art. It includes a schema version so a state-schema change
cannot silently reuse old expectations.

The event relation is important:

```text
gate_presented -> scripted input -> input_consumed -> semantic event -> checkpoint
```

The runner rejects an input without a matching preceding gate, an unconsumed
input, an extra consumed input, an event at a non-monotonic tick, or a
checkpoint that does not name the immediately preceding causal event. This
prevents a driver from substituting a list of anticipated branches for actual
input dispatch.

### Replay record

The v1 playability wrapper around a `ReplayLog` has these required fields.
The public manifest has only opaque handles, hashes, counts, and redaction
status; the private bundle contains frames, target text expectations, and
unredacted state where policy permits.

```json
{
  "schemaVersion": "playability-e2e/v1",
  "run": {
    "engine": "softpal",
    "corpusHandle": "engine-ordinal-variant",
    "contentSha256": "…",
    "patchSha256": "…",
    "portBuildSha256": "…",
    "adapterVersion": "…",
    "environmentSha256": "…",
    "locale": "…",
    "seed": 0,
    "clock": { "tickUnit": "ms", "origin": "run_start" }
  },
  "replayLogRef": "artifacts/utsushi/runtime/<run>/traces/input-log.json",
  "checkpoints": [
    {
      "label": "before_choice",
      "logicalTick": 0,
      "stateSha256": "…",
      "eventSequenceSha256": "…",
      "frameSha256": "…"
    }
  ],
  "redaction": { "privateArtifacts": true, "publicDerivatives": true }
}
```

The illustrative ellipses above mean fixed-width hashes, not optional values.
The actual schema must reject missing or unknown fields. `<run>` is generated
by the artifact store and never contains a corpus name.

### Make nondeterminism a loud failure

The runner uses a virtual monotonic clock supplied to the port. It pins
timezone, locale, language, font set, renderer backend, framebuffer size,
audio sample rate, resampler, engine configuration, and a deterministic RNG
seed. No wall-clock deadline may affect game state; a real timeout only aborts
the test with `playability.host_timeout` and cannot produce a pass.

There are three determinism checks:

1. **Capture twice.** Starting with a clean save directory, run the scripted
   path twice and require identical normalized input log, event trace, and
   checkpoint sequence.
2. **Replay in a fresh process.** Save the first log, dispose the session,
   start a new process, and require equal checkpoints and fixed-tick frame
   digests. This catches hidden in-memory state and false save/load behavior.
3. **Restore cut.** At every scenario checkpoint, restore the canonical
   snapshot in a separate in-memory run and replay the suffix. Its subsequent
   canonical checkpoints must match. This is a diagnostic plus a port contract
   check; it does not replace persisted save/load.

If an engine genuinely has a nondeterministic algorithm, the driver must
virtualize or serialize its source of randomness. If it cannot, that operation
is not deterministic and cannot satisfy P1. Recording host timestamps,
accepting a tolerance in state hashes, or retrying until green only hides the
defect.

### Tests that prevent a hollow harness

The first implementation must include a mutation-oriented integration test
named `choice_replay_rejects_precomputed_first_option`. Its fixture offers two
options whose immediate canonical states differ. The test records option one,
replays it, and asserts the consumed and committed index is one plus the
expected distinct checkpoint. Replacing the driver with a trace player or
mapping every choice to zero must make this test fail. The implementation
review should deliberately make that mutation, record the failing assertion,
restore the code, and rerun it.

Companion tests are `persisted_load_requires_fresh_process`,
`auto_transition_requires_no_injected_advance`, and
`volume_requires_sample_output_change`. Together they target the three most
tempting hollow substitutes: an in-memory snapshot, an automatic test driver,
and settings metadata without effect.

## Research findings and their consequences

The local oracle checkout was inspected at these pinned revisions. It is
evidence for useful techniques, not a license to copy their weak spots.

1. [RLVM's machine test](https://github.com/eglaysher/rlvm/blob/e38cda7783dc67539ce27901596ed93a2bb5c826/test/rlmachine_test.cc#L196-L277)
   serializes state, constructs a new machine, loads it, and verifies persisted
   values. Its [text-system test](https://github.com/eglaysher/rlvm/blob/e38cda7783dc67539ce27901596ed93a2bb5c826/test/text_system_test.cc#L119-L183)
   checks backlog navigation and replayed UI effects. Consequence: P1 requires
   fresh-process persisted load and actual backlog presentation, not merely a
   state hash.
2. [Siglus's VM flow test](https://github.com/xmoezzz/siglus_rs/blob/814ef739a7d09fb3ca46e69b32ce06d127a1b10c/crates/siglus_scene_vm/tests/testcase_menu_flow.rs#L285-L335)
   advances a VM frame by frame, injects pointer input, compares framebuffer
   changes, and asserts that a click changes the scene flow. It also exposes a
   limitation: its test setup and captures are local-path specific, and a
   pixel delta can establish only that *something* changed. Consequence: use
   fixed-tick framebuffer capture as corroborating visual evidence, but pair
   it with input-consumption and semantic checkpoint assertions; never treat a
   non-black frame or pixel delta as success.
3. [Sena's fixtures](https://github.com/xmoezzz/sena-rs/blob/75b3acc9b84f400a4c482801efd4b9fca95d1342/crates/pal-vm/tests/input_fixture.rs)
   model key/button edge states explicitly, while its
   [animation test](https://github.com/xmoezzz/sena-rs/blob/75b3acc9b84f400a4c482801efd4b9fca95d1342/crates/pal-vm/tests/animation_fixture.rs#L35-L91)
   drives a supplied logical time and asserts state at exact times. Its
   [debug dump](https://github.com/xmoezzz/sena-rs/blob/75b3acc9b84f400a4c482801efd4b9fca95d1342/crates/pal-vm/tests/debug_dump_fixture.rs#L38-L57)
   exposes frame, event, task, and render details. Consequence: input must be
   edge- and tick-precise, virtual time must be an input to the VM, and frame
   diagnostics belong beside—not in place of—semantic assertions.

The emulator community supplies the broader replay model. FCEUX describes a
movie as the inputs needed to reconstruct actions rather than a stored video,
and says deterministic replay produces the same playback; the movie format
pins an input log and start conditions ([movie recording](https://fceux.com/web/help/MovieRecording.html),
[format](https://fceux.com/web/FM2.html)). RetroArch's netplay documentation
states the same preconditions more formally: identical content and core plus a
deterministic core permit rewind/replay to a canonical state
([determinism constraints](https://docs.libretro.com/development/retroarch/netplay/)).
That is why this design makes content, port, environment, state, and input
part of one replay identity; an input list alone is insufficient.

## Visual proof and artifact contract

### Recommendation

Use a three-part private artifact for every strict run:

1. **Authoritative machine evidence:** immutable replay log, canonical event
   trace, checkpoint state digests, input/gate causality links, and a
   normalized result manifest. This gates the run.
2. **Selected lossless checkpoint frames:** capture PNG frames at every
   assertion checkpoint and at pre/post settings changes. Compare exact RGBA
   digests in the pinned renderer environment; generate a pixel diff only on
   mismatch. These make a rendering regression reviewable.
3. **A scrub timeline:** an indexed sequence with one thumbnail at each
   semantic event and capture tick, linked to the trace/checkpoint. It is the
   primary human-review format. A derived video is optional convenience output,
   not a test oracle.

For failing runs only, also encode a short private WebM/MP4 from the fixed-tick
frames, with overlay data generated from the redacted trace (logical tick,
input kind, checkpoint label). It helps a reviewer skim temporal behavior but
is never parsed to decide pass/fail. Passing-run video is off by default;
enable it only for a selected audit or a newly approved baseline. This controls
storage and avoids mistaking a lossy encoder artifact for a rendering change.

Playwright can record browser-context video and offers retention modes such as
`retain-on-failure`, but its documentation makes clear that the recording is
tied to browser context lifecycle and defaults to being off
([video behavior](https://playwright.dev/docs/videos)). That is appropriate for
the dashboard UI's own end-to-end tests. It is not the right producer for an
engine-port proof when the engine already owns the logical clock, input, audio,
and framebuffer. Starting a browser adds scheduling, browser codec, viewport,
and DOM dependencies without observing any additional game behavior.

Golden screenshots are valuable for diff review, but only in a hermetic
renderer. Playwright itself warns that OS, browser version, settings, hardware,
and headless mode can alter screenshots
([visual comparison warning](https://playwright.dev/docs/test-snapshots)). The
existing flake-pinned Chromium/font/software-raster recipe is therefore a good
model if a browser canvas is tested. For direct engine frames, use a pinned
software rasterizer and exact frame digests. Perceptual hashes are useful only
to cluster near-duplicate timeline frames and pick thumbnails; they must never
be a gate because two materially different frames can be perceptually close,
and a small but fatal glyph corruption can be perceptually tiny.

| Format | Automated use | Human use | Main failure mode | Policy |
| --- | --- | --- | --- | --- |
| Canonical trace and state digests | Primary behavioral gate | Diagnose causality | A port reports false state | Link every assertion to an input gate and visible/audio observation; use replay and mutation tests |
| Exact checkpoint PNG and diff | Renderer regression gate in pinned environment | Inspect layout and compositing | Host/rendering flake; visually correct but semantically wrong frame | Pin renderer; never use it as the only behavioral proof |
| Perceptual-hash sequence | Index/deduplicate only | Find changes quickly | Collisions and missed small defects | Non-gating metadata only |
| Scrub timeline | None by itself | Fast review of inputs, states, frames | Reviewer overlooks a point | Require named checkpoint list and completion acknowledgement |
| Video | None by itself | Temporal skim and failure triage | Codec loss, large files, browser/encoder variance | Private, failure/approval only; derived from fixed frames |

### Storage, privacy, and retention

Continue using the managed runtime artifact root:

```text
artifacts/utsushi/runtime/<run>/
  traces/input-log.json
  traces/event-trace.json
  conformance-reports/playability-result.json
  conformance-reports/public-manifest.json
  screenshots/private/<checkpoint>.png
  frame-captures/private/<checkpoint>.png
  recordings/private/<failure-or-approved-review>.webm
  screenshots/public/<checkpoint>-redacted.png
  recordings/public/<checkpoint>-redacted.webm
```

The `private` payloads are access-controlled, encrypted at rest by the
artifact provider, and retained for 30 days on a passing strict run and 90 days
on a failure or explicitly approved baseline. They are never committed, placed
in database JSON, or exposed through a public artifact route. The public
manifest is content-free: opaque corpus handle, engine, status, schema and
build hashes, counts, timing, and references to redacted derivatives. It must
not carry raw dialogue, source paths, frame pixels, audio samples, or a title.

Public images and video are generated from the private source only by the
existing redaction pipeline. Redaction must remove both art and readable text,
then a visual gate verifies the derivative's declared mode. A redaction failure
blocks public upload but preserves the private failure evidence. A reviewer
with private access sees full fidelity; a public reviewer sees the same event
timeline, state labels, geometry/bounds diagnostics, and redacted thumbnails.

Every selected checkpoint frame also follows the existing E2 visual-inspection
rule: the recorded vision verdict must mark the private frame coherent and the
selected target text legible, and must mark a public derivative correctly
redacted with no leak. This is a second independent review signal, not a
replacement for deterministic state or exact pixels. A missing or negative
verdict makes a visual scenario fail; it cannot be hidden behind a successful
hash comparison.

Every manifest contains content hashes and byte sizes for all artifact files.
The dashboard verifies them before rendering a link. A missing, stale, or
unmanaged artifact changes the result to `evidence_invalid`; it cannot coexist
with `passed`.

## Infrastructure and operating model

There are no self-hosted corpus runners today, and the existing real-bytes
oracle has never completed. Therefore **there is currently no strict P1 pass
for any real installation**. The dashboard must show `not_established — no
trusted corpus runner has completed this suite`, not an empty green badge.

The implementation is split deliberately:

| Lane | Inputs | Runs where | Result meaning |
| --- | --- | --- | --- |
| Public contract lane | Synthetic mini-programs and fake audio/frame drivers | Hosted per-gate CI | The replay harness, schemas, causality rules, redaction, and mutation tests work; it proves no real installation is playable |
| Developer private probe | Locally staged private installation | A developer's explicitly configured machine | Produces private evidence for investigation; not a merge gate and not a fleet status pass |
| Strict periodic oracle | Read-only staged real installation, approved private expectations | A trusted self-hosted corpus runner | The only lane allowed to set a real P1 status; missing corpus, renderer, or runner is red/`not_established`, never skip/pass |
| Dashboard browser lane | Redacted fixture packages and artifact-store API | Hosted pinned-browser CI | The dashboard can render/audit evidence; it does not execute a game |

The strict job should be added as a separate stage to the existing scheduled
real-bytes workflow once a runner is provisioned. It must use the same
read-only corpus roots and fail-loud preflight as the other real-byte work.
Until then the scheduled job will remain unavailable; its status is evidence
of absent infrastructure, not a test result. A manual local run may upload a
private package only after content-digest and environment preflight succeeds.
It must be labelled `developer_probe` and cannot overwrite an oracle result.

No artifact is sent from a real corpus to public CI. Public CI receives only
synthetic contract fixtures and redacted fixture packages authored without
retail art or dialogue. The strict runner is the only place that has both real
bytes and full frames.

### Dashboard requirements

The dashboard is the long-term audit surface. For each engine/content/patch
tuple it must show, without running the port:

- the status vocabulary `passed`, `failed`, `not_established`,
  `not_applicable`, and `evidence_invalid`, with no visual equivalence between
  the last three and pass;
- the pinned content, patch, port, environment, and replay-log hashes;
- a scenario matrix with each required operation, its applicability evidence,
  gate/input/commit count, last checkpoint, and failure reason;
- a timeline that scrubs logical ticks, inputs, gates, semantic events, state
  diffs, private or redacted frame thumbnails, and audio transport markers as
  one joined record;
- side-by-side original/patch structural checkpoint comparison, target/source
  digest status, glyph/layout diagnostics, and redaction status;
- a one-click path from a failing assertion to its replay log, state diff,
  pixel diff, and derived video when available; and
- a clear `replay this exact run` control that exports the immutable replay
  package but refuses a mismatched content or environment digest.

The dashboard must compute counts from actual artifact records and trace rows,
not producer-supplied scalar counters. It must also present the evidence tier
next to the claim: a trace-only run is not styled as a rendered or playable
run.

## Scale plan

The common contract makes a title a data addition and an engine a driver
addition, rather than a bespoke test tree.

**Adding title seven:** add one opaque title manifest, one private expectation
bundle, and at least one approved qualifying route per required feature group.
Run discovery, approve the generated replay/checkpoint baseline, and run the
strict oracle. No scenario code or title-specific conditional is allowed. The
planned cost is one day of content-owner review plus one strict-run window; it
is higher only when discovery truthfully finds a missing feature, in which case
the manifest records that gap instead of adding a workaround.

**Adding engine four:** implement one `PlayabilityDriver`, canonical-state
adapter, virtual-clock adapter, persistent-save adapter, and synthetic
mini-program conformance suite; then qualify two independent installations
before P1 is advertised. Budget three to five engineering weeks plus the
availability of a trusted runner. The shared Gherkin and dashboard require no
engine-specific branch. A driver that cannot expose a causal input gate,
canonical state, virtual time, and persistent save is not eligible for P1.

The initial fleet is at least two installations per each of the three drivers:
six manifests, each independently content-addressed and executed. A result is
never inherited from another installation merely because they share an engine.

## Phased implementation

1. **Build the deterministic core first.** Add the `PlayabilityDriver` trait,
   v1 result schema, canonical-state digest, strict replay wrapper, and the
   four hollow-harness tests named above. Implement only a synthetic miniature
   driver initially. This is the highest proof per unit of work because it
   makes false green structurally difficult before any corpus is involved.
2. **Wire the first real port end to end.** Use the driver that already has
   replay input and real-byte capture evidence. Implement gate observation,
   fresh-process save/load, state extraction, and selected frame capture.
   Produce a developer-private package but do not call it P1 until strict
   infrastructure exists.
3. **Add strict infrastructure and audit UI.** Provision the trusted runner,
   make missing prerequisites fail loudly, upload private evidence, publish
   redacted derivatives, and implement the dashboard matrix/timeline. The
   runner's first completed run establishes the first possible P1 claim.
4. **Implement the remaining two drivers and six installations.** Share the
   feature files, run synthetic conformance before every port, then qualify two
   real installations per driver through the periodic oracle.
5. **Add patch pairing and E4 work separately.** Turn on the patch-validation
   feature once private target bundles exist. Only after a separately approved
   reference-output method exists should a driver claim E4 for a stated feature
   subset.

## How this could still lie to us

No automated definition is invulnerable. These are the known residual ways it
could make a technically true but misleading statement, and the guard each
requires.

| Possible lie | Why it would be misleading | Guard and resulting status |
| --- | --- | --- |
| The driver fabricates a gate, event, or state tree | All internal checks agree, but no game logic ran | Cross-process replay against content, mutation tests, engine-port code review, and private frame/audio links; suspected fabrication is `evidence_invalid` |
| Both choice branches accidentally reconverge | A later checkpoint may be equal even though choice dispatch worked | Assert the immediate post-commit state plus committed index; require one observed divergent pair, and label convergent choices as such |
| An anchor follows only a trivial prologue | A real route exists but says little about common play | Require every P1 operation on a qualifying non-empty input-gated route, retain discovery coverage and budget report, and add more routes before making broader claims |
| A save works in one process but not for a player after restart | Internal snapshot testing concealed persistence | The scenario disposes the port and loads the on-disk slot in a new process; no in-memory substitute is accepted |
| Audio telemetry lies while a real device would be silent | Sample generation and device playback differ | P1 claims deterministic mixer output, not physical speakers; an eventual device-output claim needs a separate hardware-backed scenario and cannot inherit P1 |
| Frame equality masks an invisible or incorrect UI region | A byte-identical frame can be consistently wrong | Semantic text/choice state, glyph bounds, and human review of selected private frames complement frame digests; E4 remains unavailable without reference comparison |
| Private expected target digests approve bad translation | Exact replacement is not linguistic quality | Call the patch result “target text placed and rendered,” not “translation is good”; route quality through human localization review with the same private frames |
| The baseline was approved from a broken port | Future runs faithfully preserve the wrong behavior | Baseline approval records provenance and requires independent review; E4 baseline work compares a covered subset with a reference only outside the shipped pipeline |
| A real job never runs | Synthetic green is mistaken for real proof | Distinct `not_established` status, fail-loud strict preflight, dashboard runner-health panel, and no P1 badge without a completed trusted run |
| A reviewer sees only a redacted or lossy artifact | The evidence may hide the very defect being audited | Private full-fidelity artifact access for authorized reviewers; redaction and video are supplemental, while trace/state remain inspectable |
| The test implementation is gutted later | A canned result makes all scenarios green | The mutation tests are required in public CI, strict results include code/build hash, and the result schema refuses evidence produced by an unknown driver version |

The honest wording after phase one is therefore: “the harness contract is
proved on synthetic programs.” After strict execution it is: “this installed
content passed the listed P1 scenarios under this pinned port and environment.”
Neither wording is “all games work” or “the port is reference accurate.”

## Sources

- Repository evidence policy: [Utsushi Fidelity Policy](../utsushi-fidelity-policy.md),
  [Runtime Artifact Storage](../utsushi-runtime-artifacts.md), and
  [CI lane policy](../dev/ci-lanes.md).
- RLVM: [fresh-machine serialization](https://github.com/eglaysher/rlvm/blob/e38cda7783dc67539ce27901596ed93a2bb5c826/test/rlmachine_test.cc#L196-L277)
  and [backlog/replay UI behavior](https://github.com/eglaysher/rlvm/blob/e38cda7783dc67539ce27901596ed93a2bb5c826/test/text_system_test.cc#L119-L183).
- Siglus: [frame-stepped input and framebuffer flow](https://github.com/xmoezzz/siglus_rs/blob/814ef739a7d09fb3ca46e69b32ce06d127a1b10c/crates/siglus_scene_vm/tests/testcase_menu_flow.rs#L285-L335).
- Sena: [input edge-state fixtures](https://github.com/xmoezzz/sena-rs/blob/75b3acc9b84f400a4c482801efd4b9fca95d1342/crates/pal-vm/tests/input_fixture.rs),
  [logical-time animation assertions](https://github.com/xmoezzz/sena-rs/blob/75b3acc9b84f400a4c482801efd4b9fca95d1342/crates/pal-vm/tests/animation_fixture.rs#L35-L91),
  and [frame diagnostic contents](https://github.com/xmoezzz/sena-rs/blob/75b3acc9b84f400a4c482801efd4b9fca95d1342/crates/pal-vm/tests/debug_dump_fixture.rs#L38-L57).
- Emulator replay model: [FCEUX movie recording](https://fceux.com/web/help/MovieRecording.html),
  [FM2 input-log format](https://fceux.com/web/FM2.html), and
  [RetroArch deterministic netplay constraints](https://docs.libretro.com/development/retroarch/netplay/).
- Visual evidence trade-offs: [Playwright video recording](https://playwright.dev/docs/videos)
  and [Playwright visual-comparison environment warning](https://playwright.dev/docs/test-snapshots).
