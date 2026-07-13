# Localization Engine Overhaul — Foundation Design

Status: **canonical foundation** (supersedes the cosplay orchestration loop). Grounds the
fresh DAG. Consolidates four harsh architecture audits (sol + terra), the philosophy audit
(`docs/audits/localization-philosophy-alignment.md`), the FE/BE coherence audit, and the
DAG triage — as corrected by the product decisions recorded in §2.

---

## 1. What this replaces and why

Four independent audits concluded the localization **orchestration loop** is _cosplay_: it
withholds, defers, discards, and fakes completeness. Concretely, on real bytes:

- The RealLive synthesizer fills every bridge unit with one selected unit's `「[en-US] <source>」`.
- `agentic-loop.ts` clears `finalDraftText`; `project-driven-executor.ts` synthesizes a
  source-echo; QA can erase a draft to nothing.
- The "reviewer queue" is a **deferral sink**: created records are dead on arrival (no
  `contextRefs`), no action revises a result, no rerun worker exists.
- `RetryPolicy` is a classifier-only façade; `fallbackModels` never reach OpenRouter.
- Enrichment is reduced to ID refs; the central context store is disconnected; glossary
  writeback is fiction (no `rerun.*` handler → the claimed job throws).

The **byte substrate is genuine and stays** (kaifuu decode/extract/patchback, utsushi
VM/render/replay/engine-ports, catalog/vault ingest, auth, CI/proof infra). This overhaul
rebuilds only the loop, from core principles, and unifies it with the interface.

---

## 2. The product model (RESOLVED decisions)

These are settled. They override any contrary recommendation in the source audits.

### 2.1 The promise

> Under **default settings**, on a **supported engine**, one cycle producing a complete
> playable patch is a **guarantee, not a wish.**

Someone buys a game, does not speak the source language, wants to play it in their language.
**One run → a complete, playable patch** (every in-scope unit written). Then, through the
dashboard + CLI, they act as a **play tester** and iterate. The cycle may never end: a rough
v1 can be shared as a community patch, feedback crowdsourced, folded into v2, and so on
forever.

### 2.2 Coverage gates the patch. Quality never does.

- **What gates a patch is exactly what the user configured** — the _scope_. Ran a whole
  game → the whole game is localized, every in-scope unit written. Scoped to one route → that
  route, complete within scope, iterable to broader scope later. Scope is a deliberate input,
  never an excuse to leave in-scope units unwritten.
- **Quality is a measured metric, not a gate.** QA findings are **permanent annotations on
  the record** — surfaced to the play tester, never withheld from release. "The draft can't
  convince a QA agent it's good" is _not_ a blocker: annotate it and ship. Quality is assessed
  in partnership with the user; it is the input to _their_ decision — "is my job done, or do I
  iterate?" — not a machine gate.

### 2.3 Every LLM call writes. Two failure lanes.

Every in-scope unit ends with **one non-blank written draft**. There is no "leave
untranslated," no deferral, no dead queue. Failures split into two lanes:

- **Content / transient** — the model outputs unreliably, emits invalid/partial JSON,
  refuses, or hits a rate limit. Handling: **bounded retry with corrective feedback**
  (what it did wrong) → **always resolves to a written draft.** Never pauses the run, never
  involves a human. With a supported model and a few informed retries, recovery is expected.
- **Operational blocker** — budget cap reached, provider outage, or an itotori bug. Handling:
  **pause gracefully, persist all progress, surface to the operator** to intervene (raise the
  cap, wait out the outage, fix the bug), then **resume** from the durable next action. No
  patch is emitted while paused. This is run-level _operator_ intervention — distinct from the
  play tester, and categorically not the toxic per-line queue.

Operational blockers should be **rare and, in a realistic default setup, never happen.**
When one fires, it is a **bug to root-cause and eliminate** (it feeds the failure taxonomy),
never designed-in acceptable behavior.

### 2.4 Decision A — write guarantee: **nonterminal / resumable** (not local fallback)

Remote attempts are bounded. On a **content/transient** class the supervisor retries with
corrective information until a draft is written. On an **operational** class (budget, outage,
bug) the unit/run becomes **nonterminal and resumable**: progress is persisted, the operator
is surfaced the exact blocker, and the run resumes when the condition clears. We do **not**
require an always-available local fallback model — too many failure classes (a budget cap
especially) deserve graceful operator intervention rather than silent downgrade to a weak
local model.

### 2.5 Decision B — "genuine structural blocker" is (almost) not a real class

Either a game is localizable with itotori, or the gap is an **itotori bug / feature request**
to fix — tracked out-of-band (DAG node / issue), not a runtime "write source into the target
field and fail the release" path. Everything else (unreliable output, outage, budget) is
transient/operational per §2.3. We therefore **drop** the `genuineBlocker` source-preserving
unit outcome from the audits' proposals. The finalizer's only hard failure is a real
operational blocker the operator chose not to resolve, or an itotori defect — both of which
are bugs, not translation outcomes.

### 2.6 Escape hatches exist, but only as bugs

There is a **hard retry ceiling that errors out**, set well below 100 attempts — the
degenerate-misconfiguration guard (e.g. an operator forces a 1B, 2024-era model that cannot
structure a tool call on its hundredth try). Under default settings on a supported engine it
must **never** fire. When any escape hatch fires it is treated as a **bug to resolve**, not
intended behavior — logged with structured diagnostics into the failure taxonomy and driven
to zero.

### 2.7 The human roles

- **Operator** — configures + launches runs; resolves _operational_ blockers (budget/outage/
  bug) to let a paused run resume. Not per-line, not quality.
- **Play tester** — the only human role in the _patch_. Plays the patched game in their
  target language; browses + edits the **wiki** (the enrichment/context brain); edits result
  text; supplies feedback + context that feeds the next run. The interface **may** surface
  low-confidence / high-contest QA callouts so the play tester can weigh in — but that is
  play-testing input on an _already-written_ result, never a per-line approval gate.
- **There is no reviewer.** No per-line approval, no per-action HITL, no human as part of a
  localization wave. All approve/reject/defer/escalate machinery is deleted (§7 capstone).

### 2.8 Decision C — existing UI: rebuild domain, reuse presentation

Keep the React shell, routing, typed API client, design-system components, comparison layout,
textarea editor, scene filmstrip, wiki cards, cost/progress panels. **Rewire their domain
contracts** onto runs / patch-versions / results / context-versions / feedback. **Delete** the
`ReviewerQueueScreen`, approve/reject/defer/escalate/request-repair controls, the reviewer
evidence loader, queue-keyed Play comparison, and "send to review" flags. Primary navigation
becomes: **Runs · Patches/Play · Results · Wiki · Feedback/Refine · Settings.**

---

## 3. Iteration is first-class (the identity chain)

A run is not a terminal event; it is one turn of a loop. The durable identity chain:

```
project / locale-branch
  → run (frozen scope + routing + cost policy)
    → written unit outcomes (every in-scope unit, one non-blank draft + quality annotations)
      → patch VERSION (exactly the frozen scope units; built, applied, runtime-validated)
        → play-test session (operator/community plays the patch)
          → feedback (result edits, comments, added context, wiki edits — batched or individual)
            → refinement run (reuses valid prior results; redrafts affected + newly in-scope)
              → next patch VERSION
                → validation evidence  →  (loop)
```

The pass-ledger and the wiki **compound** across versions — the flywheel. Wiki edits are
versioned canonical context that (a) resolve into the next run's ContextPacket and
(b) invalidate affected units for rerun.

---

## 4. Data model (unified)

Concrete TS shapes; each implies a migration. **No optional/deferred target text anywhere.**

```ts
// ---- Written outcome: every in-scope unit ends here, always with non-blank text ----
type NonBlankTargetText = string & { readonly __brand: "NonBlank" };

interface TranslationCandidate {
  id: string;
  outcomeId: string;
  body: NonBlankTargetText; // never blank, never source-echo
  producedBy: { model: string; provider: string }; // real served pair
  attemptId: string; // links to the LlmAttempt that produced it
  kind: "primary" | "repair";
}

interface QaFinding {
  // ANNOTATION ONLY — never removes text, never gates release
  id: string;
  outcomeId: string;
  candidateId: string; // finding is scoped to the candidate it judged
  severity: "info" | "minor" | "major" | "critical";
  category: string; // glossary | style | consistency | accuracy | ...
  note: string;
  contested: boolean; // re-QA disagreement → surfaced as a play-test callout
  confidence: number; // low confidence → surfaced as a play-test callout
}

interface WrittenUnitOutcome {
  id: string;
  runId: string;
  unitId: string; // frozen-scope membership
  selectedCandidateId: string; // the chosen non-blank candidate
  candidates: TranslationCandidate[];
  findings: QaFinding[]; // permanent quality annotations (metric, not gate)
  qualityFlags: string[]; // e.g. qa_unresolved, repair_budget_exhausted (informational)
  writtenAt: string;
  // NOTE: no deferredReason, no genuineBlocker, no finalDraftText|undefined XOR.
}

// ---- Durable execution journal ----
interface RunRecord {
  id: string;
  projectId: string;
  localeBranchId: string;
  scope: FrozenScope; // whole-game | work | route | explicit unit set
  routingPolicy: RoutingPolicy;
  costPolicy: CostPolicy;
  baseVersionId?: string; // set for refinement runs
  feedbackBatchIds: string[]; // frozen inputs for a refinement run
  wikiHeads: Record<string, string>; // context-entry head versions frozen at launch
  status: "running" | "paused" | "finalizing" | "succeeded" | "failed" | "aborted";
  pausedBlocker?: OperationalBlocker; // budget | outage | bug — resumable, operator-facing
}

interface OperationalBlocker {
  // §2.3 lane 2 — rare, a bug to eliminate
  kind: "budget_cap" | "provider_outage" | "itotori_bug";
  detail: string;
  evidence: string;
  raisedAt: string;
  operatorAction: string; // "raise cap", "wait/retry", "file+fix bug"
}

interface LlmAttempt {
  // one physical provider attempt (persist BEFORE dispatch)
  id: string;
  runId: string;
  unitId: string;
  stage: "enrich" | "translate" | "qa" | "repair";
  logicalCallId: string;
  attemptIndex: number;
  model: string;
  provider: string;
  providerRunId?: string;
  costUsd?: string; // exact decimal, reconciled even if malformed/refused
  finishState?:
    | "ok"
    | "refusal"
    | "empty"
    | "invalid_json"
    | "schema_invalid"
    | "semantic_invalid"
    | "timeout"
    | "rate_limited"
    | "network"
    | "cost_denied";
  retryDecision?: "retry" | "advance" | "write" | "pause";
  artifactRef?: string; // request+response body persisted
}

// ---- Persistent context brain (surfaced AS the wiki) ----
interface ContextEntry {
  // scene | character | relationship | route | choice | speaker | term | style | note
  id: string;
  kind: string;
  projectId: string;
  head: string; // current version id
  origin: "run_generated" | "play_tester_edit" | "inherited";
}
interface ContextEntryVersion {
  id: string;
  entryId: string;
  parentVersionId?: string;
  body: unknown; // typed per kind
  citations: string[];
  provenance: { by: string; runId?: string };
  createdAt: string;
  affectedUnitIds: string[]; // computed on write → invalidation
}
interface ContextPacket {
  // immutable, bounded, resolved per unit; SAME packet to translate/repair/QA
  unitId: string;
  resolvedFromVersions: Record<string, string>;
  scene: unknown;
  speakers: unknown;
  siblingEvidence: unknown;
  glossary: unknown;
  style: unknown;
}

// ---- Patch versions + play-test feedback (iteration) ----
interface PatchVersion {
  id: string;
  runId: string;
  projectId: string;
  localeBranchId: string;
  scope: FrozenScope;
  unitOutcomeIds: string[]; // exactly the frozen scope
  artifactHashes: Record<string, string>;
  status: "building" | "playable" | "failed";
  parentVersionId?: string; // lineage across iterations
}
interface LocalizedResultRevision {
  // a play-tester (or run) edit of one unit's target text
  id: string;
  unitId: string;
  patchVersionId: string;
  body: NonBlankTargetText;
  origin: "run" | "play_tester";
  parentRevisionId?: string;
  actor: string; // real, verified provenance
}
interface FeedbackEvent {
  id: string;
  patchVersionId: string;
  unitId?: string;
  kind: "result_edit" | "comment" | "added_context" | "wiki_edit" | "runtime_observation";
  body: unknown;
  batchId?: string;
  actor: string;
  createdAt: string;
}
```

Migrations imply: `itotori_written_unit_outcomes`, `itotori_translation_candidates`,
`itotori_qa_findings`, `itotori_run_records`, `itotori_llm_attempts`,
`itotori_context_entries` + `_versions`, `itotori_patch_versions`,
`itotori_localized_result_revisions`, `itotori_feedback_events` (+ batches), and
`itotori_run_cost_accounts` (exact-decimal reservations). Each new-loop PR **deletes** its
legacy toxic table/branch in the same change (no shims).

---

## 5. Control flow

### 5.1 InvocationSupervisor (all LLM calls route through it)

Every production LLM call goes through one supervisor. Static enforcement forbids direct
`provider.invoke()` outside provider adapters and supervisor tests. It owns: logical-call +
physical-attempt IDs, per-attempt deadline + cancellation, concurrency/rate admission, exact
cost reservation, request/response artifact persistence, deterministic JSON salvage, schema +
semantic validation, retry classification with backoff + jitter + **corrective prompts naming
what was wrong**, output persistence, cost reconciliation, and **resume from the durable next
action**.

Failure handling (bounded per route — never an infinite loop):

| Class                                      | Same-route action                                   | Advancement                                    |
| ------------------------------------------ | --------------------------------------------------- | ---------------------------------------------- |
| 429                                        | honor Retry-After, capped, jittered                 | advance remote model after bound               |
| 408 / 5xx / network                        | backoff + per-attempt deadline                      | advance after bounded attempts                 |
| timeout / hang                             | abort request + decode on one deadline              | advance immediately after bound                |
| empty / partial                            | corrective re-ask naming required fields + unit IDs | advance after 2 invalid                        |
| refusal / filter                           | record refusal; corrective re-ask when safe         | advance to compatible model                    |
| invalid JSON                               | deterministic salvage (no provider call)            | one schema re-ask, then advance                |
| schema-invalid                             | corrective re-ask with validation errors            | advance after bound                            |
| missing/dup ID, blank body                 | semantic corrective re-ask for exact totality       | advance after bound                            |
| **hard retry ceiling** (§2.6)              | —                                                   | **error out (bug); never fabricate**           |
| **cost admission denied**                  | do not dispatch                                     | **pause run (operational blocker) → operator** |
| **provider outage** (all routes exhausted) | —                                                   | **pause run (operational blocker) → operator** |
| QA content concern                         | _not_ an invocation failure                         | persist finding; retain best candidate         |

Content/transient classes terminate in a **written draft**. Cost/outage classes terminate in a
**resumable pause** surfaced to the operator (§2.3–2.4). The retry ceiling erroring is a bug
(§2.6).

### 5.2 Per-unit flow

1. Load immutable run-unit record + source snapshot.
2. Resolve revision-valid context; invoke only missing/stale enrichment via the supervisor;
   persist each enrichment/speaker result as a **context version**.
3. Re-resolve + freeze **one ContextPacket**.
4. Reuse a prior valid, unaffected patch result; else invoke translation.
5. **Persist the first usable candidate immediately.**
6. Deterministic validation + focused QA calls against that candidate + packet.
7. Persist candidate-scoped findings + rationale (annotations).
8. If useful, repair with the exact candidate + findings + packet; persist every repair
   candidate before re-QA.
9. Select the best written candidate. Remaining concerns become **quality flags + play-test
   callouts** — never withheld.
10. Transactionally create the `WrittenUnitOutcome` + a run-origin result revision; mark the
    unit **written**.

No catch block may convert an exception into a terminal unit failure, source text, or a human
task. (Operational pause is a run-level state, not a unit outcome.)

### 5.3 Atomic cost reservation

Before dispatch: acquire concurrency permit + rate token; estimate worst-case exact cost;
in one transaction reserve against the cap
(`spent + reserved + worst_case <= cap`); insert the reservation + started attempt; dispatch;
**reconcile reserved → billed cost even if the response is malformed or refused.** Reservation
denied (cap reached) → **pause the run as an operational blocker** and surface the operator
(raise cap / resume) with all progress persisted. Budget exhaustion never silently completes a
partial run and never fabricates text.

### 5.4 Terminal run finalizer (idempotent, run-level lock)

**Success predicate (coverage only — quality is NOT here):**

- No unresolved operational blocker.
- Every frozen-scope unit has one `WrittenUnitOutcome` with a valid non-blank candidate.
- Every outcome has a result revision.
- No call remains running or retry-waiting.
- Every cost reservation is reconciled.
- A `PatchVersion` contains exactly the frozen-scope units.
- Patch build + apply + runtime/structural validation succeeded; artifacts + hashes exist.

Then it atomically marks the patch **playable** and the run **succeeded**. QA findings never
enter this predicate — they ride along as annotations.

**Non-success:** an unresolved operational blocker → run **paused** (resumable, not failed);
explicit cancellation → **aborted**; an irrecoverable patchback/build fault or itotori defect
→ **failed** (a bug to fix). No path writes source into a target field. The canonical summary
is projected from durable rows; `run-summary.json` is an idempotent outbox projection of the
same schema, not a separate truth.

### 5.5 Iteration loop

Initial run freezes scope → playable v1. A play tester opens v1 (target-first, optional
source/provenance drill-down; QA callouts visible but never gating). A target edit creates a
result revision + deterministic child patch revision. Comments/observations/context attach to
the exact version observed. Wiki edits append context versions + compute affected units. The
play tester selects individual or batched feedback → launches a refinement run, which freezes
{base version, feedback batch IDs, wiki heads, scope, routing/cost}. Unaffected units reuse
prior non-blank result revisions; affected + newly in-scope units are redrafted. The run still
writes one outcome per in-scope unit; the coverage barrier produces the next playable version.
Broadening scope freezes the larger obligation set and writes every newly included unit.

---

## 6. Unified dashboard + CLI surfaces

Every backend capability has a frontend + CLI representation; no orphaned backend, no orphaned
UI. (Condensed from the full audit table.)

| Capability          | Dashboard                                                              | CLI                                                    |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Import / decode     | onboarding shell; real source/game registration                        | `extract`, `localize-game`                             |
| Configure scope     | run form: whole-game/work/route/explicit + exact count                 | `itotori run start --scope … --dry-run`                |
| Routing / fallback  | model-routing screen wired to the live resolver                        | `itotori models routes`, `itotori doctor`              |
| Start / refine run  | "Start run" / "Refine from version"                                    | `itotori run start`, `itotori refine`                  |
| Run status          | progress, stage, retry timer, exact coverage, **pause/blocker banner** | `itotori run show --follow`                            |
| Attempt provenance  | per-unit attempt timeline                                              | `itotori run attempts <run>`                           |
| Cost                | spent + reserved panels                                                | `itotori run cost <run>`                               |
| Resume a paused run | operator "Resume" action on the blocker banner                         | `itotori run resume`                                   |
| Patch versions      | versions page: scope, hashes, provenance, status, lineage              | `itotori patch list/show/apply`                        |
| Play the patch      | "Play this patch" + runtime state                                      | `itotori patch play <version>`                         |
| Browse results      | target-first scene/unit browser                                        | `itotori result show`                                  |
| Edit result         | textarea/comparison over real revisions                                | `itotori result edit`                                  |
| QA debate           | informational callouts (low-confidence/contested) w/ provenance        | `itotori result callouts`                              |
| Wiki                | browse/edit all entry kinds, citations, history, impact                | `itotori wiki list/show/edit/history`                  |
| Feedback            | comment/edit/context/runtime forms; inbox; "Refine selected"           | `itotori feedback add/batch`, `itotori refine --batch` |

---

## 7. Fresh DAG — keep / discard / reclassify + the P0 spine

### 7.1 Triage (from the DAG-triage audit; ~1482 nodes today)

- **KEEP (~324) — the byte substrate that genuinely stands.** kaifuu decode/extract/patchback
  (~80), utsushi VM/render/replay/engine-ports (~67), catalog/vault ingest (~67), auth (18),
  CI/tiered-CI/proof infra (~72), ITOTORI-001–018 durable primitives.
- **DISCARD (~320).** 226 secondary-engine (non-RealLive) breadth nodes (other games are not
  worth our time until the core loop is genuine); 29 reviewer-queue/approval/deferral nodes;
  7 old-loop "proof" nodes validating cosplay; ~60 sentinel/stub/"for-now" scaffolds. Plus the
  ~11 DONE-but-illusory nodes (e.g. ITOTORI-222 encodes `deferred_to_human`) whose code this
  overhaul deletes — they are not trustworthy foundation.
- **RECLASSIFY (~169).** App-layer draft/QA/export, play-test UI, and context nodes whose
  capability is real but whose acceptance encoded a broken assumption (deferral tolerated, no
  interface representation, single-run/non-iterative). They carry forward re-scoped to
  every-unit-written + iterative + play-tester + interface-cohesive, folded under the spine.

### 7.2 The P0 spine (12 nodes, 4 phases — no shims; each PR deletes its toxic path)

**Phase 1 — written outcomes + durable execution**

1. `p0-core-canonical-written-unit-outcome` — `WrittenUnitOutcome`, non-blank candidates,
   annotation-only findings, exact scope totality. Deletes the deferred/blank/source-echo XOR.
2. `p0-core-attempt-and-outcome-journal` — durable run/unit/call/attempt/candidate/finding
   repos + read models. Deletes the pseudo-attempt sink + accepted/deferred JSON as truth.
3. `p0-core-universal-invocation-supervisor-retry` — the supervisor + retry matrix + bounded
   advancement + **resume**; content/transient → written; cost/outage → resumable pause;
   hard-ceiling error (bug). Deletes the classifier façade + direct `provider.invoke()`.
4. `p0-core-atomic-cost-reservation-and-resumable-pause` _(retitled from
   `…-and-fallback`)_ — exact-decimal reservation, billed-cost recovery, **cap-reached →
   graceful pause + operator resume** (no local-fallback requirement). Deletes process-local
   `spentUsd` check + the "provider-side fallback is resilience" claim.
5. `p0-core-terminal-run-finalizer` — one all-path finalizer, coverage-only success predicate,
   `paused`/`failed`/`aborted` states, minimal patch-version foundation, idempotent
   build/apply/validate/summary outbox. Deletes split success/abort schemas + hard-coded pass
   rows.

**Phase 2 — persistent context + wiki brain** 6. `p0-core-persistent-context-brain-primary-loop` — versioned central context + source/sink/
invalidation wiring; persisted speaker + semantic outputs. Deletes refs-only results +
in-place overwrite. 7. `p0-core-resolved-context-to-translation-and-qa` — immutable bounded ContextPacket, exact
parity across translate/repair/QA, real sibling evidence. Deletes context-free QA +
`existingSpeakerLabels: new Map()` + `sceneUnits: []`. 8. `p0-core-context-correction-flywheel-real-rerun` _(retitle: play-tester context-correction
flywheel)_ — versioned context/glossary/style writes, dependency + invalidation, a **real
registered refinement worker** + typed outbox, explicit feedback-batch triggers. Deletes
metadata-only "updates" + the handlerless `rerun.*` chain. 9. `p0-core-wiki-browsable-editable-enrichment` _(new)_ — dashboard + CLI browse/detail/edit/
history over the context store; edit → new version → invalidation → next packet, proven on
real Postgres. Deletes the GET-only façade.

**Phase 3 — play-tester surfaces + first-class iteration** 10. `p0-core-result-revision-hitl` _(retitle: play-tester result revision + delivered patch
revision)_ — direct target-text revision API/CLI, atomic result revision + deterministic
child patch revision, target-first detail. Deletes correction-to-queue + reviewer-item
dependency + fake "approved patch" history. 11. `p0-core-iterative-patch-versioning-and-playtest-feedback` _(new)_ — play sessions, patch
lineage, feedback events/batches, real play/open/launch, refinement-run creation,
complete-within-scope expansion, informational QA callouts. **North-Star e2e proof:**
run → playable v1 → play-test → refinement run → playable v2. Deletes queue-keyed fake Play + flag-to-review + hard-coded succeeded rows.

**Phase 4 — purge capstone (completed).** 12.
`p0-core-purge-reviewer-queue-as-deferral` removed `ReviewerQueueBridge`, the
per-unit decision controls and screens, deferred item kinds, the queue database
tables, queue-driven rerun chain, fake review payloads, and the legacy manual
verification state. Legitimate human work now changes a result revision or
canonical context through result editing, context correction/wiki, and patch
iteration; RouteMap is read-only context freshness. The cross-engine
complete-patch regression remains the proof.

**Cancelled (subsumed):** `philosophy-always-draft-deferral-carries-best-effort-draft` (a
best-effort draft is now the _only_ outcome), `persist-asset-review-items-to-db-reviewer-queue`
(extends the dead queue).

### 7.3 Milestone

The spine defines a single **`localization-engine-overhaul`** milestone on the identity chain
(§3). Alpha (Oshioki/Sweetie e2e on Linux + live LLM + agentic) is redefined as "North-Star
cycle is a guarantee under default settings on RealLive," proven by node 11's e2e.

---

## 8. Open items (mechanical, not decisions)

- **Ledger reconcile before surgery.** The local qd ledger has today's changes (PRs #57/#59,
  re-scopes, unblocks) while local `main` is 20 commits behind origin. Reconcile
  export-first (`qd sync` is destructive) on a clean base _before_ cancelling ~320 nodes or
  minting the spine, to avoid ledger corruption.
- The 12 spine nodes currently live only in `/tmp/core-audit/*.json`; they must be minted into
  the ledger with **real structured edges** (dependencies above), not prose.
