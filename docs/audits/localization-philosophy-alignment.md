# Localization philosophy alignment audit

**Snapshot.** Static audit of commit `4a2ae090c4bcdf3deabca568a34be8f3f34410c3`.

**Method.** I traced the actual TypeScript control paths from structured translation through the agentic loop, QA, repair, project-driven export, reviewer queue/API/UI, failure handling, and context persistence. I also inspected the relevant database schema/repositories and the whole-project CLI behavior. This is a raise-the-issues audit, not a runtime test or a proposed implementation.

**Caveats.** The findings below are code-path conclusions, not observations from a live provider or a populated production database. Where an external worker, a custom evidence loader, or provider-side fallback could change behavior, that is called out as **unknown / needs deeper trace** rather than assumed absent.

## Severity rubric

- **P0:** a primary user workflow is blocked or cannot produce/action a review decision.
- **P1:** the primary workflow materially contradicts the philosophy, but has a guard, alternate path, or manual workaround.
- **P2:** a material data-model, diagnostic, or enablement gap that impairs the workflow without proving an immediate primary-path block.
- **P3:** a localized or lower-confidence issue.

## The eight principles (verbatim)

1. **Always-draft — the drafter NEVER withholds.** Every in-scope unit gets a best-effort translation,
   no matter how hard/low-confidence. A withheld/blank/deferred initial translation is a DESIGN BUG.
   Uncertainty is a signal that flows FORWARD (to QA + human review), never a stop.

2. **QA annotates, doesn't gate.** QA operates on the near-final DRAFT and MAY fail-closed by flagging
   an EXISTING draft for human confirmation ("maybe fine, mark this"). Distinguish: annotate-an-existing-draft
   (OK) vs cause/allow the initial translation to be withheld (BUG).

3. **Reviewer queue = genuine blockers + QA/patch review ONLY** — never a per-line "this is hard → human
   do it" dumping ground. A genuine blocker = pipeline truly cannot produce ANY output / would corrupt the
   patch (real structural/decode failure), not a hard sentence.

4. **Completeness > partial-perfection.** Always ship a COMPLETE best-effort patch (every line drafted);
   quality comes from ITERATION (QA cycles + human feedback + re-runs), not withholding. A bad-but-complete
   patch beats a good-but-incomplete one. Partial/preview patches are supported (--allow-partial-patch).

5. **Non-source-speaker enablement (north star).** itotori must let a person who does NOT speak the SOURCE
   language localize into a language they DO know. So human-facing surfaces (QA confirmations, patch review)
   must be judgeable in the TARGET language ALONE; QA carries the source-fidelity burden (it has source +
   structure + enrichment).

6. **Transparent patch review + persisted provenance.** Review is comprehension, not blind sign-off: the
   surface shows the full provenance per unit (draft + QA findings + agent reasoning/back-and-forth +
   enrichment context + confidence + alternates + debate) so a target-only reviewer can "get it," see
   disagreement, dig in, weigh in. DATA-MODEL requirement: this provenance must be PERSISTED per unit,
   not discarded after drafting.

7. **0% mechanical error; failures are bugs, routed by class.** Transient (429/timeout/no-content) →
   bounded retry w/ backoff; schema-recoverable → coerce + one corrective re-ask; true-bug (out-of-bounds
   span, unknown citation) → fail loud with a structured, actionable diagnostic. A structured failure record
   must be emitted on EVERY path, including abort (no silent aborts without a run-summary).

8. **Enrichment = persistent central brain / flywheel.** Enrichment (speaker/scene/character/terminology/
   route) persisted + reused across units/versions/review; QA references it; reviewer edits should write BACK
   to it so fixes propagate root-cause.

## Findings

### 1. Always-draft — the drafter never withholds

#### Follows

- The translation prompt directs the model to produce a target-language `draftText`, `agentRationale`, and `confidenceFloor` for every source bridge unit supplied to it. `apps/itotori/src/agents/translation/prompt-template.ts:29-42`
- In the primary loop, translation runs before deterministic checks and QA; the primary draft is selected before the QA stages begin. `apps/itotori/src/orchestrator/agentic-loop.ts:510-545`

#### Violates

- **Severity: P1 — QA/repair can turn an existing primary draft into no final draft.** A critical finding without a repairable cause, or a zero repair budget, sets `finalDraftText` to `undefined`; exhausted/rejected re-QA does the same, and the final bundle then retains only a deferral reason. `apps/itotori/src/orchestrator/agentic-loop.ts:672-700` `apps/itotori/src/orchestrator/agentic-loop.ts:823-867` The driven executor accepts only a defined final draft and synthesizes every deferred unit as source-equals-target rather than a best-effort target translation. `apps/itotori/src/orchestrator/project-driven-executor.ts:890-910` `apps/itotori/src/orchestrator/project-driven-executor.ts:1221-1264`

- **Severity: P2 — the structured-output contract permits an omitted or blank draft instead of enforcing an always-draft invariant.** The response schema defines `drafts` as an array without a minimum item count and accepts `draftText` as a string without a minimum length; the validator explicitly permits an empty draft string. `packages/localization-bridge-schema/src/translation-draft.ts:78-130` `packages/localization-bridge-schema/src/translation-draft.ts:240-249` The translation agent checks that returned draft IDs are known, not that every requested unit was returned; the loop later throws if it cannot find the requested unit. `apps/itotori/src/agents/translation/agent.ts:244-254` `apps/itotori/src/orchestrator/agentic-loop.ts:1702-1710`

#### Gaps / needs deeper trace

- I did not run a live model response, so the frequency of empty arrays or blank strings is **unknown / needs deeper trace**. The verified issue is that the contract and downstream behavior allow the omission to reach a later invariant failure instead of preventing it at the draft boundary. `packages/localization-bridge-schema/src/translation-draft.ts:78-130` `apps/itotori/src/orchestrator/agentic-loop.ts:1702-1710`

- The default whole-project patch application refuses partial coverage unless explicitly allowed, which limits release exposure; whether all alternate callers enforce that guard is **unknown / needs deeper trace**. `apps/itotori/src/orchestrator/localize-fullproject-cli.ts:127-169`

### 2. QA annotates, does not gate

#### Follows

- QA is explicitly given both source text and the existing draft, is asked to emit findings rather than rewritten output, and includes an agent rationale for each finding. `apps/itotori/src/agents/qa/prompt-template.ts:22-40` `apps/itotori/src/agents/qa/prompt-template.ts:74-89` The loop invokes the four focused QA stages only after obtaining the primary draft. `apps/itotori/src/orchestrator/agentic-loop.ts:541-660`

- When a queue sink is configured, the loop bridges a deferred outcome with `finalDraftText ?? primaryDraftText`; that preserves the rejected/flagged primary wording in the queue decision record alongside findings and repair history. `apps/itotori/src/orchestrator/agentic-loop.ts:843-887` `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:208-288`

- A separate generic patch-export preflight treats its QA score threshold as a warning rather than a blocking check. `apps/itotori/src/patch-export/preflight.ts:184-241`

#### Violates

- **Severity: P1 — the primary loop composes QA as an acceptance gate.** The same QA and re-QA outcomes described above erase the final draft and produce a deferred result, even though a primary draft existed. That makes QA control whether the patch contains a translation rather than merely attaching an annotation. `apps/itotori/src/orchestrator/agentic-loop.ts:672-700` `apps/itotori/src/orchestrator/agentic-loop.ts:823-867` `apps/itotori/src/orchestrator/project-driven-executor.ts:1221-1264`

- **Severity: P0 — the nominal human-confirmation route is not actionable for loop-created items.** The loop queue bridge emits metadata with source, decision ID, outcome, and affected units, but no `metadata.contextRefs`. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:339-363` Batch actions preflight and refuse any item missing typed source/draft/runtime/style/glossary/QA context references; the single-item API uses the same batch executor. `apps/itotori/src/reviewer/batch-execute.ts:239-248` `apps/itotori/src/reviewer/batch-execute.ts:307-354` `apps/itotori/src/reviewer/api-service.ts:317-336`

#### Gaps / needs deeper trace

- The queue bridge is optional: without a configured sink it returns without creating a human-review item. I did not trace every construction site, so how many non-test entry points omit the sink is **unknown / needs deeper trace**. `apps/itotori/src/orchestrator/agentic-loop.ts:896-925`

- The code proves the gate behavior for critical/unresolved findings, but it cannot classify every natural-language QA finding as a "hard sentence" without observing actual model outputs. That semantic distribution is **unknown / needs deeper trace**.

### 3. Reviewer queue = genuine blockers plus QA/patch review only

#### Follows

- A clean accepted loop outcome creates no queue item; otherwise the bridge queues a deferred outcome or a QA finding at the explicit `critical`/`major` severity floor, rather than queuing `minor` and `info` findings. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:54-78` `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:139-159`

- An accepted draft can coexist with a major QA finding and be represented as a `qa_finding_review`; the bridge builds decision options and carries the current draft rather than intentionally queuing an isolated source line. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:181-328`

#### Violates

- **Severity: P1 — ordinary content-quality findings can become human deferrals solely because of repair policy.** QA categorizes a mistranslation as `translator_mistake`, and the loop treats that class as repairable. `apps/itotori/src/triage/router.ts:142-157` `apps/itotori/src/orchestrator/agentic-loop.ts:2084-2104` A permitted zero-attempt setting immediately produces `deferred_to_human`, and every deferred result is eligible for automatic queue creation. `apps/itotori/src/orchestrator/agentic-loop.ts:692-700` `apps/itotori/src/orchestrator/localize-fullproject-command.ts:685-695` `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:139-159` This is a path from a translation-quality finding to human routing even though the pipeline already produced a draft.

- **Severity: P1 — content defects can be treated as P0 deferrals rather than draft-plus-review.** The deterministic short-circuit class includes `capitalization_drift` and `glossary_mistranslation`, and a P0 short circuit creates a final bundle with only `deferredReason`. `apps/itotori/src/orchestrator/agentic-loop.ts:566-620` `apps/itotori/src/orchestrator/agentic-loop.ts:2072-2078`

- **Severity: P0 — queue records produced by the primary loop are refused before a reviewer can decide.** This is the same verified producer/consumer contract mismatch: producer metadata lacks `contextRefs`, while the action executor requires them before mutation. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:339-363` `apps/itotori/src/reviewer/batch-execute.ts:307-354`

#### Gaps / needs deeper trace

- The routing code maps categories and severity but does not establish how often the queue becomes a per-line dumping ground in real corpora. That operational frequency is **unknown / needs deeper trace**. `apps/itotori/src/triage/router.ts:142-235`

- A real structural/decode failure can also enter the queue through the deferred outcome path, but I did not enumerate every engine-specific failure class. Exact blocker-only coverage is **unknown / needs deeper trace**. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:139-159`

### 4. Completeness over partial-perfection

#### Follows

- The whole-project CLI explicitly supports `--allow-partial-patch` for a preview patch and says undrafted units pass through byte-identical; absent the flag, partial coverage is refused. `apps/itotori/src/help-text.ts:28-39` `apps/itotori/src/orchestrator/localize-fullproject-cli.ts:127-169` The CLI handler parses and passes that option into the live full-project path. `apps/itotori/src/cli-handlers.ts:1062-1101`

- The pass ledger is designed to carry deferred outcomes/reasons into subsequent iteration, and the translation prompt can include prior-pass feedback in a later translation call. `apps/itotori/src/orchestrator/pass-ledger.ts:68-79` `apps/itotori/src/orchestrator/pass-ledger.ts:350-418` `apps/itotori/src/agents/translation/prompt-template.ts:255-283`

#### Violates

- **Severity: P1 — the generated bridge is incomplete whenever a unit is deferred, failed, out of scope, or never dispatched.** The executor collects only accepted bodies; a budget stop can leave slots undispatched, and synthesis deliberately writes source text as target text for every nonaccepted unit. `apps/itotori/src/orchestrator/project-driven-executor.ts:598-669` `apps/itotori/src/orchestrator/project-driven-executor.ts:702-747` `apps/itotori/src/orchestrator/project-driven-executor.ts:1221-1264` This is a byte-preserving partial artifact, not a complete best-effort patch.

- **Severity: P1 — the single-stage command substitutes a source-language fallback when no final draft survives.** It assigns `bundle.finalDraft.draftText ?? \`[en-US] ${unit.sourceText}\``before constructing its translated bridge.`apps/itotori/src/orchestrator/localize-project-stage-command.ts:443-459` Prefixing source text with a target-locale tag does not meet the requested best-effort target translation.

- **Severity: P2 — alternate patch-export surfaces are also acceptance-centric.** Generic preflight rejects terminal rejections or missing draft coverage, and the exporter skips terminal rejections/throws for missing successful drafts instead of treating an existing rejected draft as reviewable patch content. `apps/itotori/src/patch-export/preflight.ts:133-177` `apps/itotori/src/patch-export/exporter.ts:256-293`

#### Gaps / needs deeper trace

- The preview behavior intentionally preserves source bytes for safety, so it does satisfy the stated preview support clause. Whether users commonly run only this bounded-preview path, or whether a higher-level release workflow adds drafts before delivery, is **unknown / needs deeper trace**. `apps/itotori/src/help-text.ts:28-39` `apps/itotori/src/orchestrator/localize-fullproject-cli.ts:127-169`

### 5. Non-source-speaker enablement

#### Follows

- QA carries the source-side comparison burden in its prompt: it sees source text, target draft, glossary, and style guide, rather than asking a reviewer to generate source fidelity evidence. `apps/itotori/src/agents/qa/prompt-template.ts:22-40` `apps/itotori/src/agents/qa/prompt-template.ts:74-89`

- When detail evidence is present, the patch-history panel labels both the draft and approved patch text with the target locale, and the correction UI separately renders Draft and Final using `targetLocale`. `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:729-740` `apps/itotori/src/workspace/correction-view.ts:105-115` `apps/itotori/src/workspace/correction-view.ts:142-149`

#### Violates

- **Severity: P0 — the live DB wiring uses a default reviewer evidence loader that supplies no source, draft, policy, or QA finding.** The service is created without an evidence loader and therefore selects its default. `apps/itotori/src/services/database-services.ts:712-721` `apps/itotori/src/reviewer/api-service.ts:190-193` That default explicitly returns `source: null`, `draft: null`, `policy: null`, and an empty QA array; it only derives a structure feed from the payload. `apps/itotori/src/reviewer/api-service.ts:451-486` The detail route and UI consequently show missing-draft diagnostics, no usable source-vs-draft comparison, and no QA findings. `apps/itotori/src/reviewer/detail-route.ts:259-309` `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:652-686` `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:888-924` A reviewer cannot judge the target language alone because the primary target text is absent.

- **Severity: P1 — the default review layout is source-dependent rather than providing a verified target-only mode.** Its ready view renders Source, Draft, and source-vs-draft comparison panels; the comparison requires both values, and the scene player receives both source and draft. `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:173-230` `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:670-687` `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:234-332` This does not prove a reviewer must read the source, but no target-only decision surface was found on the inspected primary route.

#### Gaps / needs deeper trace

- A custom rich evidence loader could make the otherwise target-language-capable views usable; whether production injects one outside the DB service inspected here is **unknown / needs deeper trace**. `apps/itotori/src/reviewer/api-service.ts:190-193` `apps/itotori/src/services/database-services.ts:712-721`

- QA finding summaries are untagged strings and omit the full rationale/target-locale metadata in the detail fixture shape, so whether a non-source speaker receives target-language explanations is **unknown / needs deeper trace**. `apps/itotori/src/reviewer/detail-fixtures.ts:119-129`

### 6. Transparent patch review and persisted provenance

#### Follows

- The reviewer-queue database model persists payload and metadata and records append-only transitions with diagnostics/metadata. `packages/itotori-db/migrations/0043_reviewer_queue_items.sql:39-61` `packages/itotori-db/migrations/0043_reviewer_queue_items.sql:100-124`

- The loop’s queue decision record is comparatively rich: it includes source identity/text/spans, current/rejected draft text, context/citation references, serialized injected structure context, QA findings with `agentRationale`, deterministic violations, and repair history. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:208-288` The structure-context feed serializes injected scene/route/character text and the detail UI renders those feed entries. `apps/itotori/src/reviewer/structure-context-feed.ts:185-198` `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:933-1006`

- The pass ledger preserves per-unit final draft/defer reason and consumed feedback in its record body, providing a limited form of iteration provenance. `apps/itotori/src/orchestrator/pass-ledger.ts:68-79` `apps/itotori/src/orchestrator/pass-ledger.ts:410-450` `packages/itotori-db/migrations/0058_localization_pass_ledger.sql:39-43`

#### Violates

- **Severity: P0 — the persisted loop decision cannot be acted on by the review surface.** The queue bridge persists decision-record content in `payload`, but emits no `metadata.contextRefs`; action preflight refuses such records before mutation, including on the single-item API path invoked by review controls. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:339-363` `apps/itotori/src/reviewer/batch-execute.ts:239-248` `apps/itotori/src/reviewer/batch-execute.ts:307-354` `apps/itotori/src/reviewer/api-service.ts:317-336` `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:472-508`

- **Severity: P1 — the canonical drafted provenance is discarded by the driven persistence path.** The structured draft contains citation references, agent rationale, and confidence floor. `packages/localization-bridge-schema/src/translation-draft.ts:54-63` The driven record retains only final text/defer reason, while the DB sink merely creates a draft job/attempt and marks it succeeded or failed. `apps/itotori/src/orchestrator/project-driven-executor.ts:890-910` `apps/itotori/src/orchestrator/project-driven-executor-sinks.ts:64-95` The draft-job record shapes and provider ledger do not retain a full prompt/response transcript, and the patch report retains accepted final bodies rather than per-unit debate/provenance. `packages/itotori-db/src/repositories/draft-job-repository.ts:48-92` `packages/itotori-db/migrations/0035_draft_attempt_provider_ledger.sql:3-9` `apps/itotori/src/orchestrator/project-driven-executor.ts:242-269` `apps/itotori/src/orchestrator/project-driven-executor-sinks.ts:131-153`

- **Severity: P1 — data that is in the queue payload is not surfaced through the live detail loader.** The bridge stores QA `agentRationale`, but the default evidence loader returns no QA findings, and the panel renders only the typed summary rows it is given. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:259-273` `apps/itotori/src/reviewer/api-service.ts:475-485` `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:888-924`

- **Severity: P2 — the schema does not model alternates or debate as draft fields.** The strict structured-draft schema permits only the listed properties; it contains no alternate-candidate or conversation/debate field. `packages/localization-bridge-schema/src/translation-draft.ts:78-130` `packages/localization-bridge-schema/src/translation-draft.ts:209-225`

#### Gaps / needs deeper trace

- Queue transition diagnostics and arbitrary metadata are persisted, but the inspected detail route/history projects only action/state/actor/time. Whether another UI offers full diagnostic drill-down is **unknown / needs deeper trace**. `packages/itotori-db/src/schema.ts:4599-4624` `apps/itotori/src/reviewer/detail-fixtures.ts:168-175` `apps/itotori/src/reviewer/detail-route.ts:334-341` `apps/itotori/src/ui/screens/ReviewerDetailScreen.tsx:1028-1045`

- I did not find a persistence/read path for complete provider conversation artifacts outside the inspected draft job, provider ledger, pass ledger, queue, and detail UI. Retention in an external provider or uninspected service is **unknown / needs deeper trace**.

### 7. Zero mechanical error; failures routed by class

#### Follows

- Provider adapters classify network/HTTP failures, persist failed provider-run artifacts, and label HTTP 429/5xx as retryable. `apps/itotori/src/providers/openrouter.ts:163-256` `apps/itotori/src/providers/local-openai-compatible.ts:65-127`

- The translation agent rejects no-content output and validates unknown citations and protected-span bounds with typed errors. `apps/itotori/src/agents/translation/agent.ts:131-160` `apps/itotori/src/agents/translation/agent.ts:278-294` `apps/itotori/src/agents/translation/agent.ts:332-346`

- In the driven executor, thrown unit errors are converted into structured pipeline diagnostics and isolated so a completed pass can persist `unitFailures`. `apps/itotori/src/orchestrator/pipeline-failure-diagnostic.ts:544-588` `apps/itotori/src/orchestrator/project-driven-executor.ts:922-953` `apps/itotori/src/orchestrator/pass-ledger.ts:420-450` `packages/itotori-db/src/schema.ts:4789-4838`

- There is a bounded local JSON salvage/reparse step before strict validation. `apps/itotori/src/localization/patchback-safety.ts:421-521`

#### Violates

- **Severity: P1 — the live path lacks an application-level bounded retry/backoff policy for 429, timeout, or no-content results.** The live stage command states that it has no app-level 429 chaining/retry and surfaces a terminal provider error after OpenRouter fallback is exhausted. `apps/itotori/src/orchestrator/localize-project-stage-command.ts:16-37` `apps/itotori/src/orchestrator/localize-project-stage-command.ts:412-420` The primary loop directly awaits translation, while no-content throws a partial-result error; the provider token bucket waits before requests but does not retry a failed response. `apps/itotori/src/orchestrator/agentic-loop.ts:1575-1606` `apps/itotori/src/agents/translation/agent.ts:131-153` `apps/itotori/src/providers/openrouter.ts:1932-1968` `apps/itotori/src/providers/openrouter.ts:2098-2121`

- **Severity: P1 — true enrichment errors can be silently converted to best-effort drops.** The terminology agent throws for an unknown citation, but the loop catches every enrichment error, records a free-text dropped-enrichment reason, and proceeds. `apps/itotori/src/agents/terminology-candidate/agent.ts:156-175` `apps/itotori/src/orchestrator/agentic-loop.ts:1072-1110` `apps/itotori/src/orchestrator/agentic-loop.ts:1163-1167` This conflicts with fail-loud routing for a mechanical citation error.

- **Severity: P2 — caught per-unit diagnostics are not class/stage-precise.** The diagnostic builder hard-codes `code: "unknown"` and `step: "executor.drive-unit"`, while the executor labels any caught error as the translation-primary stage even if it originated in context, speaker, QA, or repair work. `apps/itotori/src/orchestrator/pipeline-failure-diagnostic.ts:636-683` `apps/itotori/src/orchestrator/project-driven-executor.ts:934-952`

- **Severity: P2 — an abort does not guarantee a run summary.** The full-project command awaits the run-pass wrapper before it constructs/writes the run summary; a thrown run-pass error can bypass the later summary-writing code. `apps/itotori/src/orchestrator/localize-fullproject-command.ts:400-438` `apps/itotori/src/orchestrator/localize-fullproject-command.ts:440-479`

#### Gaps / needs deeper trace

- A separate `RetryPolicy` contains bounded classifications for timeout, rate-limit, and schema cases, and the draft acceptance gate can persist its classification. I did not find it wired into the primary direct-loop call, so end-to-end use is **unknown / needs deeper trace**. `apps/itotori/src/draft/retry-policy.ts:104-239` `apps/itotori/src/draft/acceptance-gate.ts:128-154` `apps/itotori/src/orchestrator/agentic-loop.ts:1575-1606`

- The existing schema recovery is local coercion/reparse, not a verified corrective model re-ask. A retry-policy re-emission concept exists, but its scheduler integration is **unknown / needs deeper trace**. `apps/itotori/src/localization/patchback-safety.ts:505-521` `apps/itotori/src/draft/retry-policy.ts:143-161`

### 8. Enrichment as a persistent central brain / flywheel

#### Follows

- The database has a central context-artifact model with scene, character, route, speaker, and terminology categories; it persists revision/content/producer/provenance/source-unit citations, and its repository supports upsert, invalidation, and retrieval. `packages/itotori-db/src/schema.ts:556-575` `packages/itotori-db/src/schema.ts:1956-2037` `packages/itotori-db/src/repositories/context-artifact-repository.ts:170-183` `packages/itotori-db/src/repositories/context-artifact-repository.ts:407-495`

- Standalone semantic-agent CLIs persist scene summaries, character relationships, terminology candidates, and route maps; scene summaries also have citation-hash staleness detection. `apps/itotori/src/agents/scene-summary/cli.ts:193-201` `apps/itotori/src/agents/character-relationship/cli.ts:181-209` `apps/itotori/src/agents/terminology-candidate/cli.ts:135-149` `apps/itotori/src/agents/route-choice-map/cli.ts:162-187` `apps/itotori/src/agents/scene-summary/staleness.ts:30-90`

- Decoded scene/route/character context is injected into translation when supplied, and the translation prompt renders the actual supplied scene, route, and arc text. `apps/itotori/src/orchestrator/agentic-loop.ts:1144-1161` `apps/itotori/src/agents/translation/prompt-template.ts:89-110`

- A workspace correction can write back translation memory, optionally upsert a glossary term, and schedule affected units for rerun; the DB service wires that feedback loop. `apps/itotori/src/workspace/correction-feedback-loop.ts:118-231` `apps/itotori/src/services/database-services.ts:753-782`

#### Violates

- **Severity: P1 — the primary loop generates semantic enrichment but retains only synthetic references, not reusable content.** Scene, character, terminology, and route outputs become identifier-like refs, and the returned context contains only those refs; the translation prompt lists them rather than resolving semantic content from a persistent store. `apps/itotori/src/orchestrator/agentic-loop.ts:1172-1315` `apps/itotori/src/agents/translation/prompt-template.ts:79-87` The driven path therefore does not demonstrate persistence or cross-unit/version reuse of the enrichment it just generated.

- **Severity: P1 — speaker-label output is not consumed as translation context in the primary loop.** The speaker agent returns labels, but the loop uses its result only for telemetry and the translation projection omits a speaker field. `apps/itotori/src/agents/speaker-label/agent.ts:160-175` `apps/itotori/src/orchestrator/agentic-loop.ts:499-507` `apps/itotori/src/orchestrator/agentic-loop.ts:1564-1572`

- **Severity: P1 — QA is not given the scene/character/route/speaker enrichment it is expected to reference.** The QA input is limited to units, glossary, and style guide, and the loop constructs exactly those values, despite the QA prompt allowing context-artifact evidence references. `apps/itotori/src/agents/qa/shapes.ts:74-87` `apps/itotori/src/orchestrator/agentic-loop.ts:1760-1781` `apps/itotori/src/agents/qa/prompt-template.ts:27-39`

- **Severity: P2 — a reviewer-queue glossary action does not itself perform a glossary writeback.** Its type comment assigns the actual glossary write to a downstream worker, while the service records/enqueues the action. `apps/itotori/src/reviewer/action-service.ts:137-146` `apps/itotori/src/reviewer/action-service.ts:238-250` `apps/itotori/src/reviewer/action-service.ts:312-321`

#### Gaps / needs deeper trace

- The central repository is capable of the desired flywheel, but the inspected primary-loop input exposes only a terminology-candidate repository for conflict checking and no general context-artifact persistence sink. A separate worker may connect these paths; that integration is **unknown / needs deeper trace**. `apps/itotori/src/orchestrator/agentic-loop.ts:338-348` `apps/itotori/src/orchestrator/agentic-loop.ts:1172-1315`

- The reviewer decision record persists decoded `structuredContext` text when it was supplied, but remaining semantic refs render as generic ID-derived descriptions rather than resolved stored artifacts. Whether another review surface resolves them is **unknown / needs deeper trace**. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:245-257` `apps/itotori/src/reviewer/structure-context-feed.ts:283-312`

## Tracking issues (raised, not fixed)

The two P0 gaps below have tracking issues filed for orchestrator triage:

- P0 #1 → [itotori#86](https://github.com/cat-cave/itotori/issues/86) (reviewer-queue records omit `metadata.contextRefs`)
- P0 #2 → [itotori#87](https://github.com/cat-cave/itotori/issues/87) (default reviewer evidence loader returns no draft/source/policy/QA)

## Summary ranking of the biggest gaps

1. **Principles 2, 3, 5, and 6 — P0** ([itotori#86](https://github.com/cat-cave/itotori/issues/86))**:** Loop-created reviewer-queue records omit the `metadata.contextRefs` required by every action path, so the intended human confirmation/review route is refused before a decision can be applied. `apps/itotori/src/orchestrator/reviewer-queue-bridge.ts:339-363` `apps/itotori/src/reviewer/batch-execute.ts:307-354`

2. **Principles 5 and 6 — P0** ([itotori#87](https://github.com/cat-cave/itotori/issues/87))**:** The default production reviewer evidence loader returns no draft, source, policy, or QA findings, leaving the human-facing review screen without target text to judge or the QA evidence to understand it. `apps/itotori/src/services/database-services.ts:712-721` `apps/itotori/src/reviewer/api-service.ts:451-486`

3. **Principles 1, 2, and 4 — P1:** QA/repair can erase a real primary draft, and the project exporter turns deferred/failed work into source-text no-ops rather than a complete best-effort translation patch. `apps/itotori/src/orchestrator/agentic-loop.ts:672-700` `apps/itotori/src/orchestrator/agentic-loop.ts:823-867` `apps/itotori/src/orchestrator/project-driven-executor.ts:1221-1264`

4. **Principle 7 — P1:** The live path explicitly lacks application-level bounded retry/backoff and can swallow mechanical enrichment failures into a free-text drop. `apps/itotori/src/orchestrator/localize-project-stage-command.ts:412-420` `apps/itotori/src/orchestrator/agentic-loop.ts:1072-1110`

5. **Principle 6 — P1:** The data model emits rationale/confidence/citations at drafting but the driven persistence path preserves only final text/defer status, not the required complete per-unit provenance, alternatives, or debate. `packages/localization-bridge-schema/src/translation-draft.ts:54-63` `apps/itotori/src/orchestrator/project-driven-executor-sinks.ts:64-95`

6. **Principle 8 — P1:** The primary loop produces semantic enrichment but reduces it to synthetic refs, does not feed that enrichment to QA, and does not demonstrate persistent cross-unit reuse. `apps/itotori/src/orchestrator/agentic-loop.ts:1172-1315` `apps/itotori/src/orchestrator/agentic-loop.ts:1760-1781`

7. **Principle 3 — P1:** Content-quality findings such as mistranslation can become a human deferral after a bounded repair policy, rather than remaining a draft plus annotation or being reserved for a true structural blocker. `apps/itotori/src/triage/router.ts:142-157` `apps/itotori/src/orchestrator/agentic-loop.ts:692-700`
