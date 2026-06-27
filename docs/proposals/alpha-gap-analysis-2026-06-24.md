# Alpha Gap Analysis — 2026-06-24

> Companion to `docs/proposals/dag-retier-2026-06-24.md` (DAG re-tier sweep).
> That doc proposes how today's DAG should be re-tiered under the redefined
> alpha. This doc identifies the concrete work that the new alpha needs and
> that does NOT yet exist as DAG nodes — gap analysis, not re-tier.
>
> **The redefined alpha (2026-06-24, second redefinition).** The morning's
> `current-state-2026-06-24.md` redefinition (architecture-proven dogfood)
> sized alpha by what already-landed work _already covered_. The afternoon's
> stricter framing — captured in the user brief that produced this doc —
> raises the bar to **Oshioki Sweetie HD localizable end-to-end on Linux
> with a live LLM call via OpenRouter and the full agentic loop firing**.
> That is the gate this doc analyses gaps against. Treat the
> dashboard/repo-hygiene gates from the morning redefinition as still in
> force; they are mature work, not gap drivers.

The six concrete requirements under the stricter alpha:

1. **Real-bytes extraction** — kaifuu reads real Sweetie HD scene bytecode
   and produces v0.2 bridge units. Not author fixtures, not synthetic
   envelopes.
2. **Live LLM call via OpenRouter with an explicit (model, provider) pair.**
   Per `feedback_model_provider_pair.md`. The dev-tier pair is something
   cheap and capable (e.g. `deepseek/deepseek-chat-v4` on a specific
   provider id — Fireworks, DeepInfra, Hyperbolic — chosen and named in
   code, not in a comment).
3. **The full agentic loop fires** — context building, pre-translation,
   translation, QA, deterministic checks, edit/review cycles. Minimally
   functional, not necessarily high-quality.
4. **Real patchback** — kaifuu writes patched Seen.txt back to a writable
   copy of the game. The patch CLI already works on synthetic envelopes;
   it has to fire on real bytes via the real opcode dispatch path.
5. **`utsushi-reallive` runtime runs the patched game on Linux** — the
   native Rust runtime executes at least the patched scenes. No Wine, no
   Windows binary. UTSUSHI-201..221 (minus the cancelled UTSUSHI-219)
   substantially land.
6. **Verifiable patch landed** — programmatic evidence that the en-US
   strings render at the engine's text surface, traced through the
   substrate `TextSurfaceSink` and at least one frame artifact.

Alpha-ready = "the building blocks all fire and pieces can be swapped" —
not "the output is good."

---

## 1. Method

For each of the six requirements I cross-checked: (a) DAG nodes at HEAD
(`roadmap/spec-dag.json`) — ids called out are ITOTORI-019/020/021/
074-078/100/116, KAIFUU-188/189/190/191, UTSUSHI-200..224 (minus -219
cancelled); (b) code at HEAD — `apps/itotori/src/providers/{types,
openrouter}.ts` (model-provider seam), `apps/itotori/src/agents/*` (the
seven agent surfaces), `crates/kaifuu-cli/src/main.rs` (patch),
`crates/kaifuu-reallive/src/{archive,parser,patchback,gameexe}.rs`,
`crates/utsushi-reallive/` (scaffold-only); (c) reference docs —
`current-state-2026-06-24.md`, `alpha-localization-project-readiness.md`,
`research/reallive-engine{,-dag-proposal}.md`,
`research/reallive-sweetie-hd-encryption-mechanism.md` (XOR-2 outcome A
= no second-level XOR, which is why UTSUSHI-219 was cancelled),
`audits/real-bytes-validation-2026-06-24.md`.

For each requirement I asked: what landed makes the contract work? what
is planned in the DAG? what is neither — the gap. A gap qualifies as a
new node only if it satisfies the standing rules: no
investigation-shaped scoping, acceptance criteria name observable
artifacts, engine claims validate across ≥2 corpora where relevant,
same-change legacy-surface deletion, model invocations carry explicit
`(modelId, providerId)` pairs.

---

## 2. Per-requirement gap analysis

### Requirement 1 — Real-bytes extraction producing v0.2 bridge units

**What exists today (landed).**

- `KAIFUU-188` parses the real 10,000-slot Seen.txt envelope. On
  Sweetie HD it returns 198 entries with the first scene at offset
  0x13880 (`crates/kaifuu-reallive/src/archive.rs`). The detector probe
  `reallive_seen_txt_envelope_ok` accepts the real shape; `kaifuu-cli
detect` reports `detected=true` on a Sweetie HD game root.
- `KAIFUU-189` resolves the nested `REALLIVEDATA/` data dir (depth-N
  detector). Sweetie HD's nested-data layout is discovered without the
  caller hardcoding the subdir.
- `KAIFUU-190` classifies 100% of Sweetie HD's `Gameexe.ini` lines
  against the documented RLDEV surface (down from 1.3%). Emits
  `BridgeUnit` entries for the translatable `#NAMAE` / `#REGNAME` /
  `#CAPTION` family.

**What does NOT exist.** A bridge between scene bytecode and v0.2
bridge units. `KAIFUU-191` (planned, continuous) replaces the synthetic
`0x23 ('#')` opener in `kaifuu-reallive/src/parser.rs` with real opcode
dispatch and a length-prefixed Shift-JIS text decoder — but its output
is typed `Instruction` values, not bridge units. Nothing walks a
parsed scene's instructions, identifies text-display opcodes, extracts
the ja-JP body, captures protected-span ranges for the surrounding
control bytes (kidoku, choice markers, name tokens, `koe`/`koePlay`
voice-line refs, `#NAMAE` character refs), and emits a v0.2-conformant
`localization-bridge-schema` bundle.

**What's missing — concretely.** A node that walks
`Vec<Instruction>` from `KAIFUU-191` + `Gameexe` from `KAIFUU-190` and
produces `BridgeBundleV02`. Bundle must carry source-locale
(`ja-JP-shift-jis`), per-unit protected-span ranges, voice-line refs
(`koe` archive id + sample id), character refs (the `NAMAE` row id, not
free-text speaker name), and source-byte provenance per unit
(`scene_id`, `byte_range`) so patchback can locate the slot. If v0.2's
existing protected-span vocabulary lacks the RealLive kinds (kidoku,
name-token, choice-marker, asset-ref `#FACE`/`#GANBMP`, font-tone),
the producer node adds them in the same change.

**Specific verification artifact.** `kaifuu-cli extract --engine
reallive --scene 1 <Sweetie HD path>` writes a `bridge-bundle.json`
with `schemaVersion: "localization-bridge-schema/v0.2"`, at least one
translatable `BridgeUnit` whose `sourceText` is non-empty Shift-JIS
text, at least one protected span of kind `reallive.kidoku`, and
provenance `(scene_id=1, byte_offset=0x13880, byte_len=...)`.

(The `(model, provider)` rule does NOT apply to this requirement —
extraction is deterministic, no LLM.)

### Requirement 2 — Live LLM call via OpenRouter with explicit (model, provider) pair

**What exists today (landed).**

- `apps/itotori/src/providers/openrouter.ts` implements an OpenRouter
  HTTP client. It reads `OPENROUTER_API_KEY` from `process.env` (line
  283 of `openrouter.ts`), normalises a response into a
  `ProviderRunRecord` carrying `actualModelId` and an OBSERVED
  `upstreamProvider` (line 549 onward).
- The `ProviderRunIdentity` type records `upstreamProvider?: string` —
  but it is OPTIONAL and it is OBSERVED post-response, NOT pinned at
  request time.
- `ITOTORI-019` (drafting fixture), `ITOTORI-021` (4 QA agents +
  scored findings), `ITOTORI-076` (protected-span validator + retry
  policy), `ITOTORI-077` (cost + provenance ledger keyed by `model_id`,
  `provider_family`, `route_settings_hash`).

**What does NOT exist.** `ModelInvocationRequest`
(`providers/types.ts:187`) carries `modelId?: string` (optional) and no
`providerId` field — no input-time mechanism to say "route to
`deepseek/deepseek-chat-v4` ON Fireworks and fail otherwise." The
OpenRouter `provider: { only: [...] }` request-body block is not used.
The recorded-bundle key includes model id + prompt hash but not
provider id, so a bundle recorded on one provider replays as if it
represented any. The cost ledger has `model_id` + `provider_family`
enum but no upstream `provider_id` (Fireworks vs DeepInfra vs ...).
All seven agent surfaces (`translation/`, `qa/`, `speaker-label/`,
`scene-summary/`, `character-relationship/`, `terminology-candidate/`,
`route-choice-map/` under `apps/itotori/src/agents/`) pass `modelId`
without `providerId`.

**Specific (model, provider) pair work needed.** Add `providerId:
string` REQUIRED to `ModelInvocationRequest`; delete the
`modelId?`-optional surface; propagate through every caller. Make the
OpenRouter client emit `provider: { only: [providerId] }` and verify
post-response that `upstreamProvider === providerId` (mismatch →
`ModelProviderError` with new `pair_mismatch` code). Re-key recorded
bundles by `(modelId, providerId, promptHash, inputClassification)`;
old key shape deleted same change per no-legacy-compat. Migrate the
ledger to add `provider_id NOT NULL`; backfill from recorded upstream
provider.

**Specific verification artifact.** `pnpm exec vp run
itotori:provider-pair-smoke --modelId deepseek/deepseek-chat-v4
--providerId fireworks` returns a `ProviderRunRecord` whose
`requestedModelId === "deepseek/deepseek-chat-v4"`,
`upstreamProvider === "fireworks"` AND the same record is rejected
when the response comes back with a different provider name.

### Requirement 3 — Full agentic loop fires

**What exists today (landed).**

- `ITOTORI-019` ships the drafting fixture command
  (`pnpm exec vp run itotori:draft-fixture` / `just hello-draft`) with
  recorded providers. It exercises translation invocation +
  protected-span validation + retry + cost ledger.
- `ITOTORI-020` ships the deterministic QA suite (protected spans,
  empty translations, charset, length, punctuation, glossary).
- `ITOTORI-021` ships four LLM QA agents (style adherence, semantic
  drift, tone/register, unresolved terminology) with scored findings,
  fresh-judge regrade, and 28 recorded bundles. Implements roughly the
  "translation + QA" halves of a workflow.
- `ITOTORI-076` ships the protected-span validator and retry policy.
- `ITOTORI-077` ships the draft attempt provider ledger.
- `ITOTORI-078` ships structured QA invocation + parser.
- Agents in `apps/itotori/src/agents/`: translation, qa, speaker-label,
  scene-summary, character-relationship, terminology-candidate,
  route-choice-map. The scene-summary / character-relationship /
  route-choice-map / terminology-candidate agents are _context-building_
  agents — they exist as code but are not wired into an end-to-end
  pre-translation pass.

**What does NOT exist.** No orchestrator ties these together for a
single bridge unit; ITOTORI-019 invokes translation in isolation, the
QA agents run against fixture drafts, and the four context-building
agents run as standalone CLIs. No node specifies the pre-translation
pass (scene context, speaker labels, terminology candidates) feeding
the translation agent. No node specifies an edit/review cycle (QA
finding above threshold dispatches a repair invocation, re-runs QA,
accept-or-defer); ITOTORI-022 (planned, alpha) routes findings to
root cause but does not wire repair. No node pipes drafts through
the full deterministic suite (ITOTORI-020) between translation and
LLM-QA — the protected-span validator (ITOTORI-076) runs at draft
acceptance but the broader suite has no caller.

**What's missing — concretely.** Orchestrator
`runAgenticLoopForUnit(unit, pairPolicy, policy)` chaining context,
pre-translation, translation, deterministic checks, LLM-QA, router,
bounded repair, final draft. Every LLM call declares
`(modelId, providerId)`; every stage's invocation lands in the
draft-attempt ledger. All stage outputs reach one durable artifact
`agentic-loop-bundle.v0.json` (new schema).

**Specific (model, provider) pair work needed.** Gated on requirement
#2; the orchestrator passes distinct pairs per stage (e.g. translation
`deepseek/deepseek-chat-v4 @ fireworks`, QA
`anthropic/claude-haiku-4 @ anthropic-direct`) chosen in code, not
defaulted.

**Specific verification artifact.** `pnpm exec vp run
itotori:agentic-loop-smoke --bundle <bridge-bundle.json> --unit-index 0`
writes `agentic-loop-bundle.v0.json` containing at minimum: 1
context-build record, 1 pre-translation record, 1 translation record,
N≥4 deterministic-check records (one per check), 4 LLM-QA records (one
per agent), 1 router record, ≤K≤3 repair records when QA findings
above threshold exist, 1 final-draft record. Every model invocation
carries an explicit `(modelId, providerId)` pair in its
`ProviderRunRecord`.

### Requirement 4 — Real patchback to a writable copy of the game

**What exists today (landed).** `kaifuu-cli patch`
(`crates/kaifuu-cli/src/main.rs` lines 2958, 3083, 3184, 3274 —
multiple adapter surfaces) invokes
`kaifuu-reallive::patchback::apply_patches` (`lib.rs:163`) for
length-preserving slot edits on Seen.txt. KAIFUU-188 proved the real
envelope; patchback knows the 10,000-slot directory layout.

**What does NOT exist.** The patchback module operates on the
SYNTHETIC opcode shape (KAIFUU-191 not landed). `apply_patches` takes
`SlotEdit { scene_id, byte_offset, replacement }` but doesn't know how
to compute Shift-JIS bytes + control bytes from a translated
`BridgeUnit`; the text-display opcode has a length-prefix byte that
must be rewritten with the body. No node wires the translated v0.2
bundle into `apply_patches`. No node specifies the writable-copy
discipline (the `/scratch/itotori-research/sweetie-hd/` mount is
read-only per `itotori-vault-source-adapter.md`; the patch path needs a
copy-to-writable-scratch step).

**What's missing — concretely.** A new node (KAIFUU-NEW-Apatch below)
that consumes the translated bundle, resolves each unit's
`(scene_id, byte_offset, byte_len)` provenance from requirement #1,
re-encodes `targetText` (UTF-8 if the runtime decode hook accepts it,
otherwise Shift-JIS — choice defended in code), rewrites the
length-prefixed opcode body, updates the 10,000-slot directory on
size change, validates via `reallive_seen_txt_envelope_ok`. Same node
adds the `--source-readonly --target <writable>` discipline to
`kaifuu-cli patch`.

**Specific verification artifact.** `kaifuu-cli patch --engine
reallive --source <readonly-sweetie> --target <writable-target>
--bridge bridge-bundle-translated.json` returns 0 AND the resulting
`Seen.txt` at `<writable-target>/REALLIVEDATA/Seen.txt` round-trips
through `parse_archive` to produce a `SceneIndex` whose en-US text
appears at the post-patch byte ranges; AND the original readonly mount
is unchanged (mtime + sha256).

### Requirement 5 — `utsushi-reallive` runtime runs the patched game on Linux

**What exists today (landed).** UTSUSHI-200 (crate skeleton with
every `EnginePortAdapter` lifecycle stage returning `Unimplemented`)
and UTSUSHI-222/223/224 (substrate M.1–M.3 — composite asset package,
snapshot envelope size class, `EnginePort` → substrate-sinks bridge
with the legacy `ObservationHookEvent` deleted).

**What does NOT exist.** UTSUSHI-201..218 are all `planned, continuous`.
UTSUSHI-219 (XOR-2 key resolution) is cancelled as research-shaped;
the encryption probe doc recorded outcome A — Sweetie HD
compiler-version-110002 has no second-level XOR — so UTSUSHI-203 can
ship with `xor_2_key = None` without needing UTSUSHI-219. UTSUSHI-220
(the e2e Sweetie HD scene-1 text-replay smoke — the alpha-defining
replay node) and UTSUSHI-221 (cross-engine substrate conformance +
Siglus lineage notes) are also `planned, continuous`.

**Specific runtime port work needed.** The alpha-blocking minimum
subset (mapped against `docs/research/reallive-engine-dag-proposal.md`):

| DAG id      | Why alpha-blocking                                                                 |
| ----------- | ---------------------------------------------------------------------------------- |
| UTSUSHI-201 | Real Seen.txt directory parser — gates everything else in the runtime.             |
| UTSUSHI-202 | Scene header — gates decompression.                                                |
| UTSUSHI-203 | LZ + XOR-1 (XOR-2 = None per outcome A) — gates bytecode.                          |
| UTSUSHI-204 | Bytecode element stream decoder — gates VM.                                        |
| UTSUSHI-205 | Expression evaluator — gates VM.                                                   |
| UTSUSHI-206 | Variable banks + store register — gates VM.                                        |
| UTSUSHI-207 | Gameexe parser — gates speaker resolution + system-call routes.                    |
| UTSUSHI-208 | Bytecode VM — gates everything that runs scene code.                               |
| UTSUSHI-209 | Text/messaging RLOp family — gates `TextLine` emission (the verification surface). |
| UTSUSHI-210 | Control flow — gates scene 1 actually progressing past first textout if needed.    |
| UTSUSHI-220 | E2E scene-1 text-replay smoke — the alpha gate itself.                             |

The remaining UTSUSHI sub-nodes can stay continuous IF the alpha
definition accepts "first textout on scene 1" as the demo: UTSUSHI-211
(choices — only if scene 1 has a `select`), -212 (string/memory/
sys-arith RLOps — not needed for first textout), -213 (system-call
dispatch — interactive surface), -214/215/216 (graphics + g00 + grp —
text-only smoke), -217 (audio — Warnings ok), -218 (save/load — not
exercised in replay), -221 (lineage notes — docs).

**Specific verification artifact (this is also requirement #6's
artifact).** See requirement #6.

**(Model, provider) pair rule.** Does NOT apply — the runtime is
deterministic Rust; no LLM.

### Requirement 6 — Verifiable patch landed (programmatic evidence)

**What exists today (landed).** Nothing — UTSUSHI-220 hasn't landed.
The substrate `TextSurfaceSink` trait (UTSUSHI-120 facade) is the
infrastructure UTSUSHI-209 will emit through; it's exercised by
synthetic tests only.

**What does NOT exist.** A node that captures `TextSurfaceSink` events
during a patched-Seen.txt replay and asserts en-US strings appear at
the expected scene+pause boundaries. (Frame-artifact verification via
`FrameArtifactSink` is optional for a text-only smoke; text-event
introspection is cleaner.)

**Specific verification artifact needed.** The recommended cleanest
shape is text-event introspection on the runner's `TextSurfaceSink`:

```
utsushi-reallive replay-and-verify \
  --seen <writable-target>/REALLIVEDATA/Seen.txt \
  --scene 1 \
  --expect-textline-contains "<en-US first-line excerpt>"
```

Returns 0 when at least one `TextLine` event in the `ReplayLog`
contains the expected substring; non-zero with `ReplayLog` written to
stdout otherwise. This composes UTSUSHI-220's `ReplayLog` JSON with a
single assertion — no GUI, no SDL2, no frame capture required.

Frame-capture verification (FrameArtifact PNG OCR or pixel-region
diff) stays continuous-tier; it's nice-to-have for runtime evidence
tier E2 but not alpha-blocking under the stricter definition (the
alpha gate is "the building blocks all fire," and the text-event
trace fires the loop end to end).

**(Model, provider) pair rule.** Does NOT apply.

---

## 3. Proposed NEW nodes

Tier defaults to `alpha` unless explicitly marked. IDs are placeholders.
Per the standing rules, every acceptance criterion names a runnable
artifact + shape; no node is research-shaped. Standing-rule abbrevs:
**NLC** = no-legacy-compat, **MPP** = model-provider-pair, **MGV** =
multi-game-validation, **INDA** = investigation-not-in-DAG.

### ITOTORI-NEW-Apair — (model, provider) pair refactor [alpha]

Promote every model invocation seam to required `(modelId, providerId)`
pair; delete the model-id-alone surface. `ModelInvocationRequest`, the
seven agent surfaces (`apps/itotori/src/agents/*`), the recorded-bundle
key, the OpenRouter request-body builder, and the
`draft_attempt_provider_ledger` schema all carry `providerId: string`
as required. OpenRouter client emits `provider: { only: [providerId] }`
and rejects responses whose upstream provider differs. Same change
deletes `modelId?` optionality, deletes invocation constructions
without `providerId`, deletes the model-only ledger rows after
backfill. No `#[deprecated]`, no aliases.

- **Acceptance:** `providers/types.ts` declares
  `ModelInvocationRequest.providerId: string` (no `?`); `git grep
'modelId?:' apps/itotori/src` returns zero hits; a type-level test
  asserts the TS compiler rejects an invocation without `providerId`;
  the OpenRouter request body for `providerId === "fireworks"`
  includes `"provider": { "only": ["fireworks"] }` (mocked-HTTP table
  test); ledger migration adds `provider_id NOT NULL` and the
  migration test asserts no NULL rows.
- **Depends on:** ITOTORI-019/021/075/077/078.
- **Audit focus:** NLC (model-only path gone, not deprecated), MPP,
  INDA. **MPP rule applies:** this IS the pair rule.

### ITOTORI-NEW-Bopen — OpenRouter live-provider implementation [alpha]

Concrete `OpenRouterModelProvider` implementing the `ModelProvider`
interface from -Apair. Reads `OPENROUTER_API_KEY` from `process.env` at
construction; never reads `.env`. Per-process cost cap (default $1
USD) and rate cap (default 1 req/s). The dev-tier pair is an exported
constant `DEV_PAIR = { modelId: "deepseek/deepseek-chat-v4",
providerId: "<chosen before merge>" }`; the choice is named in code
plus a 2–5 line note in the agent's prompt-preset metadata defending
it (capability + cost + latency snapshot).

- **Acceptance:** `OPENROUTER_API_KEY` absence at construction raises
  `ModelProviderError(code: configuration_error)`; a request with
  `DEV_PAIR` against a mocked OpenRouter server returns a
  `ProviderRunRecord` whose `requestedModelId` / `actualModelId` /
  `upstreamProvider` all match the pair; cost-cap excess raises
  `policy_blocked` BEFORE the HTTP request; an opt-in
  `OPENROUTER_LIVE=1 pnpm exec vp run itotori:openrouter-live-smoke`
  hits the real endpoint with a 50-token prompt and writes
  `artifacts/openrouter-live-smoke/<timestamp>.json` (gitignored).
- **Depends on:** ITOTORI-NEW-Apair.
- **Audit focus:** NLC (no "any provider" fallback), MPP (pair pinned
  at request AND verified on response), INDA. **MPP rule applies.**

### KAIFUU-NEW-Aaa — Real-bytes bridge-bundle producer [alpha]

`kaifuu_reallive::bridge::produce_bundle(scene_id, instructions,
gameexe) -> BridgeBundleV02`. Walks `Instruction` values from
KAIFUU-191, extracts text-display bodies, computes per-unit
protected-span ranges for surrounding control bytes (kidoku, name-token,
choice-marker, font-tone, asset-ref `#FACE`/`#GANBMP`), resolves
speakers through the `NAMAE` Gameexe table to character ref ids,
look-ahead-pins voice-line refs from the next `koe`/`koePlay`
targeting the same speaker slot, attaches `(scene_id, byte_range)`
provenance per unit for patchback. Extends the v0.2 protected-span
vocabulary same change if any RealLive kind is missing.

- **Acceptance:** `kaifuu-cli extract --engine reallive --scene 1
--bundle-output <out>.json <Sweetie HD>` exits 0 with
  `schemaVersion == "localization-bridge-schema/v0.2"`,
  `units.length >= 1`, first unit `sourceLocale == "ja-JP"`,
  `sourceEncoding == "shift-jis"`, ≥1 protected span of kind
  `reallive.kidoku`, and `provenance.byteRange` matches the
  text-display opcode body inside scene 1's scene blob (anchored at
  file offset 0x13880); a second scene with a `koe` op produces a
  bundle whose unit carries `voiceLineRef.archiveId == "z<NNNN>"` and
  matching `sampleId`.
- **Depends on:** KAIFUU-188/189/190/191.
- **Audit focus:** NLC (delete any synthetic `extract_text` callers
  same change), MGV (single-corpus alpha pass with `sourcing-required`
  note mirroring KAIFUU-188 pattern), INDA (span vocab additions are
  concrete). **MPP rule N/A.**

### KAIFUU-NEW-Apatch — Real-bytes patchback driver [alpha]

`kaifuu-cli patch --engine reallive --source <readonly-root>
--target <writable-root> --bundle bridge-bundle-translated.json`.
Copies readonly Sweetie HD to writable target on first use; per
translated `BridgeUnit` resolves `provenance.byteRange`, re-encodes
`targetText` (UTF-8 if the runtime decode hook accepts it, otherwise
Shift-JIS — choice named in code), rewrites the length-prefixed
text-display opcode body, rewrites the 10,000-slot directory
offsets/sizes when slot length changes, validates via
`reallive_seen_txt_envelope_ok` post-write.

- **Acceptance:** With a readonly source and a writable target, the
  command exits 0 and produces
  `<target>/REALLIVEDATA/Seen.txt` whose envelope probe returns true
  and whose `parse_archive` returns the same scene count as the
  source; the readonly source is sha256-unchanged after the command;
  a translated unit whose `provenance.byteRange` doesn't match a
  text-display opcode body emits
  `kaifuu.reallive.patchback_provenance_mismatch` Fatal and writes
  nothing; non-empty `--target` requires `--force` or emits
  `kaifuu.reallive.patchback_target_nonempty` Fatal.
- **Depends on:** KAIFUU-NEW-Aaa, KAIFUU-188/191.
- **Audit focus:** NLC (synthetic-shape `apply_patches` callers move
  to the bundle-driven path same change), MGV, INDA (encoding choice
  named). **MPP rule N/A.**

### ITOTORI-NEW-Cloop — Full agentic-loop orchestrator [alpha]

`runAgenticLoopForUnit(unit, pairPolicy, policy)` and
`pnpm exec vp run itotori:agentic-loop-smoke` chaining context lookup
→ scene-summary + character-relationship + terminology-candidate +
route-choice-map context pass → speaker-label pre-translation →
translation → deterministic checks (protected-spans, glossary,
charset, length, punctuation) → 4 LLM-QA agents → root-cause router →
bounded repair → final draft. Writes
`agentic-loop-bundle.v0.json` (new schema) with every stage's
invocation, provider run record, and decisions.

- **Acceptance:**
  `pnpm exec vp run itotori:agentic-loop-smoke --bridge <in>.json
--unit-index 0 --pair-policy <policy>.json` exits 0 with a bundle
  whose `stages` array contains `context`, `pre_translation`,
  `translation`, `deterministic_checks`, `qa_findings`, `routing`,
  optional `repair`, `final_draft`; every invocation record carries an
  explicit `(modelId, providerId)` from `pair-policy`; a
  deterministic-check P0 failure short-circuits before LLM-QA stages
  fire; a repair invocation respects `maxRepairAttempts` and an
  exceeded cap records `routing.outcome == "deferred_to_human"`.
- **Depends on:** ITOTORI-NEW-Apair/019/020/021/022/076/077/078,
  KAIFUU-NEW-Aaa.
- **Audit focus:** MPP (every stage), NLC (old isolated drafting
  command collapses into this orchestrator), INDA. **MPP rule
  applies.**

### UTSUSHI-NEW-Areplay — Patched-Seen.txt replay-and-verify smoke [alpha]

`utsushi-reallive replay-and-verify --seen
<target>/REALLIVEDATA/Seen.txt --scene 1
--expect-textline-contains <substring>`. Runs the UTSUSHI-220 driver,
captures the `ReplayLog`, asserts ≥1 `TextLine` event's `body`
contains the expected substring (picked from the translated bundle's
first unit). Exits 0 on match, non-zero with `ReplayLog` written to
stderr otherwise.

- **Acceptance:** with a patched copy and a substring from the
  translated bundle's first unit, exits 0 and prints
  `utsushi.reallive.replay_text_match_ok`; with the ORIGINAL
  unpatched copy and the same substring, exits non-zero (regression
  sentinel — if this also passes, the substring picker is matching
  pre-existing bytes and the test is broken); `ReplayLog` JSON is
  byte-deterministic across two runs against the same patched copy.
- **Depends on:** UTSUSHI-220, KAIFUU-NEW-Apatch.
- **Audit focus:** INDA (substring source defined: first translated
  unit's first sentence). **MPP rule N/A.**

### LOCALIZE-NEW-Aend — End-to-end `just localize-sweetie-hd` [alpha]

`just localize-sweetie-hd ITOTORI_REAL_GAME_ROOT=<readonly>
TARGET=<writable>` chains `kaifuu-cli extract` (-Aaa) →
`itotori:agentic-loop-smoke` (-Cloop) → `kaifuu-cli patch` (-Apatch) →
`utsushi-reallive replay-and-verify` (-Areplay). Each step's artifact
lands under one timestamped run dir.

- **Acceptance:** with both env vars set, exits 0 and produces under
  `artifacts/localize-sweetie-hd/<timestamp>/`: `bridge-bundle.json`,
  `agentic-loop-bundle.v0.json`, `patch-report.json`,
  `replay-log.json`; every artifact's `(modelId, providerId)` field
  (where applicable) matches a pair from a checked-in
  `presets/localize-sweetie-hd.pair-policy.json`; `replay-log.json`
  contains ≥1 `TextLine` whose body contains the en-US substring
  wired from the pair-policy; `--dry-run` prints per-step commands
  and exits 0 without any LLM call.
- **Depends on:** KAIFUU-NEW-Aaa/-Apatch, ITOTORI-NEW-Cloop/-Bopen,
  UTSUSHI-NEW-Areplay.
- **Audit focus:** INDA. **MPP rule applies via the pair-policy.**

### ITOTORI-NEW-Dtel — Live cost / token / latency telemetry [alpha]

Wire the existing ledger writer (`ITOTORI-077.DraftAttemptRecorder`)
to receive `ProviderRunRecord.cost`, `.tokenUsage`, `.latencyMs`, and
`.provider.upstreamProvider` from live OpenRouter responses
(ITOTORI-NEW-Bopen). Adds a per-pair aggregation read API for the
dashboard. No new schema beyond the `provider_id` column from -Apair.

- **Acceptance:** running -Cloop with the live OpenRouter provider
  populates ledger rows whose `provider_id`, `model_id`,
  `prompt_tokens`, `completion_tokens`, `latency_ms`, and
  `cost_micros_usd` are non-NULL for `cost_kind in {billed,
provider_estimate}`; new repo method `aggregateByPair(modelId,
providerId, {since, until})` returns the sum for the window and the
  dashboard renders a per-pair table; missing cost data (free-tier
  route) writes `provider_estimate` with a local estimate AND emits
  `itotori.cost.estimate_only` Warning.
- **Depends on:** ITOTORI-NEW-Apair/-Bopen, ITOTORI-077.
- **Audit focus:** MPP (aggregation key IS the pair), INDA. **MPP
  rule applies.**

### Flagged but NOT alpha-blocking

- **UTSUSHI-NEW-Bframe** (beta) — frame-capture verification: PNG
  capture at first-textout + OCR/pixel-diff against translated unit.
  Text-event introspection closes the alpha gate; frame capture is
  E2-tier evidence post-alpha.
- **UTSUSHI-NEW-Csiglus** (continuous) — the cross-engine
  substrate-conformance body of UTSUSHI-221, documentation-shaped.

---

## 4. Order-of-work recommendation

Parallelism + dependency order, not a timeline. No eng-time sizing.

**Wave 1 — Refactor the seam.** ITOTORI-NEW-Apair. One node; gates
every LLM-touching node downstream. Bundle re-key + ledger migration
are inside this same change.

**Wave 2 — Concrete-byte foundations + provider impl, in parallel.**
KAIFUU-191 (promote to alpha), KAIFUU-NEW-Aaa, ITOTORI-NEW-Bopen,
UTSUSHI-201..207 (Seen.txt parser, scene header, LZ+XOR-1, bytecode
elements, expression eval, banks, Gameexe). The five tracks (kaifuu
bridge, openrouter, three utsushi-reallive foundation groups) proceed
independently. KAIFUU-NEW-Aaa lands behind KAIFUU-191 within the same
wave.

**Wave 3 — Orchestration + VM execution.** ITOTORI-NEW-Cloop,
KAIFUU-NEW-Apatch, UTSUSHI-208 (VM), UTSUSHI-209 (text/messaging
RLOps — the alpha-defining `TextSurfaceSink` emission surface),
UTSUSHI-210 (control flow — typically needed before first textout),
ITOTORI-NEW-Dtel.

**Wave 4 — End-to-end gate landing.** UTSUSHI-220, UTSUSHI-NEW-Areplay
(thin wrapper around UTSUSHI-220 with the substring-assertion
contract), LOCALIZE-NEW-Aend. Cannot start until Wave 3's runtime
nodes and the patchback land. When these pass, the stricter alpha is
satisfied: real-bytes extraction → translated bridge → patched bytes
→ Linux runtime replay → programmatic text-event verification.

---

## 5. Risk callouts

### R1 — The runtime port is real work even with XOR-2 resolved.

Outcome A (no second-level XOR for compiler-version 110002) cancelled
UTSUSHI-219, but UTSUSHI-201..210 are still substantial. UTSUSHI-208
(VM) has a substrate-gap callout for the longop scheduler; UTSUSHI-209
must emit through `TextSurfaceSink` AND resolve speaker through
`NAMAE`; UTSUSHI-210 must handle gosub/ret/farcall stack-frame
correctness on cross-scene jumps. Any can produce a "VM runs but emits
zero TextLines" failure that looks like success because the smoke
halts on a Warning. UTSUSHI-220's audit-focus item "the test passing
because the VM happens to halt on a Warning before producing any
output" is load-bearing.

### R2 — (model, provider) pair refactor touches every agent seam.

ITOTORI-NEW-Apair's scope: seven agent surfaces, recorded bundles for
ITOTORI-019/021 (28 bundles for QA alone), QA calibration fixtures
(6), ledger schema migration, OpenRouter request-body builder,
policy module (`providers/policy.ts`), every test that constructs a
`ModelInvocationRequest`. No-legacy-compat means all of this moves in
one change; splitting is itself a violation. Risk: under-scoping and
landing a partial change that leaves `modelId?` optional in one
corner, shipping fixture-shaped "pair-required" claims.

### R3 — Linux frame capture is a new surface.

Out of scope for alpha (text-event introspection covers verification),
but flagged for the eventual UTSUSHI-NEW-Bframe (beta): SDL2 vs wgpu
vs headless framebuffer is a real architectural decision (C dep vs
pure-Rust graphics surface vs runtime "no-display" mode). The
text-event smoke path defers the question; it must be answered before
E2 frame-capture claims.

### R4 — OpenRouter structured-output support varies by (model, provider).

`feedback_model_provider_pair.md` flags this directly: some pairs
claim structured output and degrade silently per provider. The pair
refactor doesn't auto-solve it — the capability-guard surface
(`providers/capability-guard.ts`) must move from per-model to
per-(model, provider) lookups, AND recorded bundles for the degrading
cases must exist so CI catches future capability-claim drift. This
falls out of -Apair's "delete the model-only surface" rule but can
be missed.

### R5 — The dev-tier provider choice is a real decision.

`feedback_model_provider_pair.md` requires `providerId` to be an
explicit code constant. OpenRouter serves `deepseek` from multiple
providers (Fireworks, DeepInfra, Novita, ...) with notably different
structured-output behaviour. The choice must be made before
ITOTORI-NEW-Bopen merges; deferring collapses into the
investigation-not-in-DAG anti-pattern. Posture: pick by probing
candidates interactively (off-DAG per
`feedback_investigation_not_in_dag.md`), record choice +
justification in the agent's prompt-preset metadata, land -Bopen with
that pair as a named constant.

### R6 — Bridge schema v0.2 vocabulary may be RealLive-incomplete.

KAIFUU-NEW-Aaa depends on v0.2 having (or gaining same-change) the
RealLive protected-span kinds: `reallive.kidoku`,
`reallive.name_token`, `reallive.choice_marker`,
`reallive.asset_ref_face`, `reallive.asset_ref_ganbmp`,
`reallive.font_tone`. If v0.2's current closed-enum is
TyranoScript/MV-MZ-tuned, the additions ripple through the shared
contract validators (`packages/itotori-shared/src/...v0.2.ts`).
KAIFUU-NEW-Aaa's acceptance must name the exact span kinds emitted so
the check is enforceable.

### R7 — "First textout" demo target may not be representative.

Anchoring the runtime smoke on "scene 1 first textout" is the smallest
credible proof. If scene 1 starts with graphics or audio before the
first text-display opcode (not apparent per the research doc but not
explicitly verified), UTSUSHI-220 must handle "first textout arrives
after N graphics/audio Warnings" gracefully. UTSUSHI-220's audit-focus
already names the failure mode; bound risk, but "minimally functional"
must not be over-read as "skip every non-text opcode."

---

## Summary

What alpha needs that doesn't yet exist as nodes: a `(model, provider)`
pair refactor across every agent seam (Wave 1), an OpenRouter live
provider that pins the pair at request time (Wave 2), a real-bytes
bridge-bundle producer + a real-bytes patchback driver bracketing the
RealLive VM port (Waves 2–3), the full agentic-loop orchestrator that
chains context → pre-translation → translation → deterministic → QA →
repair (Wave 3), and a programmatic replay-and-verify path that
asserts en-US TextLine events fire through the substrate
`TextSurfaceSink` end-to-end (Wave 4). The DAG already contains the
RealLive runtime sub-nodes (UTSUSHI-201..221, minus the cancelled
-219) and they need to land substantially — the gap analysis is
NOT "add a runtime port node" but "promote the
alpha-blocking subset of UTSUSHI-201..210 + UTSUSHI-220 to alpha tier
and admit the seven NEW orchestration / pair / bridge / patchback /
telemetry nodes around them."
