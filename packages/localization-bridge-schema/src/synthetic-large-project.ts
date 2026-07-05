import { createHash } from "node:crypto";
import type {
  BridgeAssetV02,
  BridgeBundleV02,
  BridgeSpanV02,
  HashStrategyV02,
  LocalizationUnitV02,
  SourceRevisionV02,
  SurfaceKindV02,
} from "./index.js";

export type SyntheticLargeBridgeOptions = {
  seed?: string;
  targetJapaneseCharacters?: number;
  assetCount?: number;
  sourceLocale?: string;
  targetLocale?: string;
};

export type SyntheticLargeBridgeSummary = {
  bridgeId: string;
  sourceBundleHash: string;
  assetCount: number;
  unitCount: number;
  sourceCharacterCount: number;
  sourceJapaneseCharacterCount: number;
  sourceTextBytes: number;
  protectedSpanCount: number;
  maxSourceTextBytes: number;
};

const DEFAULT_SEED = "UNIV-010-synthetic-large-project-v1";
const DEFAULT_TARGET_JAPANESE_CHARACTERS = 1_050_000;
const DEFAULT_ASSET_COUNT = 96;
const DEFAULT_SOURCE_LOCALE = "ja-JP";
const DEFAULT_TARGET_LOCALE = "en-US";
const BRIDGE_SCHEMA_VERSION_V02 = "0.2.0";
const UUID_PREFIX = "019ed010-0000-7000-8000";

const hashStrategy: HashStrategyV02 = {
  sourceProfile: {
    scope: "source_profile",
    algorithm: "sha256",
    normalization: "utf8-lf-json-stable-v1",
  },
  sourceBundle: {
    scope: "source_bundle",
    algorithm: "sha256",
    normalization: "utf8-lf-json-stable-v1",
  },
  sourceAsset: {
    scope: "source_asset",
    algorithm: "sha256",
    normalization: "bytes",
  },
  sourceUnit: {
    scope: "source_unit",
    algorithm: "sha256",
    normalization: "utf8-lf-json-stable-v1",
    fields: ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
  },
  patchExport: {
    scope: "patch_export",
    algorithm: "sha256",
    normalization: "utf8-lf-json-stable-v1",
  },
  deltaPackage: {
    scope: "delta_package",
    algorithm: "sha256",
    normalization: "utf8-lf-json-stable-v1",
  },
};

export function createSyntheticLargeBridgeBundle(
  options: SyntheticLargeBridgeOptions = {},
): BridgeBundleV02 {
  const seed = options.seed ?? DEFAULT_SEED;
  const targetJapaneseCharacters =
    options.targetJapaneseCharacters ?? DEFAULT_TARGET_JAPANESE_CHARACTERS;
  const assetCount = options.assetCount ?? DEFAULT_ASSET_COUNT;
  const sourceLocale = options.sourceLocale ?? DEFAULT_SOURCE_LOCALE;
  const targetLocale = options.targetLocale ?? DEFAULT_TARGET_LOCALE;

  assertPositiveInteger(targetJapaneseCharacters, "targetJapaneseCharacters");
  assertPositiveInteger(assetCount, "assetCount");

  const sourceProfileHash = sha256("source-profile", seed, sourceLocale, targetLocale);
  const sourceProfileRevision = revision(2, sourceProfileHash);
  const assets = Array.from({ length: assetCount }, (_, index) => syntheticAsset(seed, index));
  const units: LocalizationUnitV02[] = [];
  let sourceJapaneseCharacterCount = 0;

  while (sourceJapaneseCharacterCount < targetJapaneseCharacters) {
    const unit = syntheticUnit({
      seed,
      unitIndex: units.length,
      asset: assets[units.length % assets.length]!,
      sourceLocale,
      targetLocale,
    });
    units.push(unit);
    sourceJapaneseCharacterCount += countJapaneseCharacters(unit.sourceText);
  }

  const sourceBundleHash = sha256(
    "source-bundle",
    seed,
    sourceLocale,
    targetLocale,
    String(assetCount),
    String(units.length),
    String(sourceJapaneseCharacterCount),
    units[0]?.sourceHash ?? "",
    units[units.length - 1]?.sourceHash ?? "",
  );

  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION_V02,
    bridgeId: syntheticUuid(1),
    sourceGame: {
      gameId: "itotori-synthetic-large-project",
      gameVersion: "UNIV-010",
      sourceProfileId: "synthetic-ja-scale-v1",
      sourceProfileRevision,
    },
    sourceBundleHash,
    sourceBundleRevision: revision(3, sourceBundleHash),
    sourceLocale,
    hashStrategy,
    extractor: {
      name: "itotori-synthetic-large-project",
      version: "0.1.0",
    },
    assets,
    units,
    policyRecords: [
      {
        policyRecordId: syntheticUuid(4),
        policyRecordKind: "non_translated_term",
        policyAction: "do_not_translate",
        termKey: "system/player-placeholder",
        sourceText: "{player}",
        targetLocale,
        preserveForm: "{player}",
        scope: "dialogue",
        policyReason: "Synthetic protected placeholder used to verify byte ranges at scale.",
        reviewRequired: false,
      },
    ],
  };
}

export function summarizeSyntheticLargeBridgeBundle(
  bundle: BridgeBundleV02,
): SyntheticLargeBridgeSummary {
  let sourceCharacterCount = 0;
  let sourceJapaneseCharacterCount = 0;
  let sourceTextBytes = 0;
  let protectedSpanCount = 0;
  let maxSourceTextBytes = 0;

  for (const unit of bundle.units) {
    const unitBytes = Buffer.byteLength(unit.sourceText, "utf8");
    sourceCharacterCount += Array.from(unit.sourceText).length;
    sourceJapaneseCharacterCount += countJapaneseCharacters(unit.sourceText);
    sourceTextBytes += unitBytes;
    protectedSpanCount += unit.spans.length;
    maxSourceTextBytes = Math.max(maxSourceTextBytes, unitBytes);
  }

  return {
    bridgeId: bundle.bridgeId,
    sourceBundleHash: bundle.sourceBundleHash,
    assetCount: bundle.assets.length,
    unitCount: bundle.units.length,
    sourceCharacterCount,
    sourceJapaneseCharacterCount,
    sourceTextBytes,
    protectedSpanCount,
    maxSourceTextBytes,
  };
}

export function countJapaneseCharacters(value: string): number {
  let count = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (
      (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
      (codePoint >= 0x3400 && codePoint <= 0x9fff)
    ) {
      count += 1;
    }
  }
  return count;
}

function syntheticAsset(seed: string, assetIndex: number): BridgeAssetV02 {
  const assetNumber = assetIndex + 1;
  const sourceHash = sha256("source-asset", seed, String(assetNumber));
  return {
    assetId: syntheticUuid(0x1000 + assetNumber),
    assetKey: `script/synthetic/scene-${assetNumber.toString().padStart(4, "0")}`,
    assetKind: "script",
    sourceHash,
    sourceRevision: revision(0x2000 + assetNumber, sourceHash),
    path: `scenario/synthetic/scene-${assetNumber.toString().padStart(4, "0")}.ks`,
  };
}

function syntheticUnit(input: {
  seed: string;
  unitIndex: number;
  asset: BridgeAssetV02;
  sourceLocale: string;
  targetLocale: string;
}): LocalizationUnitV02 {
  const unitNumber = input.unitIndex + 1;
  const sourceText = syntheticSourceText(input.unitIndex);
  const spans = syntheticSpans(sourceText, input.unitIndex, input.targetLocale);
  const sourceUnitKey = `${input.asset.assetKey}#line-${unitNumber.toString().padStart(7, "0")}`;
  const sourceHash = sha256(
    "source-unit",
    input.seed,
    input.sourceLocale,
    sourceUnitKey,
    sourceText,
    spans.map((span) => span.raw).join("\0"),
  );
  const surfaceKind = surfaceKindFor(input.unitIndex);
  const sourceRevision = input.asset.sourceRevision;
  const sourceTextBytes = Buffer.byteLength(sourceText, "utf8");

  return {
    bridgeUnitId: syntheticUuid(0x100000 + unitNumber),
    surfaceId: syntheticUuid(0x200000 + unitNumber),
    surfaceKind,
    sourceUnitKey,
    occurrenceId: `synthetic-${unitNumber.toString().padStart(7, "0")}`,
    sourceLocale: input.sourceLocale,
    sourceText,
    sourceHash,
    sourceRevision,
    sourceAssetRef: {
      assetId: input.asset.assetId,
      assetKey: input.asset.assetKey,
    },
    sourceLocation: {
      containerKey: input.asset.assetKey,
      entryPath: ["commands", String(input.unitIndex)],
      range: {
        startByte: input.unitIndex * 1024,
        endByte: input.unitIndex * 1024 + sourceTextBytes,
      },
    },
    ...(surfaceKind === "dialogue"
      ? {
          speaker: {
            knowledgeState: "known",
            speakerId: syntheticUuid(0x300000 + (input.unitIndex % 24) + 1),
            displayName: speakerNameFor(input.unitIndex),
            canonicalNameRef: `character/${speakerKeyFor(input.unitIndex)}`,
          },
        }
      : {}),
    context: {
      route: {
        routeId: syntheticUuid(0x400000 + (input.unitIndex % 16) + 1),
        routeKey: `route-${(input.unitIndex % 16) + 1}`,
        sceneId: syntheticUuid(0x500000 + (input.unitIndex % 512) + 1),
        sceneKey: `scene-${Math.floor(input.unitIndex / 32)
          .toString()
          .padStart(5, "0")}`,
        position: `line-${unitNumber}`,
      },
    },
    policy: {
      policyAction: "localize",
      targetLocale: input.targetLocale,
      policyReason: "Synthetic scale fixture for import, planning, and dashboard performance.",
    },
    spans,
    patchRef: {
      assetId: input.asset.assetId,
      writeMode: "replace",
      sourceUnitKey,
      sourceRevision,
    },
    runtimeExpectation: {
      expectationKind: "trace_text",
      traceKey: `synthetic.trace.${unitNumber.toString().padStart(7, "0")}`,
    },
  };
}

function syntheticSourceText(unitIndex: number): string {
  const chapter = Math.floor(unitIndex / 180) + 1;
  const scene = Math.floor(unitIndex / 30) + 1;
  const variation = unitIndex % 12;
  const protectedText = protectedTextFor(unitIndex);
  const templates = [
    `第${chapter}章の朝、駅前の広場でミナは古い地図を広げ、次の目的地を静かに確認した。${protectedText}仲間たちは風の音を聞きながら、約束の時間まで荷物を整えていた。`,
    `雨上がりの路地には小さな灯りが並び、店主は今日だけの合言葉を低い声で伝えた。${protectedText}その言葉を聞いた瞬間、遠くの鐘が三度鳴った。`,
    `森の奥に残された石碑には、忘れられた王国の名前と旅人への警告が刻まれていた。${protectedText}誰も声を出さず、苔むした階段を一段ずつ下りていった。`,
    `港の市場では香辛料と焼き菓子の匂いが混ざり、子どもたちが新しい船の噂を楽しそうに話していた。${protectedText}船長は羅針盤を握りしめて空を見上げた。`,
    `古書館の閲覧室で管理人は封じられた記録を取り出し、ページの余白に残る細い注釈を指でなぞった。${protectedText}そこには次の扉を開く条件が書かれていた。`,
    `雪の峠を越える前に、一行は凍った湖のそばで焚き火を囲み、失われた村の歌を思い出していた。${protectedText}炎が揺れるたび、影は別の形に変わった。`,
    `地下工房では歯車が規則正しく回り、技師は試作機の表示盤に現れた数字を何度も確認した。${protectedText}成功すれば封鎖された門を動かせるはずだった。`,
    `祝祭の夜、広場の舞台では仮面をつけた踊り手が輪になり、観客は手拍子で古い物語の続きを迎えた。${protectedText}月明かりが旗の金糸を照らしていた。`,
    `砂丘の向こうから隊商が戻ると、見張り台の鐘が鳴り、町の記録係は積み荷の封印を一つずつ確かめた。${protectedText}最後の箱だけが不思議な熱を帯びていた。`,
    `研究棟の温室では青い花が夜だけ開き、助手は観測帳に細かな変化を書き留めていた。${protectedText}花びらの模様は星図と同じ並びを示していた。`,
    `城壁の上で兵士たちは霧の流れを読み、伝令は新しい作戦書を胸に抱えて走った。${protectedText}夜明けまでに橋を守り抜く必要があった。`,
    `静かな神殿で巫女は水面に映る影を見つめ、訪れた旅人へ選ばれた道の重さを告げた。${protectedText}その声は石の柱に柔らかく反響した。`,
  ];
  return `${templates[variation]!}記録番号${scene}。`;
}

function protectedTextFor(unitIndex: number): string {
  if (unitIndex % 15 === 0) {
    return " {player} ";
  }
  if (unitIndex % 22 === 0) {
    return " [wait] ";
  }
  if (unitIndex % 37 === 0) {
    return " {item_name} ";
  }
  return "";
}

function syntheticSpans(
  sourceText: string,
  unitIndex: number,
  targetLocale: string,
): BridgeSpanV02[] {
  const raws = ["{player}", "[wait]", "{item_name}"];
  const spans: BridgeSpanV02[] = [];
  for (const raw of raws) {
    const byteStart = Buffer.from(sourceText, "utf8").indexOf(raw);
    if (byteStart < 0) {
      continue;
    }
    const spanKind = raw.startsWith("[") ? "control_markup" : "variable_placeholder";
    spans.push({
      spanId: syntheticUuid(0x600000 + unitIndex * 8 + spans.length + 1),
      spanKind,
      raw,
      startByte: byteStart,
      endByte: byteStart + Buffer.byteLength(raw, "utf8"),
      preserveMode: spanKind === "control_markup" ? "exact" : "map",
      ...(spanKind === "variable_placeholder"
        ? {
            variableName: raw.slice(1, -1),
            policy: {
              policyAction: "do_not_translate",
              targetLocale,
              targetText: raw,
              policyReason: "Synthetic placeholder must survive planning and queue payloads.",
            },
          }
        : {}),
    });
  }
  return spans;
}

function surfaceKindFor(unitIndex: number): SurfaceKindV02 {
  return unitIndex % 5 === 0 ? "dialogue" : "narration";
}

function speakerNameFor(unitIndex: number): string {
  const speakers = ["ミナ", "ソラ", "レン", "アキ", "ユイ", "ナギ"];
  return speakers[unitIndex % speakers.length]!;
}

function speakerKeyFor(unitIndex: number): string {
  return `synthetic-${(unitIndex % 6) + 1}`;
}

function revision(id: number, value: string): SourceRevisionV02 {
  return {
    revisionId: syntheticUuid(id),
    revisionKind: "content_hash",
    value,
  };
}

function sha256(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function syntheticUuid(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffffffff) {
    throw new Error(`synthetic UUID id is out of range: ${id}`);
  }
  return `${UUID_PREFIX}-${id.toString(16).padStart(12, "0")}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}
