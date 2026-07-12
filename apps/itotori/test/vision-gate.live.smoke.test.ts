// visual-inspection-gate-for-all-render-nodes — paid-boundary live smoke.
//
// A standalone vision command has no durable run-cost admission. Even with
// opt-in credentials it must refuse before a paid OpenRouter call; the
// providerOverride/fake suite covers vision verdict behavior separately.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runVisionGateCommand } from "../src/render-gate/index.js";

const LIVE_ENABLED =
  process.env.ITOTORI_VISION_GATE_LIVE === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0;

const EXPECTED_TEXT =
  process.env.ITOTORI_VISION_GATE_EXPECTED_TEXT ??
  "a single line of localized English dialogue in a message box with a speaker name label";

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

describe.skipIf(!LIVE_ENABLED)("vision gate live paid-provider boundary", () => {
  it("refuses a garbage-frame inspection before paid dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-gate-garbage-"));
    const framePath = join(dir, "garbage-solid-purple.png");
    // Solid purple — the same class of garbage (solid-color redaction) the
    // metadata checks failed to catch.
    writeFileSync(framePath, Buffer.from(solidColorPng(320, 180, [92, 40, 120])));

    await expect(
      runVisionGateCommand({
        framePath,
        expectedText: EXPECTED_TEXT,
        redactionMode: "off",
        inputClassification: "synthetic_public",
      }),
    ).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: { kind: "budget_cap" },
    });
  }, 60_000);
});
