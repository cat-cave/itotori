#!/usr/bin/env node
// One-shot DAG mutation: apply the 2026-06-24 re-tier.
// Reads roadmap/spec-dag.json, writes back in-place.
//
// Mutations:
//   1. Re-tier alpha -> real-game-testing-ready (mass move of substrate)
//   2. Re-tier alpha -> beta (multi-engine families)
//   3. Re-tier alpha -> alpha (the Sweetie HD e2e set; explicit list, just stamps statusReason)
//   4. Re-tier continuous -> alpha (UTSUSHI-201..218, 220, 221; KAIFUU-191, 193)
//   5. Re-tier continuous -> real-game-testing-ready (KAIFUU-188/189/190)
//   6. Mint 11 new nodes (ITOTORI-220..223, KAIFUU-210/211, UTSUSHI-227..230, RGT-005)
//   7. Rewire ALPHA-005.dependsOn to the new alpha set.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dagPath = resolve(__dirname, "..", "roadmap", "spec-dag.json");
const dag = JSON.parse(readFileSync(dagPath, "utf8"));

const STAMP = "2026-06-24";
const PROPOSAL = "docs/proposals/dag-retier-2026-06-24.md";
const GAP = "docs/proposals/alpha-gap-analysis-2026-06-24.md";

// -----------------------------------------------------------------------------
// 1. Classification tables (per proposal §3)
// -----------------------------------------------------------------------------

// 3.1 Stays alpha (Sweetie HD e2e set). Explicit per proposal text.
const STAY_ALPHA = new Set([
  "ALPHA-005",
  "ALPHA-006",
  "ALPHA-008",
  "ITOTORI-116",
  "ITOTORI-117",
  "ITOTORI-022",
  "ITOTORI-024",
  "ITOTORI-038",
  "ITOTORI-042",
  "ITOTORI-081",
  "ITOTORI-082",
  "ITOTORI-083",
  "ITOTORI-084",
  "ITOTORI-118",
  "ITOTORI-023",
  "ITOTORI-095",
  "ITOTORI-028",
  "ITOTORI-040",
  "ITOTORI-027",
  "UTSUSHI-200",
  "UTSUSHI-222",
  "UTSUSHI-223",
  "UTSUSHI-224",
  "UTSUSHI-147",
  "KAIFUU-053",
]);

// 3.3 alpha -> beta (multi-engine + encrypted helper families)
const ALPHA_TO_BETA = new Set([
  // MV/MZ family
  "KAIFUU-007",
  "KAIFUU-039",
  "KAIFUU-068",
  "KAIFUU-108",
  "KAIFUU-109",
  "KAIFUU-110",
  "KAIFUU-111",
  "KAIFUU-112",
  "KAIFUU-115",
  "KAIFUU-116",
  "KAIFUU-117",
  "UTSUSHI-006",
  "UTSUSHI-010",
  "UTSUSHI-011",
  "UTSUSHI-031",
  "UTSUSHI-032",
  "UTSUSHI-033",
  "UTSUSHI-065",
  "UTSUSHI-102",
  "UTSUSHI-119",
  "UTSUSHI-133",
  "UTSUSHI-134",
  // Siglus family
  "KAIFUU-015",
  "KAIFUU-022",
  "KAIFUU-069",
  "KAIFUU-070",
  "KAIFUU-094",
  "UTSUSHI-034",
  "UTSUSHI-035",
  "UTSUSHI-036",
  // KAG / plain-KiriKiri family
  "KAIFUU-009",
  "KAIFUU-038",
  "KAIFUU-054",
  "KAIFUU-056",
  "KAIFUU-071",
  "KAIFUU-098",
  "UTSUSHI-037",
  "UTSUSHI-038",
  "UTSUSHI-039",
  // Encrypted-corpus helper infrastructure
  "KAIFUU-036",
  "KAIFUU-042",
  "KAIFUU-060",
  "KAIFUU-067",
  "KAIFUU-090",
  "KAIFUU-103",
  "KAIFUU-105",
  "KAIFUU-106",
  "KAIFUU-107",
  "KAIFUU-129",
]);

// 3.5 continuous -> alpha (UTSUSHI-201..221 minus 219, plus KAIFUU-191/193)
const CONT_TO_ALPHA = new Set([
  "UTSUSHI-201",
  "UTSUSHI-202",
  "UTSUSHI-203",
  "UTSUSHI-204",
  "UTSUSHI-205",
  "UTSUSHI-206",
  "UTSUSHI-207",
  "UTSUSHI-208",
  "UTSUSHI-209",
  "UTSUSHI-210",
  "UTSUSHI-211",
  "UTSUSHI-212",
  "UTSUSHI-213",
  "UTSUSHI-214",
  "UTSUSHI-215",
  "UTSUSHI-216",
  "UTSUSHI-217",
  "UTSUSHI-218",
  "UTSUSHI-220",
  "UTSUSHI-221",
  "KAIFUU-191",
  "KAIFUU-193",
]);

// continuous -> real-game-testing-ready (complete real-bytes parsing nodes)
const CONT_TO_RGT = new Set(["KAIFUU-188", "KAIFUU-189", "KAIFUU-190"]);

// -----------------------------------------------------------------------------
// 2. Apply re-tier to existing nodes
// -----------------------------------------------------------------------------

const stats = {
  alphaToRgt: 0,
  alphaToBeta: 0,
  alphaStays: 0,
  contToAlpha: 0,
  contToRgt: 0,
};

function appendStatusReason(node, note) {
  if (node.statusReason && node.statusReason.length > 0) {
    node.statusReason = `${node.statusReason} | ${note}`;
  } else {
    node.statusReason = note;
  }
}

for (const node of dag.nodes) {
  // alpha tier handling
  if (node.target === "alpha") {
    if (STAY_ALPHA.has(node.id)) {
      stats.alphaStays += 1;
      appendStatusReason(
        node,
        `Re-tier ${STAMP}: kept alpha under the new 4-tier framework (single-game Sweetie HD e2e set per ${PROPOSAL}).`,
      );
    } else if (ALPHA_TO_BETA.has(node.id)) {
      node.target = "beta";
      stats.alphaToBeta += 1;
      appendStatusReason(
        node,
        `Re-tier ${STAMP}: moved from alpha to beta — multi-engine / encrypted-variant work belongs in beta under the new 4-tier framework (per ${PROPOSAL}).`,
      );
    } else {
      node.target = "real-game-testing-ready";
      stats.alphaToRgt += 1;
      appendStatusReason(
        node,
        `Re-tier ${STAMP}: moved from alpha to real-game-testing-ready — the old "alpha" framing was renamed; substance unchanged. See ${PROPOSAL}.`,
      );
    }
    continue;
  }

  if (node.target === "continuous") {
    if (CONT_TO_ALPHA.has(node.id)) {
      node.target = "alpha";
      stats.contToAlpha += 1;
      appendStatusReason(
        node,
        `Re-tier ${STAMP}: promoted continuous -> alpha — required for the redefined alpha (utsushi-reallive Linux runtime / real-bytes extraction) per ${PROPOSAL}.`,
      );
    } else if (CONT_TO_RGT.has(node.id)) {
      node.target = "real-game-testing-ready";
      stats.contToRgt += 1;
      appendStatusReason(
        node,
        `Re-tier ${STAMP}: reclassified continuous -> real-game-testing-ready (parsing layer validated on real bytes; status unchanged). See ${PROPOSAL}.`,
      );
    }
    // UTSUSHI-219 stays cancelled+continuous per investigation-not-in-DAG.
  }
}

// -----------------------------------------------------------------------------
// 3. Mint new nodes
// -----------------------------------------------------------------------------

const newNodes = [];

// RGT-005 milestone hub
newNodes.push({
  id: "RGT-005",
  title: "Real-game-testing-ready milestone hub",
  status: "planned",
  priority: "P1",
  target: "real-game-testing-ready",
  projects: ["suite", "universal"],
  parallelGroup: "milestone",
  dependsOn: [
    "ALPHA-001",
    "ALPHA-002",
    "ALPHA-003",
    "ALPHA-004",
    "ALPHA-007",
    "ALPHA-009",
    "CATALOG-003",
    "CATALOG-004",
    "CATALOG-061",
    "CATALOG-007",
    "ITOTORI-026",
    "ITOTORI-039",
    "ITOTORI-059",
    "ITOTORI-089",
    "ITOTORI-090",
    "ITOTORI-091",
    "ITOTORI-092",
    "ITOTORI-099",
    "ITOTORI-100",
    "KAIFUU-064",
    "KAIFUU-104",
    "KAIFUU-171",
    "KAIFUU-188",
    "KAIFUU-189",
    "KAIFUU-190",
    "UNIV-021",
  ],
  summary:
    "Aggregate the real-game-testing-ready substrate scaffolding under one milestone hub (parallel to ALPHA-005 for the new 4-tier framework). Every non-complete P1 real-game-testing-ready node must be an ancestor of this hub per the schema-extended validator rule.",
  deliverables: [
    "real-game-testing-ready readiness checklist command or checked artifact",
    "Aggregated dependsOn covering the demoted alpha substrate + complete continuous reclassifications",
    "Hub-as-validator entry point for scripts/spec-dag.mjs validateAlphaReadinessPath extension",
  ],
  acceptanceCriteria: [
    "Every non-complete P1 target: real-game-testing-ready node is an ancestor of RGT-005 (enforced by scripts/spec-dag.mjs)",
    "RGT-005.dependsOn names the catalog/benchmark/dashboard/MV-MZ-readiness/synthetic-encrypted scaffolding set demoted from alpha per docs/proposals/dag-retier-2026-06-24.md §3.2",
    "The hub's verification commands include node scripts/spec-dag.mjs validate exit 0",
  ],
  verification: [
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
    { type: "command", value: "just check" },
  ],
  auditFocus: [
    "Hub used as a dumping-ground for nodes that should not actually be RGT",
    "Validator rule extension silently weakened to accept non-ancestors",
    "Milestone treated as a product endpoint",
  ],
  statusReason: `Minted ${STAMP} per ${PROPOSAL} §6: new milestone hub parallel to ALPHA-005 under the 4-tier framework.`,
});

// ITOTORI-220 — (model, providerId) pair refactor
newNodes.push({
  id: "ITOTORI-220",
  title: "itotori-agent-runtime: required (modelId, providerId) pair across every agent seam",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["itotori"],
  parallelGroup: "agent-runtime",
  dependsOn: ["ITOTORI-009", "ITOTORI-010", "ITOTORI-031", "ITOTORI-077"],
  summary:
    "Make providerId a required field on ModelInvocationRequest / ModelProvider; propagate through every caller, the OpenRouter request-body builder, the recorded-LLM bundle key, the seven agent surfaces (translation/qa/speaker-label/scene-summary/character-relationship/terminology-candidate/route-choice-map), the cost+provenance ledger (provider_id NOT NULL), and capability-guard lookups. Delete the model-only invocation surface in the same change (no-legacy-compat). Every call must declare both fields per docs/proposals/alpha-gap-analysis-2026-06-24.md §3 ITOTORI-NEW-Apair.",
  deliverables: [
    "apps/itotori/src/providers/types.ts: ModelInvocationRequest.providerId required (no ?)",
    "apps/itotori/src/providers/openrouter.ts: request body emits provider: { only: [providerId] } and validates upstreamProvider === providerId post-response",
    "Updated bundle key schema (modelId, providerId, promptHash, inputClassification) for recorded LLM bundles",
    "Ledger migration adding provider_id NOT NULL to draft_attempt_provider_ledger with backfill",
    "Capability-guard surface keyed by (modelId, providerId)",
  ],
  acceptanceCriteria: [
    "pnpm exec vp run ts:typecheck rejects an invocation site passing modelId without providerId (type-level test asserts compile failure)",
    "git grep 'modelId?:' apps/itotori/src returns zero hits and git grep 'ModelInvocationConfig::new_with_model' returns zero hits",
    "Recorded-LLM bundle key includes both modelId and providerId (deterministic key test fixture under fixtures/)",
    "Ledger row from a live call populates provider_id non-null; migration test asserts no NULL rows",
    "OpenRouter client emits provider: { only: ['fireworks'] } when providerId === 'fireworks' (mocked-HTTP table test)",
    "ModelProviderError with code pair_mismatch is raised when response upstreamProvider differs from requested providerId",
  ],
  verification: [
    { type: "command", value: "pnpm exec vp run ts:typecheck" },
    { type: "command", value: "pnpm --filter @itotori/app test -- providers/pair" },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "model-only invocation path #[deprecated] aliased instead of deleted (no-legacy-compat violation)",
    "providerId defaulted rather than required at construction",
    "Recorded bundle key shape silently widened to accept legacy keys",
    "Capability-guard left keyed by model alone for a subset of agents",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 ITOTORI-NEW-Apair: standing (model, providerId) pair rule needs an enforcement node before any live LLM call lands.`,
});

// ITOTORI-221 — Live OpenRouter ModelProvider impl
newNodes.push({
  id: "ITOTORI-221",
  title:
    "itotori-agent-runtime: live OpenRouter ModelProvider implementation (DEV_PAIR constant + caps)",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["itotori"],
  parallelGroup: "agent-runtime",
  dependsOn: ["ITOTORI-220"],
  summary:
    "Concrete OpenRouterModelProvider implementing the ModelProvider interface from ITOTORI-220. Reads OPENROUTER_API_KEY from process.env at construction (never reads .env). Per-process cost cap (default $1 USD) and rate cap (default 1 req/s). DEV_PAIR is an exported constant naming both modelId and providerId in code; the choice is defended in the agent's prompt-preset metadata with a capability + cost + latency note.",
  deliverables: [
    "apps/itotori/src/providers/openrouter.ts: OpenRouterModelProvider class implementing the ModelProvider interface from ITOTORI-220",
    "Exported DEV_PAIR constant { modelId, providerId } with named choice and prompt-preset metadata defense",
    "Per-process cost cap (default 1 USD) and rate cap (default 1 req/s) enforced before HTTP",
    "Opt-in itotori:openrouter-live-smoke command that hits the real endpoint and writes artifacts/openrouter-live-smoke/<timestamp>.json (gitignored)",
  ],
  acceptanceCriteria: [
    "OPENROUTER_API_KEY absence at construction raises ModelProviderError with code configuration_error",
    "Request with DEV_PAIR against a mocked OpenRouter server returns a ProviderRunRecord whose requestedModelId, actualModelId, and upstreamProvider all match the pair byte-for-byte",
    "Cost-cap excess raises policy_blocked BEFORE the HTTP request fires (mocked test verifies no network call)",
    "OPENROUTER_LIVE=1 pnpm exec vp run itotori:openrouter-live-smoke writes artifacts/openrouter-live-smoke/<timestamp>.json with a non-empty completion and non-null cost",
    "DEV_PAIR.providerId is referenced as a named constant from at least one agent invocation surface; git grep finds no provider id literals in agent code",
  ],
  verification: [
    { type: "command", value: "pnpm --filter @itotori/app test -- providers/openrouter" },
    { type: "command", value: "OPENROUTER_LIVE=1 pnpm exec vp run itotori:openrouter-live-smoke" },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "Any-provider fallback hidden inside the openrouter client",
    "providerId pinned at request but not verified on response",
    "Cost cap bypassed by a code path that constructs the HTTP request before the policy check",
    "DEV_PAIR defaulted to a comment instead of a code constant",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 ITOTORI-NEW-Bopen: the alpha live-LLM clause needs a concrete provider impl that pins the pair at request time.`,
});

// ITOTORI-202 — Full agentic-loop orchestrator
newNodes.push({
  id: "ITOTORI-222",
  title:
    "itotori-agent-runtime: full agentic-loop orchestrator chaining context -> pre-translation -> translation -> deterministic -> QA -> repair",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["itotori"],
  parallelGroup: "translation-loop",
  dependsOn: [
    "ITOTORI-221",
    "ITOTORI-019",
    "ITOTORI-020",
    "ITOTORI-021",
    "ITOTORI-022",
    "ITOTORI-076",
    "ITOTORI-077",
    "ITOTORI-078",
    "KAIFUU-210",
  ],
  summary:
    "Land runAgenticLoopForUnit(unit, pairPolicy, policy) plus pnpm exec vp run itotori:agentic-loop-smoke chaining context lookup -> scene-summary + character-relationship + terminology-candidate + route-choice-map context pass -> speaker-label pre-translation -> translation -> deterministic checks (protected-spans, glossary, charset, length, punctuation) -> 4 LLM-QA agents -> root-cause router -> bounded repair -> final draft. Writes agentic-loop-bundle.v0.json with every stage's invocation, provider run record, and decisions. Every LLM call carries an explicit (modelId, providerId) pair from the pair-policy. The old isolated drafting command collapses into this orchestrator in the same change.",
  deliverables: [
    "apps/itotori/src/agents/orchestrator/index.ts: runAgenticLoopForUnit(unit, pairPolicy, policy)",
    "apps/itotori/src/commands/agentic-loop-smoke.ts CLI wrapper",
    "packages/itotori-shared/src/agentic-loop-bundle.v0.ts: new schema",
    "pair-policy JSON shape under presets/ pinning per-stage (modelId, providerId)",
    "Same-change deletion of the standalone drafting command surface (no-legacy-compat)",
  ],
  acceptanceCriteria: [
    "pnpm exec vp run itotori:agentic-loop-smoke --bridge <in>.json --unit-index 0 --pair-policy <policy>.json exits 0 with a bundle whose stages array contains: context, pre_translation, translation, deterministic_checks, qa_findings, routing, optional repair, final_draft",
    "Every invocation record in the bundle carries an explicit (modelId, providerId) from the pair-policy",
    "A deterministic-check P0 failure short-circuits before LLM-QA stages fire (test asserts no QA invocations in the bundle)",
    "A repair invocation respects maxRepairAttempts; an exceeded cap records routing.outcome == 'deferred_to_human'",
    "git grep for the old isolated drafting-command name returns zero hits (no-legacy-compat)",
  ],
  verification: [
    { type: "command", value: "pnpm --filter @itotori/app test -- agents/orchestrator" },
    {
      type: "command",
      value:
        "pnpm exec vp run itotori:agentic-loop-smoke --bridge fixtures/bridge-bundles/sweetie-hd-scene-1.bridge.json --unit-index 0 --pair-policy presets/localize-sweetie-hd.pair-policy.json",
    },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "Pair-policy defaulted instead of required",
    "Stages quietly skipped when invocation fails (silent partial bundle)",
    "Old drafting command kept as a shim",
    "Repair loop unbounded or bypassing the router decision",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 ITOTORI-NEW-Cloop: the alpha agentic-loop-fires clause needs a single orchestrator entry point.`,
});

// ITOTORI-223 — Live telemetry per pair
newNodes.push({
  id: "ITOTORI-223",
  title:
    "itotori-agent-runtime: live cost / token / latency telemetry per (modelId, providerId) pair",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["itotori"],
  parallelGroup: "agent-runtime",
  dependsOn: ["ITOTORI-220", "ITOTORI-221", "ITOTORI-077"],
  summary:
    "Wire the existing draft-attempt provider ledger writer (ITOTORI-077) to receive ProviderRunRecord.cost, .tokenUsage, .latencyMs, and .upstreamProvider from live OpenRouter responses (ITOTORI-221). Add a per-pair aggregation read API for the dashboard. No new schema beyond the provider_id column from ITOTORI-220. Free-tier (no billed cost) emits provider_estimate plus itotori.cost.estimate_only Warning.",
  deliverables: [
    "apps/itotori/src/agents/telemetry/aggregateByPair(modelId, providerId, { since, until }) repo method",
    "Dashboard widget rendering a per-pair table of cost / tokens / latency",
    "Free-tier path that writes provider_estimate cost rows with a local estimate AND emits itotori.cost.estimate_only Warning",
    "Updated ledger writer wiring under apps/itotori/src/agents/cost/",
  ],
  acceptanceCriteria: [
    "Running ITOTORI-202's orchestrator with the live OpenRouter provider populates ledger rows whose provider_id, model_id, prompt_tokens, completion_tokens, latency_ms, and cost_micros_usd are non-NULL for cost_kind in { billed, provider_estimate }",
    "aggregateByPair returns the sum for the window and the dashboard renders a per-pair table whose pair label matches (modelId, providerId) byte-for-byte",
    "Missing cost data (free-tier route) writes a provider_estimate row AND emits itotori.cost.estimate_only Warning (assertion on warning channel)",
    "Aggregation key is exactly (modelId, providerId); a misaligned aggregation key shape is rejected by a contract test",
  ],
  verification: [
    { type: "command", value: "pnpm --filter @itotori/app test -- agents/cost" },
    { type: "command", value: "pnpm --filter @itotori/db test -- ledger" },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "Aggregation key collapsed back to model alone for a subset of providers",
    "Free-tier path falling back to NULL without the Warning",
    "Dashboard rendering pair label without provider id (visual MPP violation)",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 ITOTORI-NEW-Dtel: live cost visibility per pair is part of the alpha agentic-loop-fires clause.`,
});

// KAIFUU-210 — Real-bytes bridge bundle producer
newNodes.push({
  id: "KAIFUU-210",
  title: "kaifuu-reallive: real Sweetie HD scene bytecode -> v0.2 bridge units",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["kaifuu", "shared"],
  parallelGroup: "engine-adapters",
  dependsOn: ["KAIFUU-188", "KAIFUU-189", "KAIFUU-190", "KAIFUU-191", "UTSUSHI-207", "SHARED-001"],
  summary:
    "Land crates/kaifuu-reallive/src/bridge.rs: produce_bundle(scene_id, instructions, gameexe) -> BridgeBundleV02. Walks Instruction values from KAIFUU-191, extracts text-display bodies, computes per-unit protected-span ranges for surrounding control bytes (kidoku, name-token, choice-marker, font-tone, asset-ref #FACE / #GANBMP), resolves speakers through the NAMAE Gameexe table to character ref ids, look-ahead-pins voice-line refs from the next koe / koePlay targeting the same speaker slot, attaches (scene_id, byte_range) provenance per unit. Extends the v0.2 protected-span vocabulary same-change if any RealLive kind is missing. Delete any synthetic-fixture bridge-emission path for RealLive same change (no-legacy-compat).",
  deliverables: [
    "crates/kaifuu-reallive/src/bridge.rs: produce_bundle(scene_id, instructions, gameexe) -> BridgeBundleV02",
    "kaifuu-cli extract --engine reallive --scene <n> --bundle-output <out>.json CLI surface",
    "packages/localization-bridge-schema/v0.2 additions for the RealLive protected-span kinds (kidoku, name_token, choice_marker, asset_ref_face, asset_ref_ganbmp, font_tone)",
    "Same-change deletion of any synthetic-fixture bridge-emission caller for RealLive (no-legacy-compat)",
  ],
  acceptanceCriteria: [
    "ITOTORI_REAL_GAME_ROOT=<path> cargo run -p kaifuu-cli -- extract --engine reallive --scene 1 --bundle-output /tmp/sweetie-hd-scene-1.bridge.json writes a schema-valid BridgeBundle with schemaVersion == 'localization-bridge-schema/v0.2'",
    "units[] length matches the textout+choice element count from UTSUSHI-204's decoded stream for scene 1",
    "First text unit's source.text Shift-JIS-decodes non-empty; speaker resolved via NAMAE for at least one unit",
    "At least one protected span of kind reallive.kidoku is emitted; provenance.byteRange anchored against the text-display opcode body inside scene 1's scene blob (anchored at file offset 0x13880)",
    "A second scene with a koe op produces a bundle whose unit carries voiceLineRef.archiveId == 'z<NNNN>' and a matching sampleId",
  ],
  verification: [
    { type: "command", value: "cargo test -p kaifuu-reallive bridge::tests" },
    { type: "command", value: "cargo test -p kaifuu-cli extract::reallive" },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "Synthetic-fixture bridge-emission path left in place as a fallback",
    "Protected-span vocabulary additions left undocumented in the v0.2 schema",
    "NAMAE speaker resolution silently falls back to free-text speaker name",
    "Provenance byteRange recorded against decompressed offset instead of file offset (breaks patchback)",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 KAIFUU-NEW-Aaa: real-bytes extraction clause needs a producer that walks parsed scenes into v0.2 bridge units.`,
});

// KAIFUU-211 — Real-bytes patchback driver
newNodes.push({
  id: "KAIFUU-211",
  title: "kaifuu-reallive: real-bytes patchback driver (translated bundle -> writable Seen.txt)",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["kaifuu"],
  parallelGroup: "engine-adapters",
  dependsOn: ["KAIFUU-188", "KAIFUU-191", "KAIFUU-210"],
  summary:
    "Land kaifuu-cli patch --engine reallive --source <readonly-root> --target <writable-root> --bundle bridge-bundle-translated.json. Copies readonly Sweetie HD to writable target on first use, per translated BridgeUnit resolves provenance.byteRange, re-encodes targetText (UTF-8 if the runtime decode hook accepts it, otherwise Shift-JIS - choice named in code), rewrites the length-prefixed text-display opcode body, rewrites the 10,000-slot directory offsets/sizes when slot length changes, validates via reallive_seen_txt_envelope_ok post-write. Same-change move of synthetic-shape apply_patches callers to the bundle-driven path (no-legacy-compat).",
  deliverables: [
    "crates/kaifuu-reallive/src/patchback/bundle_driven.rs: bundle-driven patchback entry point",
    "kaifuu-cli patch --engine reallive --source --target --bundle CLI surface",
    "Readonly-source / writable-target discipline (mtime + sha256 invariant on source)",
    "Same-change deletion of any synthetic-shape apply_patches caller (no-legacy-compat)",
  ],
  acceptanceCriteria: [
    "kaifuu-cli patch --engine reallive --source <readonly-sweetie> --target <writable-target> --bundle bridge-bundle-translated.json exits 0 and produces <writable-target>/REALLIVEDATA/Seen.txt whose envelope probe reallive_seen_txt_envelope_ok returns true and whose parse_archive returns the same scene count as the source",
    "The readonly source is sha256-unchanged after the command (test fixture asserts the hash before and after)",
    "A translated unit whose provenance.byteRange doesn't match a text-display opcode body emits kaifuu.reallive.patchback_provenance_mismatch Fatal and writes nothing",
    "Non-empty --target without --force emits kaifuu.reallive.patchback_target_nonempty Fatal",
    "en-US strings appear at the post-patch byte ranges (round-trip through parse_archive + decompressor + decoded text stream verifies)",
  ],
  verification: [
    { type: "command", value: "cargo test -p kaifuu-reallive patchback::bundle_driven" },
    { type: "command", value: "cargo test -p kaifuu-cli patch::reallive" },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "Synthetic-shape apply_patches caller left in place",
    "Encoding choice (UTF-8 vs Shift-JIS) defaulted instead of named in code",
    "Directory rewrite skipped when slot length changes (silent corruption)",
    "Readonly source mutated by the copy step (no sha256 invariant)",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 KAIFUU-NEW-Apatch: the alpha real-patchback clause needs a bundle-driven driver.`,
});

// UTSUSHI-227 — Patched-Seen.txt replay-and-verify smoke
newNodes.push({
  id: "UTSUSHI-227",
  title: "utsushi-reallive: patched-Seen.txt replay-and-verify smoke (en-US TextLine assertion)",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["utsushi"],
  parallelGroup: "runtime-adapters",
  dependsOn: ["UTSUSHI-220", "UTSUSHI-209", "KAIFUU-211"],
  summary:
    "Land utsushi-reallive replay-and-verify --seen <target>/REALLIVEDATA/Seen.txt --scene 1 --expect-textline-contains <substring>. Runs the UTSUSHI-220 driver, captures the ReplayLog from the substrate TextSurfaceSink, asserts at least one TextLine event's body contains the expected substring (picked from the translated bundle's first unit). Exits 0 on match, non-zero with the ReplayLog written to stderr otherwise. The contracted regression sentinel: the ORIGINAL unpatched copy + the same substring must exit non-zero (otherwise the substring picker is matching pre-existing bytes and the test is broken).",
  deliverables: [
    "crates/utsushi-reallive/src/bin/replay-validate-sweetie-hd.rs (or equivalent bin) implementing replay-and-verify",
    "ReplayLog JSON shape captured from the TextSurfaceSink event stream",
    "Substring-source contract: first translated unit's first sentence; documented in CLI --help",
    "Regression-sentinel test running both patched and unpatched copies",
  ],
  acceptanceCriteria: [
    "cargo run -p utsushi-reallive --bin replay-validate-sweetie-hd -- --seen <patched-target>/REALLIVEDATA/Seen.txt --scene 1 --expect-textline-contains '<en-US first-line excerpt>' exits 0 and prints utsushi.reallive.replay_text_match_ok",
    "With the ORIGINAL unpatched copy and the same substring, the command exits non-zero (regression sentinel)",
    "ReplayLog JSON is byte-deterministic across two runs against the same patched copy",
    "At least one TextLine event in the ReplayLog has a body containing the expected substring (verified by direct JSON inspection in the test)",
    "Linux-only: no Command::new('wine ...') or Windows-binary invocation in the bin or its dependencies (lint check + git grep)",
  ],
  verification: [
    { type: "command", value: "cargo test -p utsushi-reallive replay_and_verify" },
    {
      type: "command",
      value: "cargo run -p utsushi-reallive --bin replay-validate-sweetie-hd -- --help",
    },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "Test passing because the VM happens to halt on a Warning before producing any output",
    "Substring picker matching pre-existing bytes (regression-sentinel skipped)",
    "ReplayLog non-deterministic across runs (timestamp / nondet ordering)",
    "Wine / Windows-binary invocation hidden in a dependency",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 UTSUSHI-NEW-Areplay: the alpha verifiable-patch-landed clause needs programmatic TextLine assertion through the TextSurfaceSink.`,
});

// UTSUSHI-228 — just localize-sweetie-hd end-to-end command
newNodes.push({
  id: "UTSUSHI-228",
  title:
    "suite: just localize-sweetie-hd end-to-end command (extract -> translate -> patch -> replay-verify)",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["suite"],
  parallelGroup: "alpha-integration",
  dependsOn: [
    "KAIFUU-210",
    "KAIFUU-211",
    "ITOTORI-221",
    "ITOTORI-222",
    "ITOTORI-223",
    "UTSUSHI-220",
    "UTSUSHI-227",
    "ALPHA-006",
  ],
  summary:
    "Justfile recipe + thin driver wrapping kaifuu-cli extract (KAIFUU-210) -> itotori:agentic-loop-smoke (ITOTORI-222) with the live OpenRouter provider (ITOTORI-221) -> kaifuu-cli patch (KAIFUU-211) -> utsushi-reallive replay-and-verify (UTSUSHI-227) into one command. Each step's artifact lands under one timestamped run dir. The (modelId, providerId) pair is loaded from presets/localize-sweetie-hd.pair-policy.json per ITOTORI-220's standing rule.",
  deliverables: [
    "Justfile recipe localize-sweetie-hd",
    "presets/localize-sweetie-hd.pair-policy.json checked into the repo",
    "Driver under suite/scripts/localize-sweetie-hd/ chaining the four phases",
    "Timestamped artifact directory schema artifacts/localize-sweetie-hd/<timestamp>/{bridge-bundle.json, agentic-loop-bundle.v0.json, patch-report.json, replay-log.json}",
    "--dry-run flag that prints per-step commands and exits 0 without any LLM call",
  ],
  acceptanceCriteria: [
    "With OPENROUTER_API_KEY, ITOTORI_REAL_GAME_ROOT, and TARGET writable path set, just localize-sweetie-hd --project sweetie-hd-alpha-1 exits 0 and produces under artifacts/localize-sweetie-hd/<timestamp>/: bridge-bundle.json, agentic-loop-bundle.v0.json, patch-report.json, replay-log.json",
    "Every artifact's (modelId, providerId) field (where applicable) matches a pair from presets/localize-sweetie-hd.pair-policy.json byte-for-byte",
    "replay-log.json contains at least one TextLine event whose body contains the en-US substring wired from the pair-policy",
    "--dry-run prints per-step commands and exits 0 with zero ProviderRunRecords written to the ledger",
    "Agentic loop fires every stage exactly once for scene-1: context, pre-translation, translation, QA agents, deterministic checks, at least one edit/review cycle",
    "Read-only source invariant: sha256 of <source>/REALLIVEDATA/Seen.txt is unchanged before and after the command",
  ],
  verification: [
    { type: "command", value: "just localize-sweetie-hd --dry-run --project sweetie-hd-alpha-1" },
    {
      type: "command",
      value: "OPENROUTER_LIVE=1 just localize-sweetie-hd --project sweetie-hd-alpha-1",
    },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "Fallback to recorded provider in live mode (no-optionality violation)",
    "Pair-policy defaulted instead of required",
    "Stages quietly skipped when a phase fails",
    "Source mutation during the read-only step",
    "Single-game alpha claim widened to a multi-game claim by the artifact format",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 LOCALIZE-NEW-Aend: the alpha closer wraps every other alpha node into one command.`,
});

// UTSUSHI-229 — Linux frame capture path (beta)
newNodes.push({
  id: "UTSUSHI-229",
  title: "utsushi-reallive: Linux frame capture path (PNG capture at first textout)",
  status: "planned",
  priority: "P2",
  target: "beta",
  projects: ["utsushi"],
  parallelGroup: "runtime-adapters",
  dependsOn: ["UTSUSHI-220", "UTSUSHI-214", "UTSUSHI-215", "UTSUSHI-216", "UTSUSHI-227"],
  summary:
    "Land Linux frame-capture verification: PNG capture at first-textout boundary plus OCR / pixel-region diff against the translated unit. Out of scope for alpha (text-event introspection covers verification per UTSUSHI-227); flagged for beta because the architectural choice (SDL2 vs wgpu vs headless framebuffer) is a real decision per docs/proposals/alpha-gap-analysis-2026-06-24.md R3.",
  deliverables: [
    "crates/utsushi-reallive/src/frame_capture/ module with the chosen backend (SDL2 / wgpu / headless) named in code",
    "Bin replay-validate-sweetie-hd extended with --frame-out <dir> flag emitting frame-XXXX.png",
    "Frame structural-shape assertion (object count + region geometry) matching source replay at the same scene-tick",
  ],
  acceptanceCriteria: [
    "cargo run -p utsushi-reallive --bin replay-validate-sweetie-hd -- --seen <patched>/REALLIVEDATA/Seen.txt --scene 1 --frame-out /tmp/sweetie-hd-frames/ exits 0",
    "frame-0001.png is 1280x720 (per SCREENSIZE_MOD); object count matches source replay at the same scene-tick",
    "Two runs against the same patched copy produce byte-identical PNG outputs",
    "Backend choice (SDL2 / wgpu / headless) is named as a Cargo feature with the default documented in code",
  ],
  verification: [
    { type: "command", value: "cargo test -p utsushi-reallive frame_capture" },
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
  ],
  auditFocus: [
    "Backend choice deferred to runtime configuration rather than named in code",
    "Frame output nondeterministic across runs",
    "PNG dimensions defaulted instead of derived from SCREENSIZE_MOD",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 UTSUSHI-NEW-Bframe: flagged not-alpha-blocking; beta-tier under the new 4-tier framework.`,
});

// UTSUSHI-230 — Siglus integration (continuous)
newNodes.push({
  id: "UTSUSHI-230",
  title: "utsushi-siglus: cross-engine substrate-conformance body + Siglus lineage notes",
  status: "planned",
  priority: "P2",
  target: "continuous",
  projects: ["utsushi"],
  parallelGroup: "engine-research",
  dependsOn: ["UTSUSHI-221", "UTSUSHI-147"],
  summary:
    "Cross-engine substrate-conformance body extending UTSUSHI-221's lineage notes with Siglus-specific substrate alignment. Continuous-tier per docs/proposals/alpha-gap-analysis-2026-06-24.md §3 UTSUSHI-NEW-Csiglus: documentation-shaped, second-engine work outside the single-game Sweetie HD alpha definition.",
  deliverables: [
    "docs/research/siglus-substrate-lineage-notes.md (or equivalent under docs/research/)",
    "Conformance checklist linking Siglus engine surface to the shared substrate facade (UTSUSHI-120)",
    "Lineage diff between RealLive and Siglus substrate expectations",
  ],
  acceptanceCriteria: [
    "The conformance checklist names at least one concrete substrate facade method (e.g. TextSurfaceSink::on_text_line) plus the Siglus-side equivalent expected event shape",
    "Lineage notes are validated against the existing UTSUSHI-147 alignment notes (cross-reference present and verified by a docs lint)",
    "Documentation-only delivery: no engine adapter code lands in this node",
  ],
  verification: [
    { type: "command", value: "node scripts/spec-dag.mjs validate" },
    { type: "manual", value: "Siglus lineage notes review" },
  ],
  auditFocus: [
    "Implementation work hidden in the lineage doc",
    "Lineage claims unverified against the shared substrate facade method names",
    "Cross-reference to UTSUSHI-147 omitted",
  ],
  statusReason: `Minted ${STAMP} per ${GAP} §3 UTSUSHI-NEW-Csiglus: documentation-shaped continuous-tier follow-up.`,
});

// Append new nodes
for (const node of newNodes) {
  dag.nodes.push(node);
}

// -----------------------------------------------------------------------------
// 3b. Fix verifications on promoted-to-alpha nodes whose original
// continuous-tier verification entries do not satisfy the alpha-tier
// concrete-command rule. KAIFUU-191 used "direnv exec . cargo test ..."
// which the validator does not recognise (direnv prefix is not in the
// allowed command list); drop the direnv prefix so the bare cargo form
// matches the alpha-tier verification pattern.
// -----------------------------------------------------------------------------
{
  const k191 = dag.nodes.find((n) => n.id === "KAIFUU-191");
  if (k191) {
    k191.verification = [
      { type: "command", value: "cargo test -p kaifuu-reallive --test scene_real_bytes" },
      { type: "command", value: "cargo test -p kaifuu-reallive parser" },
    ];
  }
}

// -----------------------------------------------------------------------------
// 4. Rewire ALPHA-005.dependsOn to the new alpha set
// -----------------------------------------------------------------------------

const alpha005 = dag.nodes.find((n) => n.id === "ALPHA-005");
if (!alpha005) {
  throw new Error("ALPHA-005 not found");
}

// Drop deps that are now beta (MV/MZ / Siglus / encrypted-helper); add new alpha set + UTSUSHI-201..221 alphas.
const droppedDeps = new Set([
  "UTSUSHI-031",
  "UTSUSHI-032",
  "UTSUSHI-033",
  "UTSUSHI-036",
  "UTSUSHI-037",
  "UTSUSHI-038",
  "UTSUSHI-039",
  "KAIFUU-022",
  "KAIFUU-042",
  "KAIFUU-068",
  "KAIFUU-069",
  "KAIFUU-070",
]);
alpha005.dependsOn = alpha005.dependsOn.filter((id) => !droppedDeps.has(id));

const addedDeps = [
  // New alpha nodes
  "ITOTORI-220",
  "ITOTORI-221",
  "ITOTORI-222",
  "ITOTORI-223",
  "KAIFUU-210",
  "KAIFUU-211",
  "UTSUSHI-227",
  "UTSUSHI-228",
  // Existing alpha nodes orphaned by the beta-demotion of intermediate deps
  "ITOTORI-027",
  "ITOTORI-028",
  "ITOTORI-095",
  // Continuous -> alpha promotions (utsushi-reallive runtime port)
  "UTSUSHI-201",
  "UTSUSHI-202",
  "UTSUSHI-203",
  "UTSUSHI-204",
  "UTSUSHI-205",
  "UTSUSHI-206",
  "UTSUSHI-207",
  "UTSUSHI-208",
  "UTSUSHI-209",
  "UTSUSHI-210",
  "UTSUSHI-211",
  "UTSUSHI-212",
  "UTSUSHI-213",
  "UTSUSHI-214",
  "UTSUSHI-215",
  "UTSUSHI-216",
  "UTSUSHI-217",
  "UTSUSHI-218",
  "UTSUSHI-220",
  "UTSUSHI-221",
  "KAIFUU-191",
  "KAIFUU-193",
];
for (const id of addedDeps) {
  if (!alpha005.dependsOn.includes(id)) {
    alpha005.dependsOn.push(id);
  }
}

appendStatusReason(
  alpha005,
  `Re-tier ${STAMP}: rewired dependsOn to drop demoted-to-beta engine deps and add the new alpha set per ${PROPOSAL} §6.`,
);

// -----------------------------------------------------------------------------
// 5. Prune cross-tier dependsOn edges that now violate targetRank ordering.
//
// The re-tier intentionally demotes the substrate baseline to
// real-game-testing-ready and the multi-engine work to beta. Some
// historical dependsOn edges (e.g. an RGT scaffolding node depending on a
// beta MV/MZ adapter) violate the rank-ordering contract and now block
// validation. Per proposal §6 ("iterate on dependsOn rewrites until
// validator passes"), drop the offending edge and record the drop in
// statusReason so the audit trail is preserved.
// -----------------------------------------------------------------------------

const targetRank = {
  baseline: 0,
  "real-game-testing-ready": 1,
  alpha: 2,
  beta: 3,
  continuous: 4,
};

const idIndex = new Map(dag.nodes.map((n) => [n.id, n]));
const droppedEdgeCounts = {};

for (const node of dag.nodes) {
  if (!Array.isArray(node.dependsOn) || node.dependsOn.length === 0) {
    continue;
  }
  const keep = [];
  const dropped = [];
  for (const depId of node.dependsOn) {
    const dep = idIndex.get(depId);
    if (!dep) {
      keep.push(depId);
      continue;
    }
    if (targetRank[dep.target] > targetRank[node.target]) {
      dropped.push(`${depId}(${dep.target})`);
    } else {
      keep.push(depId);
    }
  }
  if (dropped.length === 0) {
    continue;
  }
  node.dependsOn = keep;
  droppedEdgeCounts[node.id] = dropped.length;
  appendStatusReason(
    node,
    `Re-tier ${STAMP}: pruned ${dropped.length} dependsOn edge(s) that crossed the new tier boundary [${dropped.join(", ")}]; per ${PROPOSAL} §6.`,
  );
}

const totalDroppedEdges = Object.values(droppedEdgeCounts).reduce((a, b) => a + b, 0);
console.log("Cross-tier dependsOn edges pruned:", totalDroppedEdges);
console.log("Nodes affected by pruning:        ", Object.keys(droppedEdgeCounts).length);

// -----------------------------------------------------------------------------
// 6. Complete-but-depends-on-incomplete: when a complete node had a
//    dependency promoted from continuous -> alpha that was planned, the
//    validator now flags it. The CONT_TO_ALPHA promotions are all planned
//    (the runtime port is not done yet), but they were originally
//    continuous so any complete node depending on them was already in
//    violation pre-mutation. We do not fix that here — the validator
//    flags would have fired already.
// -----------------------------------------------------------------------------

// Write back
// -----------------------------------------------------------------------------

writeFileSync(dagPath, JSON.stringify(dag, null, 2) + "\n", "utf8");

console.log("Re-tier complete.");
console.log("alpha -> real-game-testing-ready:", stats.alphaToRgt);
console.log("alpha -> beta:                   ", stats.alphaToBeta);
console.log("alpha -> alpha (kept):           ", stats.alphaStays);
console.log("continuous -> alpha:             ", stats.contToAlpha);
console.log("continuous -> real-game-testing-ready:", stats.contToRgt);
console.log("New nodes minted:                ", newNodes.length);
console.log("Total nodes:                     ", dag.nodes.length);
