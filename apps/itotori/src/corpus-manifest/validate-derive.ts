import {
  resolveCorpusValidationAdapter,
  type AnyCorpusValidationAdapter,
  type CorpusValidationEvidenceConventions,
} from "./corpus-validation-registry.js";
import {
  sha256Bytes,
  stableJson,
  type CorpusEvidence,
  type CorpusManifest,
  type CorpusOutputScope,
  type CorpusUnit,
  type FileFingerprint,
  type ProtectedSkeleton,
  type ProtectedSpanPart,
  type RedactedTextPart,
  type ScopedScene,
} from "./manifest.js";
import {
  array,
  finiteNumber,
  integer,
  nativeString,
  nullableInteger,
  nullableNativeString,
  record,
  sha256,
  sourceInputFingerprint,
  type JsonRecord,
} from "./validate-primitives.js";

export function deriveEvidenceFromOutputs(input: {
  manifest: CorpusManifest;
  adapter: AnyCorpusValidationAdapter;
  inputs: CorpusEvidence["inputs"];
  fullBridgeFingerprint: FileFingerprint;
  scopedBridgeFingerprint: FileFingerprint;
  structureFingerprint: FileFingerprint;
  fullBridge: unknown;
  fullReport: unknown;
  scopedBridge: unknown;
  scopedReport: unknown;
  structure: unknown;
}): Pick<CorpusManifest, "corpus" | "outputScope"> {
  const fullBridge = record(input.fullBridge, "full bridge");
  const fullReport = record(input.fullReport, "full decompile report");
  const scopedBridge = record(input.scopedBridge, "scoped bridge");
  const scopedReport = record(input.scopedReport, "scoped decompile report");
  const structure = record(input.structure, "full structure");
  const fullUnits = array(fullBridge.units, "full bridge.units").map((unit, index) =>
    record(unit, `full bridge.units[${index}]`),
  );
  const routeSceneKeys = new Set(
    fullUnits.map((unit, index) =>
      nativeString(
        record(record(unit.context, `full bridge.units[${index}].context`).route, "route").sceneKey,
        `full bridge.units[${index}].context.route.sceneKey`,
      ),
    ),
  );
  const scopedScene = summarizeStructure(structure, input.manifest.outputScope.sceneId);
  const units = deriveScopedUnits(
    scopedBridge,
    input.manifest.outputScope.sceneId,
    scopedScene.dispatchIndex,
    input.adapter.evidence,
  );
  const unitIds = new Set(units.map((unit) => unit.bridgeUnitId));
  const sourceHashes = new Set(units.map((unit) => unit.sourceHash));

  const corpus: CorpusEvidence = {
    corpusId: input.manifest.corpus.corpusId,
    gameId: input.manifest.corpus.gameId,
    gameVersion: input.manifest.corpus.gameVersion,
    sourceProfileId: input.manifest.corpus.sourceProfileId,
    engine: input.manifest.corpus.engine,
    sourceLocale: input.manifest.corpus.sourceLocale,
    inputs: input.inputs,
    fullGame: {
      kaifuuDecode: {
        schemaVersion: nativeString(fullBridge.schemaVersion, "full bridge.schemaVersion"),
        bridgeExport: input.fullBridgeFingerprint,
        sourceBundleHash: sha256(fullBridge.sourceBundleHash, "full bridge.sourceBundleHash"),
        assetCount: array(fullBridge.assets, "full bridge.assets").length,
        unitCount: fullUnits.length,
        routeSceneCount: routeSceneKeys.size,
        decompile: {
          schemaVersion: nativeString(fullReport.schemaVersion, "full report.schemaVersion"),
          scope: nativeString(fullReport.scope, "full report.scope"),
          sceneCount: finiteNumber(fullReport.sceneCount, "full report.sceneCount"),
          totalOpcodes: finiteNumber(fullReport.totalOpcodes, "full report.totalOpcodes"),
          recognizedOpcodes: finiteNumber(
            fullReport.recognizedOpcodes,
            "full report.recognizedOpcodes",
          ),
          unknownOpcodes: finiteNumber(fullReport.unknownOpcodes, "full report.unknownOpcodes"),
          sourceSeenSha256: sha256(fullReport.sourceSeenSha256, "full report.sourceSeenSha256"),
        },
      },
      utsushiStructure: {
        schemaVersion: nativeString(structure.schemaVersion, "full structure.schemaVersion"),
        structureExport: input.structureFingerprint,
        entryScene: finiteNumber(structure.entryScene, "full structure.entryScene"),
        sceneCount: array(structure.scenes, "full structure.scenes").length,
        dispatchOrderCount: array(structure.sceneDispatchOrder, "full structure.sceneDispatchOrder")
          .length,
        messageCount: scopedScene.totalMessageCount,
        choiceCount: scopedScene.totalChoiceCount,
        speakerCount: scopedScene.speakerCount,
        scopedScene: scopedScene.value,
      },
    },
  };
  const outputScope: CorpusOutputScope = {
    scopeId: input.manifest.outputScope.scopeId,
    sceneId: input.manifest.outputScope.sceneId,
    ordinalRange: input.manifest.outputScope.ordinalRange,
    bridge: {
      schemaVersion: nativeString(scopedBridge.schemaVersion, "scoped bridge.schemaVersion"),
      bridgeExport: input.scopedBridgeFingerprint,
      sourceBundleHash: sha256(scopedBridge.sourceBundleHash, "scoped bridge.sourceBundleHash"),
      decompile: {
        schemaVersion: nativeString(scopedReport.schemaVersion, "scoped report.schemaVersion"),
        sceneId: finiteNumber(scopedReport.sceneId, "scoped report.sceneId"),
        totalOpcodes: finiteNumber(scopedReport.totalOpcodes, "scoped report.totalOpcodes"),
        recognizedOpcodes: finiteNumber(
          scopedReport.recognizedOpcodes,
          "scoped report.recognizedOpcodes",
        ),
        unknownOpcodes: finiteNumber(scopedReport.unknownOpcodes, "scoped report.unknownOpcodes"),
        sourceSeenSha256: sha256(scopedReport.sourceSeenSha256, "scoped report.sourceSeenSha256"),
      },
      unitCount: units.length,
      uniqueBridgeUnitIdCount: unitIds.size,
      uniqueSourceHashCount: sourceHashes.size,
      unitsProjectionSha256: sha256Bytes(stableJson(units)),
    },
    units,
  };

  const sourceInput = sourceInputFingerprint(
    corpus.inputs,
    resolveCorpusValidationAdapter(input.manifest.corpus.engine),
  );
  if (
    corpus.fullGame.kaifuuDecode.decompile.unknownOpcodes !== 0 ||
    outputScope.bridge.decompile.unknownOpcodes !== 0 ||
    sourceInput.sha256 !== corpus.fullGame.kaifuuDecode.decompile.sourceSeenSha256 ||
    sourceInput.sha256 !== outputScope.bridge.decompile.sourceSeenSha256
  ) {
    throw new Error("private corpus decoder report rejected");
  }
  return { corpus, outputScope };
}

function summarizeStructure(
  structure: JsonRecord,
  scopedSceneId: number,
): {
  value: ScopedScene;
  totalMessageCount: number;
  totalChoiceCount: number;
  speakerCount: number;
  dispatchIndex: number;
} {
  const scenes = array(structure.scenes, "full structure.scenes").map((scene, index) =>
    record(scene, `full structure.scenes[${index}]`),
  );
  const dispatchOrder = array(
    structure.sceneDispatchOrder,
    "full structure.sceneDispatchOrder",
  ).map((scene, index) => integer(scene, `full structure.sceneDispatchOrder[${index}]`));
  const sceneIds = scenes.map((scene, index) =>
    integer(scene.sceneId, `full structure.scenes[${index}].sceneId`),
  );
  if (
    new Set(sceneIds).size !== sceneIds.length ||
    new Set(dispatchOrder).size !== dispatchOrder.length ||
    sceneIds.length !== dispatchOrder.length ||
    sceneIds.some((sceneId) => !dispatchOrder.includes(sceneId))
  ) {
    throw new Error("private corpus structure dispatch is inconsistent");
  }
  const dispatchIndex = dispatchOrder.indexOf(scopedSceneId);
  const scopedScene = scenes.find((scene) => scene.sceneId === scopedSceneId);
  if (scopedScene === undefined || dispatchIndex < 0) {
    throw new Error("private corpus structure is missing the manifest scoped scene");
  }

  let totalMessageCount = 0;
  let totalChoiceCount = 0;
  const speakers = new Set<string>();
  for (const [sceneIndex, scene] of scenes.entries()) {
    const messages = array(scene.messages, `full structure.scenes[${sceneIndex}].messages`);
    totalMessageCount += messages.length;
    totalChoiceCount += array(scene.choices, `full structure.scenes[${sceneIndex}].choices`).length;
    for (const [messageIndex, message] of messages.entries()) {
      const speaker = record(
        message,
        `full structure.scenes[${sceneIndex}].messages[${messageIndex}]`,
      ).speaker;
      if (speaker !== null) speakers.add(nativeString(speaker, "full structure message.speaker"));
    }
  }
  const scopedMessages = array(scopedScene.messages, "scoped structure.messages");
  const scopedChoices = array(scopedScene.choices, "scoped structure.choices");
  const value: ScopedScene = {
    sceneId: scopedSceneId,
    messageCount: scopedMessages.length,
    choiceCount: scopedChoices.length,
    nextScene: nullableInteger(scopedScene.nextScene, "scoped structure.nextScene"),
    selectionControl: nativeString(
      scopedScene.selectionControl,
      "scoped structure.selectionControl",
    ),
    dispatchFanoutScenes: array(
      scopedScene.dispatchFanoutScenes,
      "scoped structure.dispatchFanoutScenes",
    ).map((scene, index) => integer(scene, `scoped structure.dispatchFanoutScenes[${index}]`)),
    dispatchIndex,
  };
  return { value, totalMessageCount, totalChoiceCount, speakerCount: speakers.size, dispatchIndex };
}

function deriveScopedUnits(
  bridge: JsonRecord,
  sceneId: number,
  structureDispatchIndex: number,
  evidence: CorpusValidationEvidenceConventions,
): CorpusUnit[] {
  return array(bridge.units, "scoped bridge.units").map((rawUnit, index) => {
    const unit = record(rawUnit, `scoped bridge.units[${index}]`);
    const sourceLocation = record(
      unit.sourceLocation,
      `scoped bridge.units[${index}].sourceLocation`,
    );
    const range = record(
      sourceLocation.range,
      `scoped bridge.units[${index}].sourceLocation.range`,
    );
    const context = record(unit.context, `scoped bridge.units[${index}].context`);
    const route = record(context.route, `scoped bridge.units[${index}].context.route`);
    const expectation = record(
      unit.runtimeExpectation,
      `scoped bridge.units[${index}].runtimeExpectation`,
    );
    const sourceRevision = record(
      unit.sourceRevision,
      `scoped bridge.units[${index}].sourceRevision`,
    );
    const byteLocation = {
      containerKey: nativeString(sourceLocation.containerKey, "scoped bridge source container"),
      entryPath: array(sourceLocation.entryPath, "scoped bridge source entryPath").map(
        (entry, entryIndex) => nativeString(entry, `scoped bridge source entryPath[${entryIndex}]`),
      ),
      range: {
        startByte: integer(range.startByte, "scoped bridge source range start"),
        endByte: integer(range.endByte, "scoped bridge source range end"),
      },
    };
    if (byteLocation.range.endByte <= byteLocation.range.startByte) {
      throw new Error("private corpus unit has a non-positive source range");
    }
    const sourceText = nativeString(unit.sourceText, "scoped bridge source text");
    return {
      bridgeUnitId: nativeString(unit.bridgeUnitId, "scoped bridge unit id"),
      sourceUnitKey: nativeString(unit.sourceUnitKey, "scoped bridge source key"),
      occurrenceId: nativeString(unit.occurrenceId, "scoped bridge occurrence id"),
      surfaceKind: nativeString(unit.surfaceKind, "scoped bridge surface kind"),
      sourceHash: sha256(unit.sourceHash, "scoped bridge source hash"),
      sourceRevision: {
        revisionId: nativeString(sourceRevision.revisionId, "scoped bridge revision id"),
        revisionKind: nativeString(sourceRevision.revisionKind, "scoped bridge revision kind"),
        value: sha256(sourceRevision.value, "scoped bridge revision value"),
      },
      byteLocation,
      protectedSkeleton: buildProtectedSkeleton(
        sourceText,
        unit.spans,
        byteLocation.range,
        evidence,
      ),
      route: {
        sceneKey: nativeString(route.sceneKey, "scoped bridge route scene"),
        position: nativeString(route.position, "scoped bridge route position"),
      },
      sceneMembership: { sceneId, structureDispatchIndex },
      replayTarget: {
        expectationKind: nativeString(
          expectation.expectationKind,
          "scoped bridge expectation kind",
        ),
        traceKey: nativeString(expectation.traceKey, "scoped bridge trace key"),
      },
    } satisfies CorpusUnit;
  });
}

function buildProtectedSkeleton(
  sourceText: string,
  spansValue: unknown,
  sourceRange: { startByte: number; endByte: number },
  evidence: CorpusValidationEvidenceConventions,
): ProtectedSkeleton {
  const sourceLength = Buffer.byteLength(sourceText, "utf8");
  const spans = array(spansValue, "scoped bridge spans").map((rawSpan, index) => {
    const span = record(rawSpan, `scoped bridge spans[${index}]`);
    const startByte = integer(span.startByte, "scoped bridge span start");
    const endByte = integer(span.endByte, "scoped bridge span end");
    const raw = nativeString(span.raw, "scoped bridge span raw");
    if (
      startByte < 0 ||
      endByte <= startByte ||
      endByte > sourceLength ||
      Buffer.byteLength(raw, "utf8") !== endByte - startByte
    ) {
      throw new Error("private corpus protected-span range is invalid");
    }
    return {
      spanIndex: index,
      spanKind: nativeString(span.spanKind, "scoped bridge span kind"),
      parsedName: nullableNativeString(span.parsedName, "scoped bridge parsed span name"),
      startByte,
      endByte,
      rawSha256: sha256Bytes(raw),
      preserveMode: nativeString(span.preserveMode, "scoped bridge span preservation"),
      outOfBand: span.outOfBand === true,
    };
  });
  if (spans.some((span, index) => index > 0 && span.startByte < spans[index - 1]!.endByte)) {
    throw new Error("private corpus protected spans overlap or are out of order");
  }
  const parts: Array<RedactedTextPart | ProtectedSpanPart> = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.startByte > cursor) {
      parts.push({
        kind: "redacted_text",
        startByte: cursor,
        endByte: span.startByte,
        utf8ByteLength: span.startByte - cursor,
      });
    }
    parts.push({
      kind: "protected_span",
      spanIndex: span.spanIndex,
      spanKind: span.spanKind,
      parsedName: span.parsedName,
      startByte: span.startByte,
      endByte: span.endByte,
      utf8ByteLength: span.endByte - span.startByte,
      rawSha256: span.rawSha256,
      preserveMode: span.preserveMode,
      outOfBand: span.outOfBand,
    });
    cursor = span.endByte;
  }
  if (cursor < sourceLength) {
    parts.push({
      kind: "redacted_text",
      startByte: cursor,
      endByte: sourceLength,
      utf8ByteLength: sourceLength - cursor,
    });
  }
  return {
    format: "itotori.redacted-sjis-protected-shell.v1",
    sourceEncoding: evidence.sourceEncoding,
    sourceTextUtf8ByteLength: sourceLength,
    decompressedSourceByteLength: sourceRange.endByte - sourceRange.startByte,
    shell: parts
      .map((part) =>
        part.kind === "redacted_text"
          ? `<REDACTED_TEXT:utf8=${part.utf8ByteLength}>`
          : `<PROTECTED:${part.parsedName ?? part.spanKind}:utf8=${part.utf8ByteLength}>`,
      )
      .join(""),
    parts,
  };
}
