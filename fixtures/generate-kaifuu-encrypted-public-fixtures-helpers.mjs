import { createHash } from "node:crypto";

export function keyProfile(input) {
  return {
    schemaVersion: "0.1.0",
    profileId: input.profileId,
    gameId: input.gameId,
    title: input.title,
    sourceLocale: "ja-JP",
    engine: {
      adapterId: input.adapterId,
      engineFamily: input.engineFamily,
      engineVersion: null,
      detectedVariant: input.detectedVariant,
    },
    sourceFingerprint: {
      gameRootHash: sha256Ref(`${input.gameId}-root`),
      engineEvidence: [input.assetPath],
    },
    keyRequirements: [
      {
        requirementId: input.requirementId,
        secretRef: input.secretRef,
        kind: input.materialKind,
        bytes: input.bytes,
        validation: {
          method: "decryptHeaderProof",
          proofHash: input.proofHash,
        },
      },
    ],
    archiveParameters: [],
    helperEvidence: {
      helperKind: "staticParser",
      toolVersion: "kaifuu-fixture-generator/0.1.0",
      redactedLogHash: sha256Ref(`${input.gameId}-redacted-log`),
      proofHashes: [
        {
          method: "decryptHeaderProof",
          proofHash: input.proofHash,
        },
      ],
    },
    assets: [
      {
        assetId: `${input.gameId}-asset`,
        path: input.assetPath,
        assetKind: "archive",
        textSurfaces: ["dialogue"],
        sourceHash: sha256Ref(`${input.gameId}-asset`),
        patching: {
          capability: "patching",
          status: "unsupported",
          limitation: "fixture profile exercises key metadata only and does not claim patch-back",
        },
      },
    ],
    capabilities: [
      {
        capability: "key_profile",
        status: "limited",
        limitation: "public fixture-only key profile metadata",
      },
      {
        capability: "patching",
        status: "unsupported",
        limitation: "fixture profile exercises key metadata only and does not claim patch-back",
      },
    ],
    requirements: [
      {
        category: "secret_key",
        key: input.requirementId,
        status: "satisfied",
        description: "fixture-only secret ref placeholder for public validation",
        placeholder: null,
        secret: true,
      },
    ],
    metadata: {
      fixtureOnly: "true",
      generatedBy: "fixtures/generate-kaifuu-encrypted-public-fixtures.mjs",
    },
  };
}

export function helperResult(input) {
  return {
    schemaVersion: "0.1.0",
    fixtureId: input.fixtureId,
    helperResultId: input.helperResultId,
    profileId: "019f0000-0000-7000-8000-kaifuu0510085",
    helper: {
      helperId: input.helperId,
      helperVersion: "0.1.0",
      helperKind: input.helperKind,
    },
    capabilityLevel: capabilityLevelForHelperKind(input.helperKind),
    execution: executionForHelperKind(input.helperKind),
    diagnostic: {
      code: input.code,
      message: input.message,
    },
    redaction: {
      status: input.redactionStatus ?? "redacted",
      redactedLogHash: input.redactedLogHash,
    },
    secretRefs: input.secretRefs ?? [],
    proofHashes: input.proofHashes ?? [],
  };
}

export function executionForHelperKind(helperKind) {
  switch (helperKind) {
    case "knownKeyDatabaseImport":
    case "manualKeyEntry":
      return {
        mode: "notExecuted",
        platform: "fixture-local",
        bounded: true,
        timeoutMs: 1000,
        durationMs: 0,
        networkAccess: false,
        filesystemAccess: "none",
      };
    case "wineLocalWindowsHelper":
      return {
        mode: "platformHelper",
        platform: "wine-fixture",
        bounded: true,
        timeoutMs: 5000,
        durationMs: 0,
        networkAccess: false,
        filesystemAccess: "localGameReadOnly",
      };
    case "remoteWindowsHelper":
      return {
        mode: "remoteHelper",
        platform: "windows-fixture",
        bounded: true,
        timeoutMs: 5000,
        durationMs: 0,
        networkAccess: false,
        filesystemAccess: "localGameReadOnly",
      };
    case "staticParser":
    default:
      return {
        mode: "inProcess",
        platform: "fixture-static",
        bounded: true,
        timeoutMs: 1000,
        durationMs: 0,
        networkAccess: false,
        filesystemAccess: "readOnlyWorkspace",
      };
  }
}

export function capabilityLevelForHelperKind(helperKind) {
  switch (helperKind) {
    case "knownKeyDatabaseImport":
      return "localKeyImport";
    case "manualKeyEntry":
      return "manualEntry";
    case "wineLocalWindowsHelper":
      return "wineLocal";
    case "remoteWindowsHelper":
      return "remoteWindows";
    case "staticParser":
    default:
      return "staticAnalysis";
  }
}

export function bytes(text) {
  return Buffer.from(text, "utf8");
}

export function plainXp3Fixture(entries) {
  const chunks = [];
  chunks.push(Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]));
  chunks.push(leU64(0n));

  const segmentOffsets = [];
  let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  for (const entry of entries) {
    segmentOffsets.push(BigInt(offset));
    chunks.push(entry.payload);
    offset += entry.payload.length;
  }

  const indexOffset = BigInt(offset);
  const indexChunks = [];
  for (const [index, entry] of entries.entries()) {
    const pathBytes = utf16le(entry.path);
    const info = Buffer.concat([
      leU32(0),
      leU64(BigInt(entry.payload.length)),
      leU64(BigInt(entry.payload.length)),
      leU16(pathBytes.length / 2),
      pathBytes,
    ]);
    const segment = Buffer.concat([
      leU32(entry.compressed ? 1 : 0),
      leU64(segmentOffsets[index]),
      leU64(BigInt(entry.payload.length)),
      leU64(BigInt(entry.payload.length)),
    ]);
    indexChunks.push(
      xp3Chunk(
        "File",
        Buffer.concat([
          xp3Chunk("info", info),
          xp3Chunk("segm", segment),
          xp3Chunk("adlr", leU32(entry.adler32)),
        ]),
      ),
    );
  }

  const index = Buffer.concat(indexChunks);
  chunks.push(Buffer.from([0]));
  chunks.push(leU64(BigInt(index.length)));
  chunks.push(index);

  const archive = Buffer.concat(chunks);
  leU64(indexOffset).copy(archive, 11);
  return archive;
}

export function xp3Chunk(name, content) {
  return Buffer.concat([Buffer.from(name, "ascii"), leU64(BigInt(content.length)), content]);
}

export function utf16le(text) {
  const output = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    output.writeUInt16LE(text.charCodeAt(index), index * 2);
  }
  return output;
}

export function leU16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

export function leU32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

export function leU64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

export function sha256Ref(input) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
