// visual-inspection-gate-for-all-render-nodes — LIVE SMOKE (the real proof).
//
// Runs the eyes-on-pixels gate LIVE against a ZDR-routed OpenRouter VISION
// model on TWO frames and records the verdicts:
//
//   1. a GARBAGE frame (a solid-color fill, standing in for the real
//      solid/near-solid garbage render the metadata checks missed) — the
//      gate MUST return coherent:false and REJECT.
//   2. the REAL proof frame (real mansion + speaker name box + localized
//      English) — the gate MUST return coherent:true + legible and ACCEPT.
//
// Gated exactly like the other live paths: ITOTORI_VISION_GATE_LIVE=1 +
// OPENROUTER_API_KEY (+ the OpenRouter provider's own fail-closed
// OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 gate). Without the opt-in it SKIPS
// visibly (no silent pass). Never a billed call in default CI.
//
// Copyright: the committed test carries NO raw game dialogue — the expected
// localized text is supplied at runtime via ITOTORI_VISION_GATE_EXPECTED_TEXT
// (a generic hint by default). Verdict artifacts are written to an
// uncommitted /scratch directory.

import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runVisionGateCommand } from "../src/render-gate/index.js";

const LIVE_ENABLED =
  process.env.ITOTORI_VISION_GATE_LIVE === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0;

const PROOF_FRAME_PATH =
  process.env.ITOTORI_VISION_GATE_PROOF_FRAME ??
  "/home/trevor/projects/itotori/.private-render/diag/alpha006d-rerun-proof.png";

const EXPECTED_TEXT =
  process.env.ITOTORI_VISION_GATE_EXPECTED_TEXT ??
  "a single line of localized English dialogue in a message box with a speaker name label";

const SMOKE_OUT_DIR = process.env.ITOTORI_VISION_GATE_SMOKE_OUT ?? "/scratch/itotori-visgate-smoke";

/** crc32 (PNG chunk checksum). */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Build a valid solid-color RGB PNG (the constructed garbage frame). */
function solidColorPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

describe.skipIf(!LIVE_ENABLED)("vision gate LIVE smoke (ZDR OpenRouter vision)", () => {
  mkdirSync(SMOKE_OUT_DIR, { recursive: true });

  it("REJECTS a garbage (solid-color) frame → coherent:false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-gate-garbage-"));
    const framePath = join(dir, "garbage-solid-purple.png");
    // Solid purple — the same class of garbage (solid-color redaction) the
    // metadata checks failed to catch.
    writeFileSync(framePath, Buffer.from(solidColorPng(320, 180, [92, 40, 120])));

    const outcome = await runVisionGateCommand({
      framePath,
      expectedText: EXPECTED_TEXT,
      redactionMode: "off",
      inputClassification: "synthetic_public",
    });
    expect(outcome.status).not.toBe("skipped");
    if (outcome.status === "skipped") throw new Error("live gate skipped unexpectedly");

    writeFileSync(
      join(SMOKE_OUT_DIR, "garbage-verdict.json"),
      `${JSON.stringify(outcome.result.artifact, null, 2)}\n`,
    );

    expect(outcome.result.verdict.coherent).toBe(false);
    expect(outcome.result.gate.passed).toBe(false);
    expect(outcome.result.gate.failures).toContain("incoherent");
    // real served pair + real billed cost recorded
    expect(outcome.result.artifact.servedProviderId).not.toBeNull();
    expect(outcome.result.artifact.zdr).toBe(true);
    expect(Number(outcome.result.artifact.costUsd)).toBeGreaterThan(0);
  }, 60_000);

  it("ACCEPTS the real proof frame → coherent:true + legible", async () => {
    const outcome = await runVisionGateCommand({
      framePath: PROOF_FRAME_PATH,
      expectedText: EXPECTED_TEXT,
      redactionMode: "off",
      inputClassification: "private_corpus",
    });
    expect(outcome.status).not.toBe("skipped");
    if (outcome.status === "skipped") throw new Error("live gate skipped unexpectedly");

    writeFileSync(
      join(SMOKE_OUT_DIR, "real-proof-verdict.json"),
      `${JSON.stringify(outcome.result.artifact, null, 2)}\n`,
    );

    expect(outcome.result.verdict.coherent).toBe(true);
    expect(outcome.result.verdict.target_text_legible).toBe(true);
    expect(outcome.result.gate.passed).toBe(true);
    expect(outcome.result.artifact.servedProviderId).not.toBeNull();
    expect(outcome.result.artifact.zdr).toBe(true);
    expect(Number(outcome.result.artifact.costUsd)).toBeGreaterThan(0);
  }, 60_000);
});
