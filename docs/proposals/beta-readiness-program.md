# Beta readiness program

## Decision

- **Baseline:** detached `origin/main` at `82014907256cd2e9944a2d2d31ba3c2d51cee7a1`.
- **Verdict:** none of RealLive, Siglus, or Softpal has a current composed two-title dashboard proof, despite substantial native components.
- **Required loop:** owned install → accepted localization → native patch → exact patched play → observe → refine → rebuild → replay/revalidate.
- **Decision:** make one durable product transaction and one receipt-derived proof authoritative; more isolated endpoints/capability declarations preserve components that are unreachable or compose to no useful output.

Every current-state claim cites source/test/workflow/command. **UNVERIFIED** means the required observation was not produced, never a softer pass.

## Milestone definition

The milestone is complete for an engine only when every row is observed on each of two distinct, content-addressed real installs within tester-attested acquisition scope:

| Gate                 | Falsifiable observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake               | A new non-developer signs in through Zitadel, receives exact permission grants, pairs a private local worker, chooses a read-only install, records acquisition class/ownership attestation, and gets exactly one engine or an actionable ambiguity/unsupported report.                                                                                                                                                                                                                                                                                                                                                                                          |
| Artifact coverage    | The worker emits a version 0.2 bridge and bridge-bound version 2 structure; every field reports `populated/total`; every extracted unit joins to context or is a release-blocking exception. Zeroes distinguish source absence, missing extraction, and implemented-empty output.                                                                                                                                                                                                                                                                                                                                                                               |
| Configuration/cost   | Target locale, model policy, glossary, style, correction head, cost cap, and output scope are branch application data. Preflight displays worst-case exposure and requires confirmation. No translator setting becomes a new environment variable.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Correct localization | A nonempty qualifying run survives process restart; accepted bytes equal the latest reviewed candidate; required gates/verdicts are nonempty; unresolved units cannot finalize.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Native build         | Native apply persists an immutable root patch. Re-extract/integrity receipts bind source hash, output revisions, files, and artifact hashes; Build-LQA renders that same patch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Trusted play         | The worker verifies source/patch digests and profile, builds a copy-on-write overlay, and launches that exact overlay. Rung six includes causal/applicable backlog-speed-auto-volume-voice controls, decoded and mixed nonsilent audio, private visual verdict, player-issued disk save, total process termination and player-boundary load, two clean-process byte-identical normalized replays, and reviewer acknowledgement (`docs/proposals/playability-program.md:29-38,77-87`). Full-work rung seven remains separate.                                                                                                                                    |
| Refinement           | A played observation binds patch, persistent save, runtime address, action, and unit; an accepted correction creates a reviewed child. Paired replay preserves the approved log, gate arity, choice commits, structural points and save/load result; target digest changes as intended, source digest differs, encoding/glyph/layout pass, and unrelated hashes remain stable. The cycle succeeds twice without operator repair.                                                                                                                                                                                                                                |
| Quality              | Root/child reports include baselines, held-out findings, sensitivity, human calibration, cost/latency, and backlog. This program chooses beta admission minima: zero deterministic blockers; 100% recall over at least 20 seeded-critical defects; at least 90% over 50 seeded-major defects; and two independent blind target-language reviewers on 100 stratified units/title (or all units if fewer), with at least 80% agreement within one scale point, no dimension regression, and at least 0.5/4 targeted improvement. Failure marks the report invalid and blocks claims; `docs/quality-claims.md:50-101` supplies fields/scope, not these thresholds. |
| Recovery             | Injected partial extraction, no/multiple engine match, provider failure, billing-unknown completion, worker loss, and process restart leave durable visible state plus working retry/resume/cancel or safe rollback. Success can never mean zero executed real work.                                                                                                                                                                                                                                                                                                                                                                                            |

## Evidence vocabulary and measured baseline

- **Real-two**: this audit observed the stage on two real inputs. It proves only
  the stated stage, not downstream composition.
- **Real-one**: real evidence exists for one title; it fails the engine-family
  rule.
- **Synthetic**: authored bytes, fake processes, stub children, or injected
  ports only.
- **Partial**: implementation exists, but is unwired, contract-incompatible,
  narrower than the claim, or lacks a current qualifying proof.
- **Absent**: the required production behavior was not found. For context rows,
  this says the binding was not implemented, not that source dialogue is absent.

| Stage               | RealLive                                                                 | Siglus                                                         | Softpal                                                        |
| ------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| Identify            | Partial; one-title harness, current execution UNVERIFIED                 | Partial; nominal two-title test false-greens                   | Real-two                                                       |
| Extract             | Partial; strict harness not executable here and product layout is narrow | Partial; strict harness failed before bytes here               | Real-two, but legacy output                                    |
| Structure export    | Partial; one-title test can return empty                                 | Partial; static version 1 and false-green test                 | Real-two, partial linear version 1                             |
| Context build       | Partial; one-title optional test                                         | Absent binding; source exists                                  | Absent binding; source exists                                  |
| Localization passes | Synthetic / partial shared path                                          | Synthetic / partial shared path                                | Synthetic / partial shared path                                |
| QA and review       | Absent production bindings; synthetic internals                          | Absent production bindings; synthetic internals                | Absent production bindings; synthetic internals                |
| Patchback           | Partial; native core exists, product two-title claim is false            | Partial; strict native harness unverified, product unreachable | Real-two native library; partial product                       |
| Runtime execution   | Partial direct engine work; selected-patch product path absent           | Partial direct engine work; selected-patch product path absent | Partial direct engine work; selected-patch product path absent |
| Render              | Partial direct engine work; no selected-patch Build-LQA                  | Partial direct engine work; no selected-patch Build-LQA        | Partial direct engine work; no selected-patch Build-LQA        |
| Interactive play    | Partial implementation; proof synthetic/skipped                          | Partial implementation; proof synthetic/skipped                | Partial implementation; proof synthetic/skipped                |
| Save and load       | Partial engine syscall/codec work; absent product control                | Absent product behavior                                        | Absent product behavior                                        |
| Refinement          | Partial durable types, unbound and semantically disconnected             | Partial durable types, unbound and semantically disconnected   | Partial durable types, unbound and semantically disconnected   |

### Engine evidence

**RealLive.** Its dedicated detector proof explicitly uses one title and argues
that a second is unnecessary; the alternate live test returns on unavailable
input (`crates/kaifuu-reallive/tests/detect_real_bytes.rs:9-22,60-167`;
`crates/kaifuu-engine-fixture/tests/reallive_detector_live_corpus.rs:70-111`).
The core extractor has a strict two-corpus harness, but the product CLI resolver
accepts a nested layout while the shared corpus accessor also supports a flat
layout (`crates/kaifuu-reallive/tests/multi_corpus_real_bytes/cases.rs:62-180`;
`crates/kaifuu-cli/src/reallive_commands/paths.rs:124-172`;
`crates/kaifuu-reallive/tests/support/real_corpus.rs:36-71,131-142`). Structure
proof is one-title and returns without an artifact when its bridge is absent
(`crates/utsushi-cli/tests/structure_primary_corpus.rs:75-89`). The app patch
test uses the narrow resolver, skips unless both roots resolve, and measured
one non-real pass plus two skips, while its committed capability artifact says
two-title passed (`apps/itotori/test/patchback-produce-build.test.ts:50-81,105-106,233-240`;
`fixtures/public/itotori-patchback-produce/expected/reallive-patchback-produce-capability-v0.1.json:2-23`).
Thus current two-title product extract/structure/patch claims are **UNVERIFIED**.

**Siglus.** The nominal two-title detector filters unavailable rows and returns
when fewer than two remain. The audit command
`cargo test -p kaifuu-engine-fixture siglus_detects_real_corpus_titles -- --ignored --nocapture`
exited zero with one passing test after both inputs skipped
(`crates/kaifuu-engine-fixture/src/lib_tests_siglus.rs:319-366`). Native
whole-pack version 0.2 extraction and strict two-title extract/patch assertions
exist, but both commands failed before byte assertions because the configured
private inputs were absent
(`crates/kaifuu-cli/src/siglus_commands.rs:30-94,138-155`;
`crates/kaifuu-siglus/tests/siglus_bridge_real_bytes.rs:61-200`;
`crates/kaifuu-siglus/tests/siglus_patchback_real_bytes.rs:54-121,202-221`).
Its structure exporter emits static version 1 messages without the unit/hash
binding required by localization; its two-title test returns when inputs are
absent, and the lane counts that returned test as executed
(`crates/utsushi-siglus/src/structure_export.rs:1-6,61-124`;
`crates/utsushi-siglus/tests/structure_export_real_bytes.rs:14-44`;
`scripts/real-bytes-lane.mjs:62-66,95-128`). Source dialogue exists; the
version 2 context binding was not implemented
(`apps/itotori/src/structure/localization-join.ts:419-440`).

**Softpal.** Native audit commands over two staged real inputs
observed both detectors match, then extracted 70,024 units: source hash,
context, and patch reference were populated for 70,024/70,024; speaker for
48,655/70,024 (69.49%); protected spans for 0/70,024. The producer hard-codes
empty protected spans, so this is extraction not implemented, not proof the
source lacks spans (`crates/kaifuu-engine-fixture/src/softpal/real/extract.rs:31-126`).
Structure observed text on 69,997/69,997 messages, speaker on
48,655/69,997 (69.51%), choice labels on 27/27, text surface on 0/69,997,
branch targets on 0/27, and `sourceBundleHash`, `bridgeId`, next scene, and
nonempty fanout on 0/2 outputs. The producer deliberately makes one linear
scene; those zero structural fields are not implemented, not established
source absence (`crates/utsushi-cli/src/structure/softpal.rs:124-177`).
Native two-title patch tests observed byte-identical no-op rebuilds and five
length-changing replacements per title with no dangling edits
(`crates/kaifuu-softpal/tests/patchback_real_corpus.rs:111-164,175-245`).
However extraction emits legacy version 0.1, which the production version 0.2
assertion intentionally rejects; the measured structure projected 30,165
messages to zero workflow scenes and facts
(`packages/localization-bridge-schema/README.md:7-17`;
`apps/itotori/src/composition/live/scene-projection.ts:65-70,112-114`).
Real native stages therefore do not compose into product context.

### Shared product evidence

| Blocker         | Measured current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding      | It decodes a bridge, submits only project/locale, and is catalog-candidate-gated; the installed handler requires run mode, structure, and bridge, so it refuses (`apps/itotori/src/ui/screens/OnboardingScreen.tsx:69-98,127-160,182-215`; `apps/itotori/src/api-handler-mutation-project.ts:49-72`).                                                                                                                                                                                                                                                |
| Composition     | Production installs twelve ports behind a missing-read proxy. Endpoint closures construct, but identity, run configuration, revision, route-map, and patch-play endpoints fail when they invoke absent ports (`apps/itotori/src/services/database-services.ts:340-367`; `apps/itotori/src/api-handler-contracts.ts:104-220,319-472`).                                                                                                                                                                                                                |
| Qualifying run  | Review always throws; adjudication readers always throw; otherwise default Build-LQA throws for missing patched-byte render/OCR (`apps/itotori/src/services/database-services.ts:252-332`; `apps/itotori/src/workflow/driver.ts:57-85,379-433`; `apps/itotori/src/composition/live/factory-finalizer.ts:108-145`).                                                                                                                                                                                                                                   |
| Corrected bytes | Editors produce changed content, but the shared port keeps only unit identifiers; rereview uses the original scene and discards verdicts; finalization uses the original draft and empty review IDs (`apps/itotori/src/roles/p2/editor.ts:34-48,90-117`; `apps/itotori/src/roles/p3/repair.ts:39-44,137-143`; `apps/itotori/src/composition/workflow-ports.ts:134-153`; `apps/itotori/src/workflow/correction.ts:126-139,177-259`; `apps/itotori/src/workflow/driver.ts:255-265`; `apps/itotori/src/composition/live/factory-finalizer.ts:184-209`). |
| Native artifact | Workflow “patchback” exports but does not native-apply; native apply and persistent build production are separate (`apps/itotori/src/composition/workflow-ports.ts:176-190`; `apps/itotori/src/patchback/index.ts:115-161`; `apps/itotori/src/patchback/produce-build.ts:102-190`).                                                                                                                                                                                                                                                                  |
| Restart         | Durable final heads are skipped, yet accepted outputs and step cache are process-local, so resume cannot reconstruct the complete patch (`apps/itotori/src/workflow/driver.ts:152-178,377-392`; `apps/itotori/src/composition/live/factory-finalizer.ts:51-67,98,109-119`; `apps/itotori/src/composition/live/artifact-store.ts:62-110`).                                                                                                                                                                                                            |
| Play            | Product patch launch registers only RealLive; browser launch fixes one private source scene, not the selected patch; Play Hub offers route-map/flag links but no launch (`apps/itotori/src/play/patch-runtime-launcher.ts:32-48`; `apps/itotori/src/play/reallive-browser-player-launch.ts:11-27`; `apps/itotori/src/ui/screens/PlayHubScreen.tsx:86-135,174-233`).                                                                                                                                                                                  |
| Refinement      | Durable revision code exists, but production constructs no repository/materializer/service; edit invokes the missing port and patch play reports its missing port (`apps/itotori/src/play/result-revision-service.ts:124-246`; `packages/itotori-db/src/repositories/localization-result-revision-repository.ts:58-62,145-271`; `apps/itotori/src/api-handler-mutation-wiki-play.ts:105-141`; `apps/itotori/src/services/database-services.ts:340-367`).                                                                                             |
| Enrichment      | Flags persist with a synthesized correction ID, but production context omits the supported human-correction reference and no feedback-to-context consumer was found (`apps/itotori/src/play/unit-feedback-adapter.ts:18-57`; `apps/itotori/src/prepass/context-snapshot-input.ts:14-64`; `apps/itotori/src/services/localization-production-config.ts:38-57`).                                                                                                                                                                                       |
| Benchmark       | Corpus/schema/sensitivity pieces are test-called; production ingests an external report, no runner/cockpit is wired, and the route falls through to Dashboard (`apps/itotori/src/benchmark-corpus/build.ts:59-125`; `apps/itotori/test/benchmark-sensitivity-metric-caught.test.ts:19-124`; `apps/itotori/src/services/project-workflow-service.ts:338-352`; `apps/itotori/src/ui/App.tsx:258-266`; `docs/itotori-translation-benchmark-methodology.md:1-9`).                                                                                        |
| Configuration   | Production dynamically indexes eight required names; none overlap the eight registered deployment inputs. The literal-read guard misses them; an audit set comparison measured `productionRequired=8`, `declaredOverlap=0` (`apps/itotori/src/services/localization-production-config.ts:20-35,91-123`; `config/environment-registry.json:1-58`; `scripts/env-registry-guard.mjs:87-127`).                                                                                                                                                           |
| Authentication  | Production ignores the session and acts as `local-user`; permission resolution exists, but this compatibility actor is not managed beta authentication (`apps/itotori/src/services/database-services.ts:107-124`; `apps/itotori/src/auth.ts:11-39`).                                                                                                                                                                                                                                                                                                 |

### Runtime, render, interaction, and persistence evidence

Formal playability is `NotEstablished` for all three engines. The only implementation of the core playability driver is a synthetic two-choice test; the contract itself has no frame, audio, discovery, or persistence hooks (`crates/utsushi-core/tests/playability_contract.rs:31-55`; `crates/utsushi-core/src/playability.rs:100-124,225-294`).

- RealLive retains a genuine resumable VM; an ignored candidate test can exercise pointer/advance/choice on one install and an offline oracle on another, but current execution and browser causality are UNVERIFIED. Live updates omit audio, save tests do not prove live save/load across a fresh process, and production only replay-validates text (`crates/utsushi-reallive/src/replay/implementation/session.rs:69-74,88-176,288-326`; `crates/utsushi-reallive/tests/entry_playthrough_oracle_real_bytes.rs:225-457`; `crates/utsushi-reallive/tests/save_real_bytes.rs:101-259`; `apps/itotori/src/play/reallive-runtime-launcher-adapter.ts:51-100`).
- Siglus executes the route with the first-choice policy before browser input; input only advances a precomputed boundary index. It has isolated real-object/text render work, but no causal browser audio/save/load or selected-patch launcher (`crates/utsushi-cli/src/siglus_live_player.rs:54-180`; `crates/utsushi-siglus/src/cg_port.rs:88-113`; `crates/utsushi-siglus/src/scene_vm/model.rs:8-11`).
- Softpal likewise renders before input and then indexes boundaries; pointer/choice error. A two-corpus real runtime test passed but emitted zero dialogue/choices and stopped at the missing native callback. There is no audio/save/load or selected-patch launcher (`crates/utsushi-cli/src/softpal_live_player.rs:55-145`; `crates/utsushi-softpal/tests/softpal_runtime_real_corpus.rs:55-215`; `crates/utsushi-softpal/src/scene_vm/scene_vm_execution.rs:107-115,160-169`; `crates/utsushi-softpal/src/engine_port.rs:139-188`).
- `just test browser` measured 26 passed and 4 skipped app tests; every real-player case was skipped. Five runtime-review tests passed on fixtures/built-ins, explicitly without a live game/server; no Siglus browser end-to-end test exists (`apps/runtime-web-review/README.md:16-28`). Browser sessions are memory-only, expire after five idle minutes, discard all but the newest frame, and expose only advance/pointer/choice (`apps/itotori/src/play/browser-player-session.ts:16-20,108-178,239-299,412-421`; `apps/itotori/src/ui/screens/LivePlayerScreen.tsx:86-104,204-255`).
- The UI claims one-click “playable patched game,” but delivery archives only the patch-target directory; native outputs are a patched script archive or loose overrides, not an install tree (`apps/itotori/src/ui/screens/PassLedgerPanelProducePatchedBuildAction.tsx:8-14`; `apps/itotori/src/patch-export/delivery-archive.ts:35-63`; `crates/kaifuu-cli/src/reallive_commands/patch.rs:18-38,107-158`; `apps/itotori/src/patchback/softpal-adapter.ts:1-10`). Until trusted launch exists, this must be labelled a patch package, not playable.

## Ranked blockers and chosen remedies

### 1. Establish one authoritative beta composition root

Build a durable server-side state machine whose typed stages are intake,
extract, structure, context/wiki, localize, review/correct, native apply,
Build-LQA, patch version, play session, observation, refinement, and benchmark.
Each transition consumes persisted artifact identities, is idempotent, records
coverage and failure, and is reachable from one dashboard project. Install all
required service ports rather than relying on missing-port proxy behavior.

Move translator-changeable settings from dynamic environment reads into
permissioned branch application configuration, with encrypted account/provider
credentials. Strengthen the environment guard to catch indexed reads. Derive
the actor from the Zitadel session and exact permission grants; roles remain
data. Migrate and remove the version 0.1 bridge and `local-user` compatibility
paths in the same wave rather than adding another shim
(`packages/localization-bridge-schema/README.md:7-17`;
`apps/itotori/src/auth.ts:14-25`).

**Rejected alternative:** patch the onboarding request with three fields and
bind missing ports one by one. It leaves artifacts client-owned, context/wiki
unbuilt, restart state ephemeral, configuration undeclared, and authentication
local; it cannot yield a reproducible beta transaction.

### 2. Make accepted output mean the corrected, reviewed bytes

Represent every draft/edit/repair as an immutable candidate revision with
parentage, source hash, target hash, defect lineage, model memo, and reviewer
receipts. Pass changed content—not only unit identifiers—through correction.
Run every implicated deterministic gate and reviewer against that candidate,
consume their verdicts, and finalize only the latest passing revision. Resolve
old and new accepted heads from durable storage on restart. Native-apply that
exact set, persist the root patch before delivery, and Build-LQA the persisted
artifact.

Abort on a fatal fault, stop new scheduling, drain all admitted provider work,
then close cost/database scopes. Admission must count confirmed cost plus
unresolved worst-case exposure plus the next reservation
(`apps/itotori/src/workflow/bounded-concurrency.ts:41-57`;
`apps/itotori/src/llm/physical-attempt-cost-context.ts:14-55`;
`packages/itotori-db/src/repositories/llm-http-attempt-repository.ts:56-166`).

**Rejected alternative:** replace the always-throws with pass-through stubs,
disable review/Build-LQA, or mutate the original draft in place. Stubs bypass
the release policy; mutation erases provenance; neither proves corrected bytes
are the bytes patched and played.

### 3. Make patched play an engine-adapter registry, not a proof demo

Define an engine-neutral runtime contract/runner and registry of engine-owned
adapters for discovery, fixed-tick launch, private frame/audio, causal actions,
route coordinates, controls, and persistent save/load. The local worker verifies
source/patch digests and compatibility, builds a copy-on-write overlay, and
launches that exact overlay by immutable patch version. Its receipt binds source,
patch, outputs, runtime, frame/audio, actions, disk save, and addressed unit.

Require capability rungs four through six for a bounded beta route. Do not call
a sparse patch archive, a precomputed trace, a rendered frame, or an advance
button “playable” without durability, causality, and exact-patch provenance.

**Rejected alternatives:** one adapter with engine switches repeats the current
scaling defect; pointing runtime at a sparse `patchTarget` is not executable;
copying/distributing an install violates the boundary. External native launch
may remain fallback delivery, but cannot bind observation or close refinement.

### 4. Define refinement as a durable graph transaction

An observation references patch, session, frame/audio, address, action,
persistent save, route, and unit. Triage chooses target, context, engine defect,
or rationale. Acceptance starts a durable saga: transactionally create a
`building` child plus outbox; idempotently append scoped enrichment, rerun,
review, native-apply, integrity-check, Build-LQA, and paired replay; compare the
parent head and select child last. Failure leaves parent selected. Crash at each
stage and concurrent-edit conflict must resume/refuse deterministically.

**Rejected alternatives:** existing flag/edit routes do not feed context and
span commits (`packages/itotori-db/src/repositories/localization-result-revision-repository.ts:72-120`);
a monolithic database/provider/filesystem “transaction” cannot provide atomic
rollback. Selection-last saga preserves lineage and a playable parent.

### 5. Replace asserted capability with receipt-derived two-title proof

For each engine run one private, fail-not-skip composed lane on two distinct
inventory identities: identify → version 0.2 extract → bridge-bound version 2
structure → nonzero fact join → actual production service root/durable stores/
certified roles → native apply → re-extract → pinned Playwright shipping
dashboard → causal branch → disk save → clean-process load → refine/relaunch.
Injected workflow ports are forbidden; recorded transport is a deterministic
gate, not a substitute for one live qualifying receipt. The content-free
receipt records commit/corpus/adapter hashes, field rates, executed tests,
patch/frame/audio/save hashes, and private references; every title/stage executes
nonzero assertions and capability data is generated only from fresh receipts.

This is necessary because the current private workflow claims
extract/structure/patch/replay, but its command dispatch reaches preflight only;
stage recording and manifest emission are dormant, and artifact upload only
warns when missing (`.github/workflows/real-bytes-private-proof.yml:12-16,38-47`;
`scripts/developer-command.mjs:261-324`;
`scripts/ci/private-real-byte-proof.mjs:308-371`). The current generated matrix
also still says Siglus extract/patch are unclaimed despite native
implementations (`apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.md:21-29,67-71`).

**Rejected alternative:** retain stage-local ignored tests, count a test that
returned early, inject fixture ports, count fixture-only browser review, or
hand-author `passed`. Softpal proves real stages can compose to zero facts; the
current mechanisms already false-green.

### 6. Make quality a diagnostic flywheel

Build a runner bound to exact accepted-output and patch hashes. Compare raw
baseline, initial, repaired, and human reference where licensed; keep a locked
held-out split. Emit deterministic layout/terminology/residue/speaker/choice
findings, seeded sensitivity, adjudicated model findings, blind human sample
and agreement, cost/latency/retry/fallback, calibration, and robustness. The
cockpit decomposes failures by cause and offers a scoped correction/backlog
action; the next child report shows whether that action improved held-out and
played evidence. “Official-or-better” wording additionally requires the paired
blind score's lower confidence bound to meet a preregistered zero noninferiority
margin against a licensed official reference. Private source, target, frames,
audio, saves, and paths never enter public artifacts (`docs/quality-claims.md:50-78`;
`docs/itotori-translation-benchmark-methodology.md:26-71`).

**Rejected alternatives:** one score, threshold-free reports, imported schema,
or fixture sensitivity. They do not establish validity, live semantic/voice
sensitivity, human calibration, or shipped-byte linkage; the repository makes
no superiority claim today (`docs/quality-claims.md:3-7`).

### 7. Design failure and recovery as beta features

Persist a phase/unit failure code, safe summary, private diagnostic reference,
retryability, admitted work/cost, last checkpoint, and next action. Poll active
runs. Offer pause/resume/cancel, retry from durable checkpoint, abandon with
cost reconciliation, and a content-free support bundle. Preflight engine
ambiguity, asset coverage, structure join, provider policy, storage, runtime,
save support, and exact worst-case exposure before spending.

Detached execution currently returns “started”; post-admission errors go to a
local failure file, while the ledger displays failure only for deadlines and
offers no recovery controls (`apps/itotori/src/services/launch-localization-pass.ts:195-213,223-261`;
`apps/itotori/src/ui/screens/PassLedgerPanel.tsx:38-68,171-243`).

**Rejected alternative:** add a troubleshooting runbook or tell testers to
reload/relaunch. A non-developer cannot see operator-local JSON, and restart
currently loses the accepted-output material needed for a complete patch.

## Copyright-safe onboarding boundary

The dashboard pairs a signed worker whose content-addressed toolchain is pinned
for a transaction; updates occur only between transactions, and mismatch
rolls back/resumes with the recorded version. A native picker records acquisition
attestation. The worker hashes read-only source, runs native work locally, and
keeps full bytes/frames/audio/saves/diagnostics in tester-private storage. The
service receives minimum encrypted/ZDR-routed content plus hashes, counts,
structure, and opaque references. Every session start/input/frame/delete is
project-permission-gated; public support is dialogue/art/audio-free receipts,
not merely “redacted” pixels (`docs/fixtures-and-corpora.md:75-87,142-184`).

Today only frame reveal is permission-checked; start/input/delete are not
(`apps/itotori/src/play/browser-player-routes.ts:20-72`;
`apps/itotori/src/server.ts:86-99`). Public RealLive/Siglus/Softpal frames retain
dialogue-derived pixels, contrary to the public-evidence rule
(`crates/utsushi-reallive/src/engine_port/lifecycle.rs:26-48`;
`crates/utsushi-cli/src/siglus_live_player/render.rs:181-205,244-304`;
`crates/utsushi-cli/src/softpal_live_player.rs:278-357`;
`docs/proposals/playability-program.md:89-106`).

Itotori must never commit or publish copyrighted payloads, copy an install into
the public catalog, use one tester’s text or enrichment across tenants without
explicit licensed scope, expose local paths/title-bearing filenames, mutate the
owned source tree, or claim that an ownership attestation is legal
verification.

**Rejected alternatives:** whole-install upload expands copyright/isolation
risk; a CLI excludes the tester (`docs/fixtures-and-corpora.md:168-174`);
redaction or an opaque session identifier is neither authorization nor a
dialogue-free public derivative.

## Delivery waves and completion observations

### Wave A — truth, contracts, and composition

Dependencies: none. Delete the legacy bridge/local actor paths with their
migrations; define version 0.2/version 2/current patch/play/refine contracts;
generate engine and service registries; install Zitadel session-to-permission
actors; move translator settings to application data; fix the indexed-read
guard; provision/assign the strict private-browser runner; make proof artifacts
receipt-derived.

Done: the composition test enumerates required ports, marks unfinished ones
unavailable, and drives every installed binding through a named nonzero
transition; gutting any binding turns it red. A fresh account lacks grants,
settings change without restart, legacy input is rejected, and the assigned
private lane fails if any of six identities/stage receipts is absent.

### Wave B — owned intake to correct native patch

Dependencies: Wave A contracts and identity. Build paired local-worker
onboarding, complete extraction/structure/context/wiki handoff, immutable
candidate correction, durable restart, review/adjudication, native apply, root
patch persistence, and patched-byte Build-LQA.

Done is observed when a non-developer starts from each of the six read-only
installs, sees all field rates and explicit blockers, and obtains a persisted
native patch whose re-extracted target hashes equal the reviewed corrected
outputs. Kill the service after partial finalization: resume must produce the
same patch hash and no duplicate provider charge.

### Wave C — exact patched play

Dependencies: persisted root patch and worker protocol from Wave B. Implement
the engine-neutral runner/registry and three engine adapters, overlay launch,
causal controls/frame/mixed-audio receipts, route mapping, persistent save/load,
session recovery, and private evidence controls.

Done: pinned Playwright drives the shipping dashboard for all six roots through
applicable controls, causal choice, nonsilent audio and private visual verdict,
player-issued disk save, total process termination, fresh-process load, and two
byte-identical normalized replays. Canonical state/frame match; mutating any
patch/receipt/frame/audio/save byte fails.

### Wave D — refinement, quality, and recovery

Dependencies: exact play receipts from Wave C. Implement observation binding,
selection-last enrichment saga, scoped invalidation/rerun, child patch replay,
benchmark runner/cockpit, cost exposure accounting, polling, recovery controls,
and support bundle.

Done: each route completes two refinements from the same persistent save with
paired-play invariants, expected target/frame delta, stable unrelated hashes,
future-context correction, and valid root/child quality gates. Inject Recovery
gate faults plus child Build-LQA failure, hash corruption, concurrent CAS
conflict, cancellation with admitted work, and crash after materialization:
parent stays selected, cost reconciles/quarantines, resume is idempotent. Gutting
abort/drain, propagation, or materialization turns its test red.

### Wave E — beta admission

Dependencies: all previous observations. Run an internal permissioned cohort,
then a guided external cohort, then an unattended cohort; advance only on
receipt completeness and observed task completion, not a calendar.

Done is observed when two independent non-developer testers per engine complete
intake through second refinement without shell/database intervention, every
private artifact remains within policy, all six final receipts are fresh for
the release commit, and every abandonment/failure has a visible classified
reason. A report of zero abandoned sessions without durable session-end
telemetry is invalid, not success.

## Cost of engine twenty-one

The fixed code/evidence delta is eight artifacts: one package implementing five
ports (identify/extract, structure, native patch, runtime, proof), one synthetic
mutation fixture, one manifest row, two private inventory rows, two private
scenario/expectation manifests, and one qualified-review receipt. Registry
generation adds all surfaces with zero shared conditionals. Per-install runtime
and review work varies with content, but the number of integration artifacts
does not grow with existing engines (`docs/proposals/playability-program.md:156-184`).

**Rejected alternative:** add cases to shared onboarding, patch loader, browser
session, and CI. That cost grows with every shared surface, creates divergent
truth, and has already left current capability data inconsistent with native
Siglus code.

## What makes a tester quietly give up

| Moment                                         | Current evidence                                                                                                                                                                    | Required product response                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Owned title is not a catalog candidate         | Bootstrap is disabled (`apps/itotori/src/ui/screens/OnboardingScreen.tsx:69-98`)                                                                                                    | Direct owned-install project plus capability report   |
| First setup never loads identity               | Production omits the identity port (`apps/itotori/src/services/database-services.ts:340-367`)                                                                                       | Zitadel session state and actionable permission error |
| Decode says units exist, bootstrap refuses     | Request/handler mismatch (`apps/itotori/src/ui/screens/OnboardingScreen.tsx:182-215`; `apps/itotori/src/api-handler-mutation-project.ts:64-72`)                                     | One staged transaction with resumable artifacts       |
| Partial extraction looks successful            | UI reports only unit count (`apps/itotori/src/ui/screens/OnboardingScreen.tsx:155-159`)                                                                                             | Per-field and asset coverage with release blockers    |
| Run says “started” forever                     | One-shot status and hidden local exception (`apps/itotori/src/ui/screens/PassLedgerPanel.tsx:171-243`)                                                                              | Polling, phase, cost, failure, resume/cancel          |
| “Playable” row has no play action              | Hub only links route map/flag (`apps/itotori/src/ui/screens/PlayHubScreen.tsx:119-132,218-233`)                                                                                     | Launch selected immutable patch                       |
| Session disappears before correction           | Sessions expire after five idle minutes (`apps/itotori/src/play/browser-player-session.ts:16-20,171-177`)                                                                           | Durable checkpoint/session recovery                   |
| Flag appears accepted but next pass repeats it | Correction ID is synthetic and context omits its head (`apps/itotori/src/play/unit-feedback-adapter.ts:18-57`; `apps/itotori/src/services/localization-production-config.ts:38-57`) | Show propagation scope and child patch                |
| Benchmark navigation returns dashboard         | Route is only a comment (`apps/itotori/src/ui/App.tsx:258-266`)                                                                                                                     | Working cockpit or remove the affordance              |
| Cost cap says safe while billing is unknown    | Reservations release on unknown completion (`apps/itotori/src/cli/localize-run-tracker.ts:102-145,476-484`)                                                                         | Exposure-inclusive admission and quarantine           |
| Advertised patch APIs return no useful route   | Catalog exceeds parsers (`apps/itotori/src/api-routes-second.ts:145-208`; `apps/itotori/src/api-handler-path-parsers.ts:258-267`)                                                   | Wire to version graph or hide until true              |

These gaps outrank cosmetic polish: each looks like user error, stale data, or a
dead end, so a tester can leave without believing there is a reportable defect.

## Evidence-gate measurements and limitations

| Measurement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Result                                                                                                                                                         | Limit                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public app audit: `cd apps/itotori && pnpm exec vitest run test/in-studio-decode-extract.test.ts test/structure-provider-registry.test.ts test/patchback-engine-adapter.test.ts test/workflow-driver-flow.test.ts test/browser-player-lifecycle.test.ts test/browser-player-input-relay.test.ts test/benchmark-corpus.test.ts test/benchmark-sensitivity-metric-caught.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Eight files, fifty tests passed, one skipped.                                                                                                                  | The skipped case is environment-gated real input; the rest use fake processes/ports or stub children, so this proves public contracts only (`apps/itotori/test/in-studio-decode-extract.test.ts:52-68,243-267`; `apps/itotori/test/structure-provider-registry.test.ts:10-153`; `apps/itotori/test/patchback-engine-adapter.test.ts:1-11,78-94`; `apps/itotori/test/browser-player-input-relay.test.ts:1-13,30-86`). |
| `cd apps/itotori && pnpm exec vitest run test/patchback-produce-build.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | One non-real test passed; two real product-patch tests skipped.                                                                                                | Confirms the committed two-title capability is not reproduced here; source/layout analysis supplies the stronger false-claim finding (`apps/itotori/test/patchback-produce-build.test.ts:50-81,105-106,233-240`).                                                                                                                                                                                                    |
| `cargo test -p kaifuu-siglus --test siglus_bridge_real_bytes -- --ignored --nocapture`; `cargo test -p kaifuu-siglus --test siglus_patchback_real_bytes -- --ignored --nocapture`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Both exited 101 before assertions because configured private input was absent.                                                                                 | Establishes fail-not-skip only; Siglus byte correctness/rates remain UNVERIFIED.                                                                                                                                                                                                                                                                                                                                     |
| Two `cargo run -q -p kaifuu-cli -- detect '<private-input>' --output '<temporary-output>'` and two `cargo run -q -p kaifuu-cli -- extract --engine softpal --game-dir '<private-input>' --bundle-output '<temporary-output>'` calls; `cargo test -p utsushi-cli --test softpal_structure_real_corpus -- --nocapture`; `cargo test -p kaifuu-softpal --test patchback_real_corpus -- --ignored --nocapture`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Both detected; extracted 30,176/39,848 units; structure passed with 30,165/39,832 messages, 19,990/28,665 speakers, 11/16 choices; patch passed.               | Detect/extract/structure used two directly staged inputs; patch used an audit-local temporary inventory. Native-stage, not configured product-loop, receipts.                                                                                                                                                                                                                                                        |
| `jq -s '{total:(map(.units\|length)\|add),sourceHash:(map([.units[]\|select((.sourceHash//"")!="")]\|length)\|add),context:(map([.units[]\|select(.context!=null)]\|length)\|add),patchRef:(map([.units[]\|select(.patchRef!=null)]\|length)\|add),speaker:(map([.units[]\|select((.speaker//"")!="")]\|length)\|add),protectedSpans:(map([.units[]\|select((.protectedSpans//[])\|length>0)]\|length)\|add)}' <two-private-bridge-outputs>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Total/sourceHash/context/patchRef 70,024; speaker 48,655; nonempty protected spans zero.                                                                       | Real extraction output only; code shows spans are hard-coded empty, so zero means missing extraction, not source absence (`crates/kaifuu-engine-fixture/src/softpal/real/extract.rs:31-126`).                                                                                                                                                                                                                        |
| Two `cargo run -q -p utsushi-cli -- structure --engine softpal --game-root '<private-input>' --output '<temporary-output>'` calls, then `jq -s '{outputs:length,messages:([.[].scenes[].messages[]]\|length),messageText:([.[].scenes[].messages[]\|select((.text//"")!="")]\|length),speaker:([.[].scenes[].messages[]\|select((.speaker//"")!="")]\|length),textSurface:([.[].scenes[].messages[]\|select((.textSurface//"")!="")]\|length),choices:([.[].scenes[].choices[]]\|length),choiceLabel:([.[].scenes[].choices[]\|select((.label//"")!="")]\|length),branchEntryScene:([.[].scenes[].choices[]\|select((.branchEntryScene//"")!="")]\|length),sourceBundleHash:([.[]\|select((.sourceBundleHash//"")!="")]\|length),bridgeId:([.[]\|select((.bridgeId//"")!="")]\|length),nextScene:([.[].scenes[]\|select((.nextScene//"")!="")]\|length),nonemptyFanout:([.[].scenes[]\|select((.dispatchFanoutScenes//[])\|length>0)]\|length)}' <two-structure-outputs>` | Outputs 2; messages/text 69,997; speaker 48,655; textSurface 0; choices/labels 27; branchEntryScene/sourceBundleHash/bridgeId/nextScene/nonemptyFanout 0.      | Producer emits linear version 1; zeros reflect missing implementation, not proven source absence (`crates/utsushi-cli/src/structure/softpal.rs:124-177`).                                                                                                                                                                                                                                                            |
| `cargo test -p utsushi-softpal --test softpal_runtime_real_corpus -- --ignored --nocapture`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | One test passed with both staged inputs; each emitted zero dialogue and choices before the missing native callback.                                            | Proves deterministic bootstrap/stop, not interactive play (`crates/utsushi-softpal/tests/softpal_runtime_real_corpus.rs:55-215`).                                                                                                                                                                                                                                                                                    |
| `just test browser`; `rg --files apps/itotori/e2e \| rg siglus`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | App: 26 passed/4 skipped, all real-player cases skipped; fixture review: 5 passed; search found no Siglus browser test.                                        | Fixture UI evidence only (`apps/itotori/e2e/browser-player-progress.e2e.ts:17-29`; `apps/itotori/e2e/browser-player-softpal.e2e.ts:21-33`; `apps/runtime-web-review/README.md:16-28`).                                                                                                                                                                                                                               |
| `cargo test -p corpus-registry --test corpus_registry_staged -- --ignored --nocapture`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Failed without the private root; with it, failed because local inventory used obsolete `root`, not `inventory/v1` `relative_path`.                             | Proves this host cannot run the six-input lane, not that correctly configured trunk rejects it (`crates/corpus-registry/tests/corpus_registry_staged.rs:3-51`; `docs/fixtures-and-corpora.md:147-166`).                                                                                                                                                                                                              |
| `rg -o 'OPENROUTER_API_KEY\|ITOTORI_[A-Z0-9_]+' apps/itotori/src/services/localization-production-config.ts \| sort -u \| wc -l`; `comm -12 <(rg -o 'OPENROUTER_API_KEY\|ITOTORI_[A-Z0-9_]+' apps/itotori/src/services/localization-production-config.ts \| sort -u) <(jq -r '.[].name' config/environment-registry.json \| sort) \| wc -l`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Eight production-required names; zero overlap with the eight registered names.                                                                                 | Static set comparison only; dynamic construction outside this file remains invisible.                                                                                                                                                                                                                                                                                                                                |
| 2026-07-29: `gh api repos/cat-cave/itotori/actions/runners --jq '{total_count,runners}'`; `gh api 'repos/cat-cave/itotori/actions/workflows/real-bytes-oracle.yml/runs?per_page=100' --jq '{count:(.workflow_runs\|length),conclusions:(.workflow_runs\|group_by(.conclusion)\|map({conclusion:.[0].conclusion,count:length}))}'`; `gh api 'repos/cat-cave/itotori/actions/workflows/real-bytes-private-proof.yml/runs?per_page=100' --jq '{count:(.workflow_runs\|length)}'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Zero runners; oracle count twenty: nineteen cancelled/one null-queued; private-proof count zero.                                                               | Current visible service history, not private/deleted execution (`.github/workflows/real-bytes-oracle.yml:60-97`; `.github/workflows/real-bytes-private-proof.yml:26-47`).                                                                                                                                                                                                                                            |
| Structural guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Game-name guard cannot find arbitrary prose/opaque bytes; node-reference guard cannot see untracked files; environment guard cannot see dynamic indexed reads. | The new document is explicitly path-scanned below (`scripts/audit-no-game-names.mjs:1-28`; `scripts/audit-no-node-ids.mjs:1-28`; `scripts/env-registry-guard.mjs:87-127`).                                                                                                                                                                                                                                           |

## UNVERIFIED and deliberately not done

| Claim/scope                                                                                                    | Why                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UNVERIFIED — RealLive two-title product correctness and field rates.**                                       | The audit inventory did not satisfy the contract and the product resolver excludes the alternate supported layout; single-title/native code is not a substitute.                                                                                          |
| **UNVERIFIED — Siglus real-byte correctness and field rates.**                                                 | Strict extract/patch failed on absent configured bytes; detector/structure returned green after skipping. Only strict fail-not-skip behavior was observed.                                                                                                |
| **UNVERIFIED — every engine’s full localization, patched runtime, save/load, refinement, and quality result.** | Installed blockers make these observations impossible; synthetic components do not fill the gap.                                                                                                                                                          |
| **UNVERIFIED — non-developer usability, accessibility, throughput, latency, provider bill, and abandonment.**  | No instrumented beta session or qualifying provider run occurred; no scale/UX performance claim is made.                                                                                                                                                  |
| **UNVERIFIED — managed Zitadel and tenant isolation.**                                                         | No deployed IdP/account/browser session was available; source establishes the local actor, not future deployment behavior.                                                                                                                                |
| Softpal scope                                                                                                  | Two real native inputs do not prove source absence for omitted fields, product context, native-build delivery, or play.                                                                                                                                   |
| Deliberately not done                                                                                          | No source, migration, fixture, workflow, branch, commit, or external system changed; no private payload/path was copied. This is a strategic program, so proposed gutted-implementation tests were not run; each wave requires that mutation observation. |

## Final guard transcript

The two path-scoped calls cover this otherwise-untracked document:

```text
$ node scripts/audit-no-game-names.mjs docs/proposals/beta-readiness-program.md
game-name guard: passed. 0 enforced references across 1 scanned files. Limit: unstructured prose names and opaque bytes need an authoritative inventory.
$ node scripts/audit-no-node-ids.mjs docs/proposals/beta-readiness-program.md
node-id guard: passed. 0 references across 1 scanned files.
Scope: all tracked files (including binary files); exempt only generated, content-addressed fixtures/, generated roadmap/, and applied packages/itotori-db/migrations/. Cannot see untracked or ignored files.
```

Required whole-tree commands, run after the final edit:

```text
$ node scripts/audit-no-game-names.mjs
game-name guard: generated ledger requires regeneration: 8 reference(s).
[Eight title-bearing ledger excerpts omitted because copying them would violate this document's zero-name constraint.]
game-name guard: passed. 0 enforced references across 4218 scanned files. Limit: unstructured prose names and opaque bytes need an authoritative inventory.
$ node scripts/audit-no-node-ids.mjs
node-id guard: passed. 0 references across 3685 scanned files.
Scope: all tracked files (including binary files); exempt only generated, content-addressed fixtures/, generated roadmap/, and applied packages/itotori-db/migrations/. Cannot see untracked or ignored files.
$ node scripts/file-line-cap-guard.mjs
file-line-cap guard scope: enforces a 500-line cap on tracked source files (.js: 3, .mjs: 210, .rs: 1396, .ts: 1404, .tsx: 107); scanned 3120.
file-line-cap guard limits: does not inspect untracked or ignored files, generated output not tracked by Git, or source files with other extensions.
file-line-cap guard: passed. The 500-line cap is absolute; all tracked files in the stated scope are at or below the threshold.
$ pnpm exec vp fmt --check
Checking formatting...
All matched files use the correct format.
$ git diff --check
(no output; exit 0)
$ git diff --no-index --check /dev/null docs/proposals/beta-readiness-program.md
(no diagnostics; exit 1 is the expected new-file difference)
Limit: the required git diff command does not inspect this untracked file; the supplemental command does.
$ wc -l docs/proposals/beta-readiness-program.md
492 docs/proposals/beta-readiness-program.md
```
