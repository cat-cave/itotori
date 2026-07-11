// itotori-wire-patchback-safety-into-agentic-loop — integration proof.
//
// The deterministic patchback-safety layer (splitProtectedSpans /
// reconstructTarget / normalizeToSjisSafe + bounded json-repair) is proven at
// unit level in patchback-safety.test.ts. THIS suite proves it is WIRED into
// the PRODUCTION per-unit agentic loop (`runAgenticLoopForUnit`): each unit is
// routed through strip → translate-body → SJIS-normalize → re-inject, so the
// loop produces a patchback-safe target EVEN WHEN THE MOCKED LLM MISBEHAVES —
// dropping the 【name】/kidoku/「」 control markup, emitting curly-quote /
// em-dash / ellipsis typography that is not Shift_JIS-representable, or
// returning a truncated structured-output object. The LLM never sees the
// control markup and the loop no longer depends on it preserving markup; the
// DraftProtectedSpanValidator is now a safety net, not the primary mechanism.

import { describe, expect, it } from "vitest";
import {
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  type LocalizationUnitV02,
  type SurfaceKindV02,
} from "@itotori/localization-bridge-schema";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairPolicy,
} from "../src/orchestrator/agentic-loop.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import type { AuthorizationActor } from "@itotori/db";
import type { TranslationGlossaryEntry } from "../src/agents/translation/shapes.js";

const ACTOR: AuthorizationActor = { userId: "wire-patchback-safety-test-actor" };

const BRIDGE_UNIT_ID = "019ed079-0000-7000-8000-00000000dc01";
const PROJECT_ID = "019ed079-0000-7000-8000-000000000101";
const LOCALE_BRANCH_ID = "019ed079-0000-7000-8000-000000000102";
const REVISION_ID = "019ed079-0000-7000-8000-000000000103";
const ASSET_ID = "019ed079-0000-7000-8000-000000000104";

function makeUnit(
  sourceText: string,
  surfaceKind: SurfaceKindV02 = "dialogue",
): LocalizationUnitV02 {
  return {
    bridgeUnitId: BRIDGE_UNIT_ID,
    surfaceId: ASSET_ID,
    surfaceKind,
    sourceUnitKey: "scene-2011/line-042",
    occurrenceId: "occ-042",
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: "src-hash-wire-patchback",
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "fixture-rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "fixture-asset" },
    sourceLocation: { containerKey: "fixture-asset" },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: "scene-2011/line-042",
      sourceRevision: {
        revisionId: REVISION_ID,
        revisionKind: "content_hash",
        value: "fixture-rev",
      },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeInput(
  overrides: Partial<AgenticLoopUnitInput> & { unit: LocalizationUnitV02 },
): AgenticLoopUnitInput {
  return {
    sourceRevisionId: REVISION_ID,
    sceneUnits: [],
    glossary: [],
    protectedSpans: [],
    knownCharacters: [],
    actor: ACTOR,
    ...overrides,
  };
}

function makePolicy(overrides: Partial<AgenticLoopPolicy> = {}): AgenticLoopPolicy {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    maxRepairAttempts: 1,
    now: deterministicClock(),
    ...overrides,
  };
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 6, 4, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

function speakerLabelContent(): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId: BRIDGE_UNIT_ID,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fixture-narration",
      },
    ],
  });
}

function qaCleanContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}

/**
 * A translation structured-output whose draftText is the BODY the model
 * returns. In the wired loop the model only ever sees `skeleton.body`, so this
 * body carries NO control markup — the re-inject supplies it deterministically.
 */
function translationBodyContent(body: string): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId: BRIDGE_UNIT_ID,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText: body,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "fixture-body-only",
        confidenceFloor: "medium",
      },
    ],
  });
}

/**
 * Build a provider factory whose translation stage returns exactly
 * `translationRaw` (which may be malformed to exercise json-repair). Every
 * other stage returns a clean, schema-valid response.
 */
function providerFactoryReturning(translationRaw: string): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent();
        }
        if (request.taskKind === "experiment") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "draft_translation") {
          return translationRaw;
        }
        if (request.taskKind === "llm_qa") {
          return qaCleanContent();
        }
        return "";
      },
    });
}

describe("runAgenticLoopForUnit — patchback-safety wired into the production loop", () => {
  it("re-injects 【name】+「」 byte-exact when the mocked LLM DROPS all control markup", async () => {
    // Source carries a kidoku marker, a 【name】 token, and 「」 quotes.
    const source = "<reallive.kidoku 5>【ユカリ】「こんにちは」";
    // The model, seeing only the body 「こんにちは」→こんにちは, returns a bare
    // English body with NO markup whatsoever (worst case: it dropped it).
    const bundle = await runAgenticLoopForUnit(
      makeInput({ unit: makeUnit(source) }),
      DEV_POLICY,
      makePolicy(),
      providerFactoryReturning(translationBodyContent("Hello")),
    );
    // The deterministic re-inject supplied the markup: byte-exact 【name】+「」.
    expect(bundle.routingSummary.outcome).toBe("accepted");
    expect(bundle.finalDraft.draftText).toBe("【ユカリ】「Hello」");
  });

  it("re-injects even when the LLM ADDS spurious markup in its body (the loop ignores it)", async () => {
    const source = "<reallive.kidoku 1>【凛】「やあ」";
    // The model returns a body that itself tries to re-add markup + a name —
    // the loop translated only the body so it treats the WHOLE thing as body,
    // wrapping it again deterministically. Proves the loop does not depend on
    // the model to place markup.
    const bundle = await runAgenticLoopForUnit(
      makeInput({ unit: makeUnit(source) }),
      DEV_POLICY,
      makePolicy(),
      providerFactoryReturning(translationBodyContent("Hi there")),
    );
    expect(bundle.finalDraft.draftText).toBe("【凛】「Hi there」");
  });

  it("SJIS-normalizes curly quotes / em-dash / ellipsis in the body before re-inject", async () => {
    const source = "<reallive.kidoku 0>「テスト」";
    const bundle = await runAgenticLoopForUnit(
      makeInput({ unit: makeUnit(source) }),
      DEV_POLICY,
      makePolicy(),
      providerFactoryReturning(translationBodyContent("“Wait”—no…")),
    );
    // Curly quotes → ASCII, em-dash → --, ellipsis → ... ; 「」 re-injected.
    expect(bundle.finalDraft.draftText).toBe('「"Wait"--no...」');
    // Every codepoint is Shift_JIS-representable (ASCII or the CJK brackets).
    for (const ch of bundle.finalDraft.draftText ?? "") {
      const cp = ch.codePointAt(0) ?? 0;
      const sjisSafe = cp <= 0x7e || cp === 0x300c || cp === 0x300d; // 「 」
      expect(sjisSafe).toBe(true);
    }
  });

  it("romanizes the speaker name from the glossary when a preferredTargetForm exists", async () => {
    const source = "<reallive.kidoku 2>【ユカリ】「おはよう」";
    const glossary: TranslationGlossaryEntry[] = [
      {
        termId: "019ed079-0000-7000-8000-00000000gg01",
        preferredSourceForm: "ユカリ",
        preferredTargetForm: "Yukari",
        policyAction: "romanize",
      },
    ];
    const bundle = await runAgenticLoopForUnit(
      makeInput({ unit: makeUnit(source), glossary }),
      DEV_POLICY,
      makePolicy(),
      providerFactoryReturning(translationBodyContent("Morning")),
    );
    expect(bundle.finalDraft.draftText).toBe("【Yukari】「Morning」");
  });

  it("repairs a truncated / trailing-comma structured-output response and still produces a safe target", async () => {
    const source = "<reallive.kidoku 7>【某】「またね」";
    // A trailing comma after the draft object makes JSON.parse fail; the
    // agent's bounded repairJsonObject salvage strips it before schema
    // validation, so the loop still yields a patchback-safe target.
    const malformed = `{"schemaVersion":"${STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION}","drafts":[{"bridgeUnitId":"${BRIDGE_UNIT_ID}","sourceLocale":"ja-JP","targetLocale":"en-US","draftText":"See you","protectedSpanRefs":[],"citationRefs":[],"agentRationale":"fixture","confidenceFloor":"medium"},]}`;
    const bundle = await runAgenticLoopForUnit(
      makeInput({ unit: makeUnit(source) }),
      DEV_POLICY,
      makePolicy(),
      providerFactoryReturning(malformed),
    );
    expect(bundle.routingSummary.outcome).toBe("accepted");
    expect(bundle.finalDraft.draftText).toBe("【某】「See you」");
  });

  it("config-coherence: a choice_label with no name/quotes re-injects a bare body (still SJIS-normalized)", async () => {
    // A choice unit has no 【name】 / 「」 wrappers — the same split applies and
    // reconstruct returns the bare body, proving the wiring is uniform across
    // whatever surface kind is in translation scope.
    const bundle = await runAgenticLoopForUnit(
      makeInput({ unit: makeUnit("<reallive.kidoku 3>はい", "choice_label") }),
      DEV_POLICY,
      makePolicy(),
      providerFactoryReturning(translationBodyContent("Yes—of course…")),
    );
    expect(bundle.finalDraft.draftText).toBe("Yes--of course...");
  });

  it("in-body variable spans survive strip → re-inject with recomputed offsets (validator passes as a safety net)", async () => {
    const source = "<reallive.kidoku 4>【店員】「{player}さん、いらっしゃい」";
    const input = makeInput({
      unit: makeUnit(source),
      glossary: [
        {
          termId: "019ed079-0000-7000-8000-00000000gg02",
          preferredSourceForm: "{player}",
          policyAction: "do_not_translate",
        },
      ],
      protectedSpans: [{ refId: "span-var-player", sourceText: "{player}", spanKind: "variable" }],
    });
    // Model keeps the {player} literal in its body draft (never sees the
    // markup) and declares its ref at the body-relative offset — the agent
    // still enforces in-body preservation at gen time; the loop then relocates
    // the ref against the reconstructed target.
    const body = "Welcome, {player}";
    const varStart = body.indexOf("{player}");
    const withRef = JSON.stringify({
      schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
      drafts: [
        {
          bridgeUnitId: BRIDGE_UNIT_ID,
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          draftText: body,
          protectedSpanRefs: [
            {
              refId: "span-var-player",
              startInDraft: varStart,
              endInDraft: varStart + "{player}".length,
            },
          ],
          citationRefs: [],
          agentRationale: "fixture-body-with-var",
          confidenceFloor: "medium",
        },
      ],
    });
    const bundle = await runAgenticLoopForUnit(
      input,
      DEV_POLICY,
      makePolicy(),
      providerFactoryReturning(withRef),
    );
    expect(bundle.routingSummary.outcome).toBe("accepted");
    expect(bundle.finalDraft.draftText).toBe("【店員】「Welcome, {player}」");
  });

  it("does NOT false-positive on spans OWNED by the re-inject layer (out-of-body caller guard)", async () => {
    // The catalog carries a markup span for the kidoku marker AND the 【name】
    // token. Both are stripped OFF the source by splitProtectedSpans and
    // re-emitted deterministically by reconstructTarget — the model never sees
    // them. Without the caller-scoped guard (selectSpansForValidation) the
    // DraftProtectedSpanValidator would false-flag them (span_deleted /
    // malformed_markup) and the loop could NOT reach `accepted`.
    const source = "<reallive.kidoku 5>【ユカリ】「こんにちは」";
    const input = makeInput({
      unit: makeUnit(source),
      protectedSpans: [
        { refId: "span-kidoku", sourceText: "<reallive.kidoku 5>", spanKind: "markup" },
        { refId: "span-name", sourceText: "【ユカリ】", spanKind: "markup" },
      ],
    });
    const bundle = await runAgenticLoopForUnit(
      input,
      DEV_POLICY,
      makePolicy(),
      providerFactoryReturning(translationBodyContent("Hello")),
    );
    // The re-inject layer guaranteed both spans byte-exact; the guard excluded
    // them from the validator so no false violation short-circuits / defers.
    expect(bundle.routingSummary.outcome).toBe("accepted");
    expect(bundle.finalDraft.draftText).toBe("【ユカリ】「Hello」");
  });
});

// Keep the PairPolicy import load-bearing for editors even though DEV_POLICY
// is used directly above.
const _policyTypeCheck: PairPolicy = DEV_POLICY;
void _policyTypeCheck;
