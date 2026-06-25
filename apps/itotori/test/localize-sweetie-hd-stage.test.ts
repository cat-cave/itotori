// UTSUSHI-228 — unit tests for the localize-sweetie-hd-stage handler.
//
// Covers:
//   - The pair-policy parser accepts the production preset shape.
//   - Missing/malformed pair-policy fields hard-fail (no defaulting).
//   - Per-stage pair must byte-equal the top-level pair (single-game
//     alpha invariant).
//   - The handler refuses to run with `providerKind: "fake"` unless
//     the `ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1` opt-in is set.
//   - The fake-provider mode (opt-in) writes all three artifacts AND
//     the agentic-loop-bundle.v0 carries the (modelId, providerId)
//     pair pinned on every invocation (matching the pair-policy).
//   - The synthesised translated bundle's `target.text` field contains
//     the en-US sentinel substring, wrapped with the SJIS bracket pair
//     (`「…」`) so the KAIFUU-191 lexer classifies it as a Textout run.
//   - The synthesised patch-report.json carries the (modelId,
//     providerId) pair byte-for-byte.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  LocalizeSweetieHdPairPolicyError,
  LocalizeSweetieHdRefusedFakeError,
  parseLocalizeSweetieHdPairPolicy,
  runLocalizeSweetieHdStageCommand,
  type LocalizeSweetieHdStageIo,
} from "../src/orchestrator/localize-sweetie-hd-stage-command.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const PAIR_POLICY_PATH = resolve(REPO_ROOT, "presets/localize-sweetie-hd.pair-policy.json");
const SMOKE_BRIDGE_PATH = resolve(
  REPO_ROOT,
  "apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json",
);

function loadPreset(): unknown {
  return JSON.parse(readFileSync(PAIR_POLICY_PATH, "utf8"));
}

function loadSmokeBridge(): unknown {
  return JSON.parse(readFileSync(SMOKE_BRIDGE_PATH, "utf8"));
}

function ioFixture(reads: Map<string, unknown>): {
  io: LocalizeSweetieHdStageIo;
  writes: Map<string, unknown>;
} {
  const writes = new Map<string, unknown>();
  const io: LocalizeSweetieHdStageIo = {
    readJson: vi.fn((path: string) => {
      if (!reads.has(path)) {
        throw new Error(`unexpected read: ${path}`);
      }
      return reads.get(path);
    }),
    writeJson: vi.fn((path: string, value: unknown) => {
      writes.set(path, value);
    }),
  };
  return { io, writes };
}

describe("UTSUSHI-228 parseLocalizeSweetieHdPairPolicy", () => {
  it("accepts the production preset shape and exposes pair + sentinel", () => {
    const parsed = parseLocalizeSweetieHdPairPolicy(loadPreset());
    expect(parsed.policyId).toBe("localize-sweetie-hd-alpha-1");
    expect(parsed.pair).toEqual({
      modelId: "deepseek/deepseek-v4-flash",
      providerId: "fireworks",
    });
    expect(parsed.enUsSentinel).toBe("STELLA-ALPHA-EN-US-SENTINEL");
    expect(parsed.sceneId).toBe(1);
  });

  it("rejects an object without policyId", () => {
    const preset = loadPreset() as Record<string, unknown>;
    delete preset.policyId;
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
  });

  it("rejects an object with an empty enUsSentinel", () => {
    const preset = loadPreset() as Record<string, unknown>;
    preset.enUsSentinel = "";
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
  });

  it("rejects when a stage pair drifts from the top-level pair", () => {
    const preset = loadPreset() as {
      stages: { translation: { primary: { modelId: string; providerId: string } } };
    };
    preset.stages.translation.primary = {
      modelId: "anthropic/claude-sonnet-4",
      providerId: "anthropic",
    };
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseLocalizeSweetieHdPairPolicy("not an object")).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
    expect(() => parseLocalizeSweetieHdPairPolicy(null)).toThrow(LocalizeSweetieHdPairPolicyError);
    expect(() => parseLocalizeSweetieHdPairPolicy([1, 2, 3])).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
  });
});

describe("UTSUSHI-228 runLocalizeSweetieHdStageCommand", () => {
  it("refuses providerKind='fake' unless ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1", async () => {
    const prevAllow = process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    try {
      const reads = new Map<string, unknown>([
        ["bridge.json", loadSmokeBridge()],
        ["pair-policy.json", loadPreset()],
      ]);
      const { io } = ioFixture(reads);
      await expect(
        runLocalizeSweetieHdStageCommand({
          bridgePath: "bridge.json",
          pairPolicyPath: "pair-policy.json",
          outputPath: "out/agentic-loop-bundle.v0.json",
          translatedBundleOutputPath: "out/translated-bridge.json",
          patchReportOutputPath: "out/patch-report.json",
          providerKind: "fake",
          io,
          actor: { userId: "test" },
        }),
      ).rejects.toBeInstanceOf(LocalizeSweetieHdRefusedFakeError);
    } finally {
      if (prevAllow === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = prevAllow;
      }
    }
  });

  it("writes all three artifacts, embeds the sentinel, and pins every invocation to the policy pair (fake provider, opt-in)", async () => {
    const prevAllow = process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = "1";
    try {
      const reads = new Map<string, unknown>([
        ["bridge.json", loadSmokeBridge()],
        ["pair-policy.json", loadPreset()],
      ]);
      const { io, writes } = ioFixture(reads);
      await runLocalizeSweetieHdStageCommand({
        bridgePath: "bridge.json",
        pairPolicyPath: "pair-policy.json",
        outputPath: "out/agentic-loop-bundle.v0.json",
        translatedBundleOutputPath: "out/translated-bridge.json",
        patchReportOutputPath: "out/patch-report.json",
        providerKind: "fake",
        io,
        actor: { userId: "test" },
      });

      // ----- AgenticLoopBundle -----
      const bundle = writes.get("out/agentic-loop-bundle.v0.json") as {
        schemaVersion: string;
        stages: Array<{
          stageName: string;
          invocations: Array<{
            pair: { modelId: string; providerId: string };
          }>;
        }>;
        finalDraft: { draftText?: string };
      };
      expect(bundle).toBeDefined();
      expect(bundle.schemaVersion).toBe("itotori.agentic-loop-bundle.v0");
      const stageNames = bundle.stages.map((s) => s.stageName);
      expect(stageNames).toEqual([
        "context",
        "pre_translation",
        "translation",
        "deterministic_checks",
        "qa_findings",
        "routing",
        "repair",
        "final_draft",
      ]);
      // Every invocation's pair must be the policy pair.
      for (const stage of bundle.stages) {
        for (const invocation of stage.invocations) {
          expect(invocation.pair.modelId).toBe("deepseek/deepseek-v4-flash");
          expect(invocation.pair.providerId).toBe("fireworks");
        }
      }
      // The fake provider embeds the sentinel into the draft text so we
      // can assert the orchestrator surfaced it through final-draft.
      expect(bundle.finalDraft.draftText ?? "").toContain("STELLA-ALPHA-EN-US-SENTINEL");

      // ----- Translated bridge bundle -----
      const translated = writes.get("out/translated-bridge.json") as {
        units: Array<{ target: { locale: string; text: string } }>;
      };
      expect(translated).toBeDefined();
      expect(translated.units.length).toBeGreaterThan(0);
      for (const unit of translated.units) {
        expect(unit.target.locale).toBe("en-US");
        expect(unit.target.text.startsWith("「")).toBe(true);
        expect(unit.target.text.endsWith("」")).toBe(true);
        expect(unit.target.text).toContain("STELLA-ALPHA-EN-US-SENTINEL");
      }

      // ----- Patch report -----
      const patchReport = writes.get("out/patch-report.json") as {
        schemaVersion: string;
        pair: { modelId: string; providerId: string };
        enUsSentinel: string;
        sceneId: number;
        translatedTargetText: string;
      };
      expect(patchReport).toBeDefined();
      expect(patchReport.schemaVersion).toBe("itotori.localize-sweetie-hd.patch-report.v0");
      expect(patchReport.pair).toEqual({
        modelId: "deepseek/deepseek-v4-flash",
        providerId: "fireworks",
      });
      expect(patchReport.enUsSentinel).toBe("STELLA-ALPHA-EN-US-SENTINEL");
      expect(patchReport.sceneId).toBe(1);
      expect(patchReport.translatedTargetText).toContain("STELLA-ALPHA-EN-US-SENTINEL");
    } finally {
      if (prevAllow === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = prevAllow;
      }
    }
  });
});
