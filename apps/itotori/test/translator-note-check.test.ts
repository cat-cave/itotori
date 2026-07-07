import { describe, expect, it } from "vitest";
import {
  detectTranslatorNoteFindings,
  findTranslatorNoteMatches,
  TRANSLATOR_NOTE_FINDING_CATEGORY,
  TRANSLATOR_NOTE_FINDING_SEVERITY,
  TRANSLATOR_NOTE_RULE_ID,
  type TranslatorNoteCheckUnit,
} from "../src/qa/index.js";
import {
  buildTranslationPrompt,
  translationPromptHash,
  type TranslationInvocationInput,
} from "../src/agents/translation/index.js";
import { buildQaPrompt, qaPromptHash } from "../src/agents/qa/index.js";

const FIXTURE_BRIDGE_UNIT_BASE = "019ed079-0000-7000-8000-000000000a";
const UNIT_CLEAN = `${FIXTURE_BRIDGE_UNIT_BASE}01`;
const UNIT_NOTE = `${FIXTURE_BRIDGE_UNIT_BASE}02`;
const UNIT_META = `${FIXTURE_BRIDGE_UNIT_BASE}03`;
const UNIT_CLEAN_TWO = `${FIXTURE_BRIDGE_UNIT_BASE}04`;
const UNIT_EMPTY = `${FIXTURE_BRIDGE_UNIT_BASE}06`;

function unit(bridgeUnitId: string, draftText: string): TranslatorNoteCheckUnit {
  return { bridgeUnitId, draftText };
}

describe("findTranslatorNoteMatches", () => {
  it("returns no matches on a clean draft", () => {
    expect(findTranslatorNoteMatches("Hello, {player}.")).toEqual([]);
    expect(findTranslatorNoteMatches("")).toEqual([]);
  });

  it("flags a trailing '(TL note: ...)' parenthetical", () => {
    const draft = "The hero entered the gate. (TL note: pun on gate/goal)";
    const matches = findTranslatorNoteMatches(draft);
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.text).toBe("(TL note: pun on gate/goal)");
    expect(draft.slice(m.start, m.end)).toBe(m.text);
    // Confirm the start lands on the opening paren, not the leading whitespace.
    expect(draft[m.start]).toBe("(");
    expect(draft[m.end - 1]).toBe(")");
  });

  it("flags a '(translator's note ...)' parenthetical", () => {
    const draft = "She whispered softly. (translator's note: ambiguous in the source)";
    const matches = findTranslatorNoteMatches(draft);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text.toLowerCase()).toContain("translator");
  });

  it("flags a '(translator note ...)' parenthetical without the possessive", () => {
    const draft = "And so the story ends. (translator note: open ending)";
    expect(findTranslatorNoteMatches(draft)).toHaveLength(1);
  });

  it("flags a '(meta-commentary ...)' parenthetical", () => {
    const draft = "She left. (meta-commentary: narrator breaks the fourth wall here.)";
    expect(findTranslatorNoteMatches(draft)).toHaveLength(1);
  });

  it("flags a '(meta note ...)' parenthetical", () => {
    const draft = "He nodded. (meta note: cue art change here.)";
    expect(findTranslatorNoteMatches(draft)).toHaveLength(1);
  });

  it("flags a '(trans. note ...)' parenthetical", () => {
    const draft = "Night fell. (trans. note: time skip in source.)";
    expect(findTranslatorNoteMatches(draft)).toHaveLength(1);
  });

  it("is case-insensitive across the keywords", () => {
    const a = findTranslatorNoteMatches("Hello. (TL NOTE: all caps)");
    const b = findTranslatorNoteMatches("Hello. (tl note: all lower)");
    const c = findTranslatorNoteMatches("Hello. (Translator's Note: title case)");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
  });

  it("does not flag a clean parenthetical that is NOT a translator-note (false-positive guard)", () => {
    // A parenthetical that doesn't read as translator-note / meta-commentary
    // must NOT trigger the check, even though it lives inside ( ... ).
    const draft = "He laughed (loudly) and walked away.";
    expect(findTranslatorNoteMatches(draft)).toEqual([]);
  });

  it("does not flag a bare '(note: ...)' parenthetical — too noisy", () => {
    // Documented carve-out: a generic "(note: ...)" inside dialog could be
    // a normal in-character aside. We do NOT match it; only translator-
    // specific + meta-commentary markers.
    const draft = "She said (note: see appendix B for details) and left.";
    expect(findTranslatorNoteMatches(draft)).toEqual([]);
  });

  it("merges overlapping matches (one nested parenthetical inside another) into a single match", () => {
    // Two adjacent parentheticals where the second is wholly inside the
    // first's range. The merge keeps the first (outer) match and drops the
    // inner one to avoid double-flagging the same bytes.
    const draft = "End. (TL note: see also (meta-commentary: nested))";
    const matches = findTranslatorNoteMatches(draft);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe(draft.slice(matches[0]!.start, matches[0]!.end));
  });

  it("returns multiple matches when the parentheticals do NOT overlap", () => {
    const draft = "First. (TL note: alpha) Second. (meta note: beta) Third.";
    const matches = findTranslatorNoteMatches(draft);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.start).toBeLessThan(matches[1]!.start);
  });
});

describe("detectTranslatorNoteFindings", () => {
  it("emits zero findings for an all-clean draft set", () => {
    const units = [unit(UNIT_CLEAN, "Hello, {player}."), unit(UNIT_CLEAN_TWO, "Goodbye.")];
    expect(detectTranslatorNoteFindings(units)).toEqual([]);
  });

  it("emits one finding per translator-note match, with stable draftSpan + recommended remediation", () => {
    const draft = "Hello. (TL note: greets player)";
    const findings = detectTranslatorNoteFindings([unit(UNIT_NOTE, draft)]);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.bridgeUnitId).toBe(UNIT_NOTE);
    expect(finding.severity).toBe(TRANSLATOR_NOTE_FINDING_SEVERITY);
    expect(finding.category).toBe(TRANSLATOR_NOTE_FINDING_CATEGORY);
    expect(finding.category).toBe("other");
    expect(finding.evidenceRefs).toEqual([TRANSLATOR_NOTE_RULE_ID]);
    expect(finding.draftSpan).toBeDefined();
    expect(draft.slice(finding.draftSpan!.start, finding.draftSpan!.end)).toBe(
      "(TL note: greets player)",
    );
    expect(finding.recommendation).toContain("Remove the parenthetical");
    expect(finding.agentRationale).toContain("(TL note: greets player)");
  });

  it("produces a stable, UUID7-shaped findingId across runs", () => {
    const draft = "Hello. (TL note: greets player)";
    const a = detectTranslatorNoteFindings([unit(UNIT_NOTE, draft)]);
    const b = detectTranslatorNoteFindings([unit(UNIT_NOTE, draft)]);
    expect(a[0]!.findingId).toBe(b[0]!.findingId);
    // UUID7-shaped: 8-4-4-4-12 hex with version=7 and variant=8/9/a/b.
    expect(a[0]!.findingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it("emits one finding per non-overlapping match (multiple parentheticals in one draft)", () => {
    const draft = "First. (TL note: alpha) Second. (meta-commentary: beta) Third.";
    const findings = detectTranslatorNoteFindings([unit(UNIT_NOTE, draft)]);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.draftSpan!.start).toBeLessThan(findings[1]!.draftSpan!.start);
    // Each finding id is unique within the unit.
    expect(findings[0]!.findingId).not.toBe(findings[1]!.findingId);
  });

  it("preserves unit input order across a mixed set", () => {
    const units = [
      unit(UNIT_CLEAN, "Hello."),
      unit(UNIT_NOTE, "Hi. (TL note: side comment)"),
      unit(UNIT_META, "Bye. (meta note: outro)"),
      unit(UNIT_EMPTY, ""),
    ];
    const findings = detectTranslatorNoteFindings(units);
    expect(findings.map((f) => f.bridgeUnitId)).toEqual([UNIT_NOTE, UNIT_META]);
  });

  it("does NOT mutate the input array", () => {
    const units = [unit(UNIT_NOTE, "Hi. (TL note: x)")];
    const snapshot = JSON.stringify(units);
    detectTranslatorNoteFindings(units);
    expect(JSON.stringify(units)).toBe(snapshot);
  });
});

describe("Translation prompt — no translator-notes instruction", () => {
  function inputFixture(): TranslationInvocationInput {
    return {
      draftJobId: "019ed079-0000-7000-8000-000000000d00",
      draftJobAttemptId: "019ed079-0000-7000-8000-000000000e00",
      projectId: "019ed079-0000-7000-8000-000000000001",
      localeBranchId: "019ed079-0000-7000-8000-000000000002",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      sourceBridgeUnits: [
        {
          bridgeUnitId: UNIT_CLEAN,
          sourceUnitKey: "scene.001.line.001",
          sourceText: "こんにちは。",
          sourceHash: "src-hash-1",
          speaker: "narration",
        },
      ],
      protectedSpansBySource: new Map(),
      glossary: [],
      styleGuide: [],
      contextArtifactRefs: [],
      modelProfile: {
        providerFamily: "fake",
        modelId: "itotori-fake-translation-v0",
        providerId: "fake-fixture",
        contextWindowTokens: 16000,
      },
      promptTemplateVersion: "itotori-translation-agent-v1",
    };
  }

  it("systemText instructs that draftText is target-language rendering only", () => {
    const rendered = buildTranslationPrompt(inputFixture());
    expect(rendered.systemText).toContain(
      "draftText MUST contain ONLY the target-language rendering",
    );
  });

  it("systemText explicitly forbids translator-notes and TL notes in draftText", () => {
    const rendered = buildTranslationPrompt(inputFixture());
    // Must explicitly name the forbidden shapes so a model prompted by it
    // can refuse to append them.
    expect(rendered.systemText.toLowerCase()).toContain("translator");
    expect(rendered.systemText.toLowerCase()).toContain("tl note");
    expect(rendered.systemText.toLowerCase()).toContain("meta-commentary");
    // And must direct the commentary to `agentRationale` instead.
    expect(rendered.systemText).toContain("agentRationale");
  });

  it("does not break byte-stability: same input → same hash with the new instruction", () => {
    const a = buildTranslationPrompt(inputFixture());
    const b = buildTranslationPrompt(inputFixture());
    expect(a).toEqual(b);
    expect(translationPromptHash(a)).toEqual(translationPromptHash(b));
  });
});

describe("QA prompt — translator-note rubric", () => {
  function inputFixture() {
    return {
      draftJobId: "019ed079-0000-7000-8000-000000000d00",
      projectId: "019ed079-0000-7000-8000-000000000001",
      localeBranchId: "019ed079-0000-7000-8000-000000000002",
      sourceRevisionId: "019ed079-0000-7000-8000-000000000003",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      units: [
        {
          bridgeUnitId: UNIT_CLEAN,
          sourceUnitKey: "scene.001.line.001",
          sourceText: "こんにちは。",
          sourceHash: "src-hash-1",
          draftText: "Hello.",
          draftHash: "drf-hash-1",
          speaker: "narration",
        },
      ],
      glossary: [],
      styleGuide: [],
      modelProfile: {
        providerFamily: "fake",
        modelId: "itotori-fake-qa-v0",
        providerId: "fake-fixture",
        contextWindowTokens: 16000,
      },
      qaPromptVersion: "itotori-qa-agent-v1",
    };
  }

  it("systemText instructs the QA rubric to flag parenthetical translator-notes", () => {
    const rendered = buildQaPrompt(inputFixture());
    expect(rendered.systemText.toLowerCase()).toContain("translator");
    expect(rendered.systemText.toLowerCase()).toContain("tl note");
    expect(rendered.systemText.toLowerCase()).toContain("parenthetical");
  });

  it("does not break byte-stability: same input → same hash with the new rubric line", () => {
    const a = buildQaPrompt(inputFixture());
    const b = buildQaPrompt(inputFixture());
    expect(a).toEqual(b);
    expect(qaPromptHash(a)).toEqual(qaPromptHash(b));
  });
});
