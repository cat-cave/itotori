// KAIFUU-204 records metadata derived from a licensed, read-only KiriKiri XP3
// archive. No archive member bytes, member names, or scenario text are written
// to the repository. An operator can regenerate the recorded metadata with
// `--archive <path>`; the ordinary `--check` path uses the reviewed capture so
// it remains deterministic and does not require the external game archive.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repoRoot, "fixtures/public/kaifuu-xp3-plain-profile-a.manifest.json");
const kaifuu203ManifestPath = resolve(
  repoRoot,
  "fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json",
);
const XP3_PLAIN_MAGIC = Buffer.from([
  0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01,
]);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// Updated only by `--archive` against the licensed source. This is the
// metadata-only source of truth for ordinary CI and deterministic --check.
const RECORDED_ARCHIVE_FACTS = {
  archiveSha256: "3bd490400ab9062791ae754f0116b07e7fd5e1aceff131c1227f76f48ae18356",
  archiveBytes: 2060817,
  indexEncoding: "zlib",
  inventoryEntryCount: 93,
  scenarioEntryCount: 61,
  tagInventory: [
    "ALL_OFF",
    "CHARA_CH",
    "CHARA_MOVE",
    "CHARA_OFF",
    "CHARA_ON",
    "CHARA_SHAKE",
    "CH_NAME_M",
    "CH_NAME_O",
    "CH_NAME_OFF",
    "CH_NAME_W",
    "FAID_CH_CG",
    "FAID_IN_CG",
    "FLASH_WHITE",
    "GLASS_CH_CG",
    "INVISIBLE_CG",
    "MESSAGE_OFF",
    "MESSAGE_ON",
    "ONE_FLASH_CG",
    "PLAY_BGM",
    "PLAY_MOVIE_EJACULATE",
    "PLAY_MOVIE_LOOP",
    "PLAY_SE",
    "PLAY_SE_LOOP",
    "SHAKE_CG",
    "SHAKE_CG_S",
    "STOP_BGM",
    "STOP_MOVIE",
    "STOP_SE",
    "STOP_VOICE",
    "SYSTEM_MENU_ON",
    "THREE_FLASH_CG",
    "TR_CH_CG",
    "TR_IN_CG",
    "TWO_FLASH_CG",
    "T_IN_T_CG",
    "T_OUT_T_CG",
    "VOICE",
    "W0_0",
    "W0f0",
    "W0f0D0_0",
    "W0f0D0_03",
    "Y0",
    "a",
    "backlay",
    "call",
    "cancelskip",
    "clickskip",
    "cm",
    "current",
    "disablestore",
    "else",
    "elsif",
    "emb",
    "endif",
    "endlink",
    "endmacro",
    "eval",
    "fgzoom",
    "font",
    "freeimage",
    "h",
    "i",
    "if",
    "image",
    "jump",
    "laycount",
    "laynum",
    "layopt",
    "link",
    "macro",
    "mapdisable",
    "move",
    "mp",
    "n0",
    "nowait",
    "pimage",
    "playse",
    "position",
    "quake",
    "r",
    "rclick",
    "resetwait",
    "return",
    "s",
    "seopt",
    "stopse",
    "stoptrans",
    "style",
    "title",
    "trans",
    "wait",
    "wbgzoom",
    "wfgzoom",
    "wm",
    "wq",
    "ws",
    "wt",
    "x1",
    "x2",
    "y1",
    "y2",
  ],
};

function toSafeNumber(value, field) {
  if (value > MAX_SAFE_BIGINT) {
    throw new Error(`${field} is too large for this deterministic metadata generator`);
  }
  return Number(value);
}

function readU64(buffer, offset, field) {
  if (offset + 8 > buffer.length) {
    throw new Error(`truncated XP3 ${field}`);
  }
  return toSafeNumber(buffer.readBigUInt64LE(offset), field);
}

function checkedEnd(start, size, upperBound, field) {
  const end = start + size;
  if (!Number.isSafeInteger(end) || end > upperBound) {
    throw new Error(`truncated XP3 ${field}`);
  }
  return end;
}

function readXp3Index(archive) {
  if (!archive.subarray(0, XP3_PLAIN_MAGIC.length).equals(XP3_PLAIN_MAGIC)) {
    throw new Error("archive does not carry the plain XP3 magic");
  }
  const indexOffset = readU64(archive, XP3_PLAIN_MAGIC.length, "index offset");
  if (indexOffset >= archive.length) {
    throw new Error("invalid XP3 index offset");
  }
  const encoding = archive[indexOffset];
  const encodedSize = readU64(archive, indexOffset + 1, "index size");
  const encodedStart = indexOffset + 9;
  if (encoding === 0) {
    const encodedEnd = checkedEnd(encodedStart, encodedSize, archive.length, "index");
    return { index: archive.subarray(encodedStart, encodedEnd), indexEncoding: "raw" };
  }
  if (encoding !== 1) {
    throw new Error(`unsupported XP3 index encoding ${encoding}`);
  }
  const decodedSize = readU64(archive, encodedStart, "decoded index size");
  const compressedStart = encodedStart + 8;
  const compressedEnd = checkedEnd(
    compressedStart,
    encodedSize,
    archive.length,
    "compressed index",
  );
  const index = inflateSync(archive.subarray(compressedStart, compressedEnd));
  if (index.length !== decodedSize) {
    throw new Error("XP3 decoded index length did not match its declared length");
  }
  return { index, indexEncoding: "zlib" };
}

function parseFileChunk(index, start, end) {
  let cursor = start;
  let path;
  const segments = [];
  while (cursor < end) {
    const chunkEnd = checkedEnd(cursor, 12, end, "file chunk header");
    const chunkName = index.toString("ascii", cursor, cursor + 4);
    const chunkSize = readU64(index, cursor + 4, "file chunk size");
    const contentStart = chunkEnd;
    const contentEnd = checkedEnd(contentStart, chunkSize, end, "file chunk");
    if (chunkName === "info") {
      if (contentEnd - contentStart < 22) {
        throw new Error("truncated XP3 info chunk");
      }
      const pathUnits = index.readUInt16LE(contentStart + 20);
      const pathStart = contentStart + 22;
      const pathEnd = checkedEnd(pathStart, pathUnits * 2, contentEnd, "info path");
      path = index.toString("utf16le", pathStart, pathEnd);
    } else if (chunkName === "segm") {
      if ((contentEnd - contentStart) % 28 !== 0) {
        throw new Error("XP3 segment table was not a multiple of 28 bytes");
      }
      for (let segmentOffset = contentStart; segmentOffset < contentEnd; segmentOffset += 28) {
        segments.push({
          flags: index.readUInt32LE(segmentOffset),
          offset: readU64(index, segmentOffset + 4, "segment offset"),
          originalSize: readU64(index, segmentOffset + 12, "segment original size"),
          archiveSize: readU64(index, segmentOffset + 20, "segment archive size"),
        });
      }
    }
    cursor = contentEnd;
  }
  if (!path || segments.length === 0) {
    throw new Error("XP3 File chunk was missing a path or segment table");
  }
  return { path, segments };
}

function readXp3Entries(archive, index) {
  const entries = [];
  let cursor = 0;
  while (cursor < index.length) {
    const chunkEnd = checkedEnd(cursor, 12, index.length, "index chunk header");
    const chunkName = index.toString("ascii", cursor, cursor + 4);
    const chunkSize = readU64(index, cursor + 4, "index chunk size");
    const contentEnd = checkedEnd(chunkEnd, chunkSize, index.length, "index chunk");
    if (chunkName === "File") {
      entries.push(parseFileChunk(index, chunkEnd, contentEnd));
    }
    cursor = contentEnd;
  }
  return entries;
}

function scanTags(bytes) {
  if (isLikelyUtf16Le(bytes)) {
    return scanTagsInText(bytes.toString("utf16le"));
  }
  const tags = new Set();
  for (let offset = 0; offset < bytes.length; offset += 1) {
    if (bytes[offset] !== 0x5b) {
      continue;
    }
    if (bytes[offset + 1] === 0x5b) {
      offset += 1;
      continue;
    }
    const nameStart = offset + 1;
    let nameEnd = nameStart;
    const first = bytes[nameEnd];
    if (!isTagStart(first)) {
      continue;
    }
    nameEnd += 1;
    while (isTagContinue(bytes[nameEnd])) {
      nameEnd += 1;
    }
    tags.add(bytes.toString("ascii", nameStart, nameEnd));
  }
  return tags;
}

function isLikelyUtf16Le(bytes) {
  const pairs = Math.min(Math.floor(bytes.length / 2), 128);
  if (pairs === 0) {
    return false;
  }
  let zeroHighBytes = 0;
  for (let pair = 0; pair < pairs; pair += 1) {
    if (bytes[pair * 2 + 1] === 0) {
      zeroHighBytes += 1;
    }
  }
  return zeroHighBytes / pairs >= 0.8;
}

function scanTagsInText(text) {
  const tags = new Set();
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] !== "[") {
      continue;
    }
    if (text[offset + 1] === "[") {
      offset += 1;
      continue;
    }
    const match = /^\[([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(offset));
    if (match) {
      tags.add(match[1]);
    }
  }
  return tags;
}

function isTagStart(byte) {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f;
}

function isTagContinue(byte) {
  return isTagStart(byte) || (byte >= 0x30 && byte <= 0x39);
}

function readScenarioPayload(archive, entry) {
  const payloads = entry.segments.map((segment) => {
    const end = checkedEnd(segment.offset, segment.archiveSize, archive.length, "segment payload");
    const storedPayload = archive.subarray(segment.offset, end);
    const payload = (segment.flags & 1) === 0 ? storedPayload : inflateSync(storedPayload);
    if (payload.length !== segment.originalSize) {
      throw new Error("XP3 scenario segment length did not match its declared original size");
    }
    return payload;
  });
  return Buffer.concat(payloads);
}

function deriveArchiveFacts(archivePath) {
  const archive = readFileSync(archivePath);
  const { index, indexEncoding } = readXp3Index(archive);
  const entries = readXp3Entries(archive, index);
  const scenarioEntries = entries.filter(
    (entry) => entry.path.startsWith("scenario/") && entry.path.endsWith(".ks"),
  );
  const tags = new Set();
  for (const entry of scenarioEntries) {
    for (const tag of scanTags(readScenarioPayload(archive, entry))) {
      tags.add(tag);
    }
  }
  return {
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    archiveBytes: archive.length,
    indexEncoding,
    inventoryEntryCount: entries.length,
    scenarioEntryCount: scenarioEntries.length,
    tagInventory: [...tags].sort(),
  };
}

function readKaifuu203TagInventory() {
  const manifest = JSON.parse(readFileSync(kaifuu203ManifestPath, "utf8"));
  if (!Array.isArray(manifest.tagInventory)) {
    throw new Error("KAIFUU-203 manifest has no tagInventory");
  }
  return [...new Set(manifest.tagInventory)].sort();
}

function buildManifest(archiveFacts) {
  const kaifuu203Tags = readKaifuu203TagInventory();
  const tagInventory = [...new Set(archiveFacts.tagInventory)].sort();
  const intersection = kaifuu203Tags.filter((tag) => tagInventory.includes(tag));
  const ratio = intersection.length / kaifuu203Tags.length;
  return {
    $schema: "./xp3-profile-a.manifest.schema.json",
    schemaVersion: "0.1.0",
    "SPDX-License-Identifier": "LicenseRef-MangaGamer-Commercial-EULA",
    fixture: {
      id: "kaifuu-xp3-plain-profile-a",
      title: "Kaifuu licensed English plain-XP3 profile A metadata",
      kind: "metadata-only-real-game",
      summary:
        "Redacted metadata derived from a licensed English KiriKiri XP3 archive. The archive, member names, and scenario bytes are not redistributed or committed.",
      sourceLocale: "en-US",
      license: {
        spdx: "LicenseRef-MangaGamer-Commercial-EULA",
        termsUrl: "https://www.mangagamer.com/terms.php",
        evidence:
          "The source is a licensed MangaGamer English release. Its commercial terms do not grant redistribution of archive bytes, so this fixture commits metadata only; the SPDX LicenseRef is retained verbatim for the license boundary.",
      },
      provenance: {
        creationMethod:
          "Derived from the read-only licensed archive by fixtures/generate-kaifuu-xp3-plain-profile-a.mjs --archive <path>; records deterministic hashes, counts, and aggregate KAG tag names only.",
        rawAssetPolicy: "contains-no-copyrighted-game-assets",
      },
    },
    archive: {
      kind: "xp3-archive",
      sha256: archiveFacts.archiveSha256,
      bytes: archiveFacts.archiveBytes,
      indexEncoding: archiveFacts.indexEncoding,
      inventoryReader: "read_plain_xp3_inventory",
      inventoryEntryCount: archiveFacts.inventoryEntryCount,
      inventoryErrors: 0,
    },
    kagScenario: {
      kind: "kag-scenario",
      entryCount: archiveFacts.scenarioEntryCount,
      tagInventory,
      tagInventoryIntersectionWithKaifuu203: intersection,
      tagInventoryIntersectionRatioAgainstKaifuu203: ratio,
    },
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires an archive path`);
  }
  return value;
}

function main() {
  const check = process.argv.includes("--check");
  const archivePath = argumentValue("--archive");
  const archiveFacts = archivePath ? deriveArchiveFacts(archivePath) : RECORDED_ARCHIVE_FACTS;
  if (!archiveFacts) {
    throw new Error("no recorded profile-A metadata; run with --archive to derive it first");
  }
  const rendered = stableJson(buildManifest(archiveFacts));

  if (process.argv.includes("--print-derived")) {
    process.stdout.write(stableJson(archiveFacts));
    return;
  }
  if (check) {
    const committed = readFileSync(manifestPath, "utf8");
    if (committed !== rendered) {
      throw new Error(
        "kaifuu-xp3-plain-profile-a.manifest.json is stale; re-run the generator with the licensed archive",
      );
    }
    console.log("kaifuu-xp3-plain-profile-a.manifest.json is up to date");
    return;
  }
  writeFileSync(manifestPath, rendered);
  console.log("wrote fixtures/public/kaifuu-xp3-plain-profile-a.manifest.json");
}

main();
