// Clean-room RealLive fixture for the production Q5 integration proof.
//
// This stages a structurally valid one-scene Seen.txt archive and a real
// type-0 G00 source image authored entirely from deterministic bytes.  The
// bridge and narrative structure are deliberately produced through the native
// Kaifuu and Utsushi seams rather than copied from a static JSON fixture.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import { runKaifuuExtract } from "../src/extract/kaifuu-extract-seam.js";
import { runUtsushiStructureExport } from "../src/structure-export/utsushi-structure-seam.js";
import {
  parseNarrativeStructure,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  type NarrativeStructure,
} from "../src/structure/index.js";

const DIRECTORY_BYTES = 10_000 * 8;
const SCENE_HEADER_BYTES = 0x1d0;

// Opaque fixture identities are structurally required by the live Bible
// resolver; they intentionally carry no game or node vocabulary.
const CHARACTER_ID = "01920000-0000-7000-8000-000000000003";
const SPEAKER_ID = "01920000-0000-7000-8000-000000000001";
const ROUTE_ID = "01920000-0000-7000-8000-000000000004";

export const Q5_FIXTURE_IDENTITIES = {
  characterId: CHARACTER_ID,
  speakerId: SPEAKER_ID,
  routeId: ROUTE_ID,
} as const;

/** Shift-JIS-leading and recognized by the emitted-frame OCR alphabet. */
export const CLEAN_Q5_TARGET = "…Proof.";
/** Real patched glyphs that intentionally fail the emitted-frame OCR readback. */
export const OCR_FAILURE_Q5_TARGET = "…§Proof.";
export const Q5_BACKGROUND_ASSET = "SYNTH_BG";

export type RealLiveQ5Fixture = {
  readonly root: string;
  readonly sourceRoot: string;
  readonly buildRoot: string;
  readonly bridge: BridgeBundleV02;
  readonly structure: NarrativeStructure;
  dispose(): void;
};

/**
 * Stage the public, synthetic game root and derive its exact decode artifacts.
 * No source or target text is logged by this helper.
 */
export function stageRealLiveQ5Fixture(): RealLiveQ5Fixture {
  const root = mkdtempSync(join(tmpdir(), "itotori-role-q5-"));
  try {
    const sourceRoot = join(root, "source");
    const dataRoot = join(sourceRoot, "REALLIVEDATA");
    const g00Root = join(dataRoot, "g00");
    const buildRoot = join(root, "builds");
    const bridgePath = join(root, "native-bridge.json");
    const structurePath = join(root, "native-structure.json");
    mkdirSync(g00Root, { recursive: true });
    mkdirSync(buildRoot, { recursive: true });
    writeFileSync(join(dataRoot, "Seen.txt"), syntheticSeen());
    writeFileSync(join(dataRoot, "Gameexe.ini"), syntheticGameexe(), "ascii");
    writeFileSync(join(g00Root, `${Q5_BACKGROUND_ASSET}.g00`), syntheticType0G00());

    const extract = nativeExtract(sourceRoot, bridgePath);
    if (extract.status !== 0 || !existsSync(bridgePath)) {
      throw new Error("public Q5 fixture native bridge extraction did not produce an artifact");
    }
    const structureExport = nativeStructure(sourceRoot, bridgePath, structurePath);
    if (structureExport.status !== 0 || !existsSync(structurePath)) {
      throw new Error("public Q5 fixture native structure export did not produce an artifact");
    }

    const bridge = qualifyingBridge(readNativeBridge(bridgePath));
    const structure = qualifyingStructure(readNativeStructure(structurePath));
    if (bridge.units.length !== 1) {
      throw new Error(
        `public Q5 fixture expected one extracted dialogue unit, got ${String(bridge.units.length)}`,
      );
    }
    const unitCount = structure.scenes.flatMap((scene) => scene.units ?? []).length;
    if (unitCount !== 1) {
      throw new Error(
        `public Q5 fixture expected one native narrative unit, got ${String(unitCount)}`,
      );
    }

    return {
      root,
      sourceRoot,
      buildRoot,
      bridge,
      structure,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error: unknown) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function qualifyingBridge(bridge: BridgeBundleV02): BridgeBundleV02 {
  return {
    ...bridge,
    policyRecords: [
      ...bridge.policyRecords,
      {
        policyRecordId: "01920000-0000-7000-8000-000000000002",
        policyRecordKind: "non_translated_term",
        policyAction: "do_not_translate",
        termKey: SPEAKER_ID,
        sourceText: "Fixture",
        targetLocale: "en-US",
        policyReason: "Clean-room Q5 fixture Bible requirement.",
      },
    ],
    units: bridge.units.map((unit) => ({
      ...unit,
      spans: [],
      speaker: {
        knowledgeState: "known",
        speakerId: SPEAKER_ID,
        displayName: "Fixture",
        canonicalNameRef: CHARACTER_ID,
      },
    })),
  };
}

function nativeExtract(sourceRoot: string, bridgePath: string) {
  try {
    return runKaifuuExtract({
      engine: "reallive",
      gameRoot: sourceRoot,
      gameId: "public-synthetic",
      gameVersion: "1.0.0",
      sourceProfileId: "public-synthetic",
      sourceLocale: "ja-JP",
      wholeSeen: true,
      bundleOutputPath: bridgePath,
    });
  } catch {
    throw new Error("public Q5 fixture native bridge extraction failed");
  }
}

function nativeStructure(gameRoot: string, bridgePath: string, structurePath: string) {
  try {
    return runUtsushiStructureExport({
      engine: "reallive",
      gameRoot,
      bridgePath,
      outputPath: structurePath,
    });
  } catch {
    throw new Error("public Q5 fixture native structure export failed");
  }
}

function readNativeBridge(path: string): BridgeBundleV02 {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    assertBridgeBundleV02(parsed);
    return parsed;
  } catch {
    throw new Error("public Q5 fixture emitted an unreadable bridge artifact");
  }
}

function readNativeStructure(path: string): NarrativeStructure {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parseNarrativeStructure(parsed, SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS);
  } catch {
    throw new Error("public Q5 fixture emitted an unreadable structure artifact");
  }
}

function qualifyingStructure(structure: NarrativeStructure): NarrativeStructure {
  return {
    ...structure,
    scenes: structure.scenes.map((scene) => ({
      ...scene,
      units: (scene.units ?? []).map((unit) => ({
        ...unit,
        characterId: CHARACTER_ID,
        routeMembership: [ROUTE_ID],
        sourceAsset: { ...unit.sourceAsset, assetKey: unit.sourceAsset.assetId },
      })),
    })),
  };
}

/** One fully semantic textout + msg.pause scene in a 10,000-slot archive. */
function syntheticSeen(): Buffer {
  const bytecode = Buffer.from([
    // A clean-room Shift-JIS text surface. It is deliberately held as bytes
    // so this support module never prints or serializes source dialogue.
    0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x82, 0xa6, 0x82, 0xa8,
    // RealLive msg.pause: module 1 / id 3 / opcode 17.
    0x23, 0x01, 0x03, 0x11, 0x00, 0x00, 0x00, 0x00,
  ]);
  const compressed = avg32Literal(bytecode);
  const scene = Buffer.alloc(SCENE_HEADER_BYTES);
  scene.writeUInt32LE(SCENE_HEADER_BYTES, 0x000);
  scene.writeUInt32LE(10_002, 0x004);
  scene.writeUInt32LE(SCENE_HEADER_BYTES, 0x020);
  scene.writeUInt32LE(bytecode.length, 0x024);
  scene.writeUInt32LE(compressed.length, 0x028);
  const blob = Buffer.concat([scene, compressed]);
  const archive = Buffer.alloc(DIRECTORY_BYTES);
  archive.writeUInt32LE(DIRECTORY_BYTES, 8);
  archive.writeUInt32LE(blob.length, 12);
  return Buffer.concat([archive, blob]);
}

/** A public, deterministic type-0 BGR G00 with a real LZ77 back-reference. */
function syntheticType0G00(): Buffer {
  const width = 4;
  const height = 4;
  const pixels = width * height;
  const bgr: number[] = [0x11, 0x22, 0x33];
  for (let index = 1; index < pixels - 1; index += 1) {
    bgr.push(0x40 ^ index, 0x60 ^ index, 0x80 ^ index);
  }
  bgr.push(0x11, 0x22, 0x33);
  const lzss = type0Lzss(Buffer.from(bgr));
  const header = Buffer.alloc(13);
  header[0] = 0;
  header.writeUInt16LE(width, 1);
  header.writeUInt16LE(height, 3);
  header.writeUInt32LE(lzss.length + 8, 5);
  header.writeUInt32LE(pixels * 4, 9);
  return Buffer.concat([header, lzss]);
}

function type0Lzss(bgr: Buffer): Buffer {
  const pixelCount = bgr.length / 3;
  const encoded: number[] = [];
  let flagIndex = -1;
  let tokenCount = 0;
  const push = (literal: boolean, payload: readonly number[]): void => {
    if (tokenCount === 0) {
      flagIndex = encoded.length;
      encoded.push(0);
    }
    if (literal) encoded[flagIndex]! |= 1 << tokenCount;
    encoded.push(...payload);
    tokenCount = (tokenCount + 1) % 8;
  };
  for (let pixel = 0; pixel < pixelCount - 1; pixel += 1) {
    push(true, [...bgr.subarray(pixel * 3, pixel * 3 + 3)]);
  }
  const backref = (pixelCount - 1) << 4;
  push(false, [backref & 0xff, backref >>> 8]);
  return Buffer.from(encoded);
}

function syntheticGameexe(): string {
  return [
    "#SEEN_START=0001",
    "#SCREENSIZE_MOD=999,320,240",
    "#WINDOW_ATTR=8,8,12,220,0",
    "#WINDOW.000.POS=0:0,120",
    "#WINDOW.000.ATTR_MOD=0",
    "#WINDOW.000.ATTR=8,8,12,220,0",
    "#WINDOW.000.MOJI_SIZE=20",
    "#WINDOW.000.MOJI_POS=12,0,12,0",
    "#WINDOW.000.MOJI_CNT=24,3",
    "#WINDOW.000.MOJI_REP=-1,3",
    "#WINDOW.000.NAME_MOD=0",
    "#WINDOW.000.MESSAGE_MOD=0",
    "",
  ].join("\r\n");
}

/** Literal AVG32 encoder matching the public synthetic replay fixture. */
function avg32Literal(input: Buffer): Buffer {
  const output: number[] = Array.from({ length: 8 }, () => 0);
  let maskIndex = 8;
  for (let start = 0; start < input.length; start += 8) {
    const chunk = input.subarray(start, Math.min(start + 8, input.length));
    const flag = (1 << chunk.length) - 1;
    output.push(flag ^ AVG32_MASK[maskIndex % AVG32_MASK.length]!);
    maskIndex += 1;
    for (const byte of chunk) {
      output.push(byte ^ AVG32_MASK[maskIndex % AVG32_MASK.length]!);
      maskIndex += 1;
    }
  }
  return Buffer.from(output);
}

// Public AVG32 position mask used by the existing clean-room Rust fixture.
const AVG32_MASK = [
  0x8b, 0xe5, 0x5d, 0xc3, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x85, 0xc0, 0x74, 0x09, 0x5f, 0x5e, 0x33,
  0xc0, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x45, 0x0c, 0x85, 0xc0, 0x75, 0x14, 0x8b, 0x55, 0xec,
  0x83, 0xc2, 0x20, 0x52, 0x6a, 0x00, 0xe8, 0xf5, 0x28, 0x01, 0x00, 0x83, 0xc4, 0x08, 0x89, 0x45,
  0x0c, 0x8b, 0x45, 0xe4, 0x6a, 0x00, 0x6a, 0x00, 0x50, 0xff, 0x75, 0x0c, 0xe8, 0x71, 0xc4, 0x01,
  0x00, 0x83, 0xc4, 0x10, 0x89, 0x45, 0xe0, 0x8b, 0x45, 0xb8, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x8b,
  0x45, 0x0c, 0x50, 0xe8, 0x55, 0x28, 0x01, 0x00, 0x83, 0xc4, 0x04, 0x8b, 0x55, 0xec, 0x8b, 0x45,
  0xe0, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x8b, 0x45, 0xf0, 0x8b, 0x40, 0x10, 0x8b, 0x4d, 0xf0, 0x83,
  0xc1, 0x10, 0x51, 0x52, 0x50, 0xe8, 0xde, 0xfc, 0xff, 0xff, 0x83, 0xc4, 0x0c, 0xeb, 0x24, 0x6a,
  0xff, 0xff, 0x75, 0xe4, 0x8b, 0x45, 0xf0, 0x8b, 0x40, 0x10, 0x83, 0xc0, 0x10, 0x50, 0x68, 0x44,
  0x0e, 0x42, 0x00, 0xff, 0x75, 0x08, 0xe8, 0x4f, 0x16, 0x00, 0x00, 0x83, 0xc4, 0x10, 0x89, 0x45,
  0xf4, 0x8b, 0x45, 0xf4, 0x5f, 0x5e, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc,
  0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0x55, 0x8b, 0xec, 0x83, 0xec,
  0x10, 0x53, 0x56, 0x57, 0x33, 0xff, 0x33, 0xdb, 0x33, 0xf6, 0x39, 0x7d, 0x10, 0x76, 0x6c, 0x8b,
  0x45, 0x0c, 0x03, 0xc7, 0x33, 0xc9, 0x8a, 0x08, 0xc1, 0xe9, 0x05, 0x8b, 0x55, 0x08, 0x03, 0xd3,
  0x8a, 0x0c, 0x0a, 0x8b, 0x55, 0x0c, 0x03, 0xd7, 0x32, 0x0a, 0x88, 0x0a, 0x43, 0x83, 0xfb, 0x10,
  0x75, 0x05, 0x33, 0xdb, 0xff, 0x45, 0xf8,
] as const;
