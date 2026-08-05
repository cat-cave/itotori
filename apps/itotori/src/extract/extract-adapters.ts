import { optionalFlag, requiredFlag } from "../cli/flags.js";
import { EXTRACT_CAPABILITIES } from "./extract-adapter-capabilities.js";
import { REALLIVE_SCENE_ID_MAX, type ExtractAdapter } from "./extract-adapter-types.js";
import {
  assertCapabilityPayload,
  optionalApiScene,
  optionalApiString,
  parseRealliveSceneId,
  parseRealliveSceneSet,
  parseRealliveUnitRange,
  requiredApiString,
} from "./extract-adapter-validation.js";

export const realliveExtractAdapter: ExtractAdapter<"reallive"> = {
  engine: "reallive",
  capability: EXTRACT_CAPABILITIES.reallive,
  buildArgs(args) {
    const out: string[] = ["extract", "--engine", "reallive"];
    if (args.vaultCanonicalId !== undefined && args.vaultCanonicalId.length > 0)
      out.push("--vault-canonical-id", args.vaultCanonicalId);
    if (args.gameRoot !== undefined && args.gameRoot.length > 0)
      out.push("--game-root", args.gameRoot);
    out.push(
      "--game-id",
      args.gameId,
      "--game-version",
      args.gameVersion,
      "--source-profile-id",
      args.sourceProfileId,
      "--source-locale",
      args.sourceLocale,
    );
    if (args.wholeSeen === true) out.push("--scope", "all");
    else if (args.scene !== undefined)
      out.push("--scope", "unit-set", "--unit-ids", String(args.scene));
    else if (args.scenes !== undefined)
      out.push("--scope", "unit-set", "--unit-ids", args.scenes.join(","));
    else if (args.unitRange !== undefined)
      out.push(
        "--scope",
        "unit-range",
        "--start",
        String(args.unitRange.start),
        "--end-exclusive",
        String(args.unitRange.endExclusive),
      );
    out.push("--bundle-output", args.bundleOutputPath);
    if (args.decompileReportOutputPath !== undefined)
      out.push("--decompile-report-output", args.decompileReportOutputPath);
    return out;
  },
  validate(args, _env) {
    const scopeCount = [
      args.wholeSeen === true,
      args.scene !== undefined,
      args.scenes !== undefined,
      args.unitRange !== undefined,
    ].filter(Boolean).length;
    if (scopeCount !== 1)
      throw new Error(
        "kaifuu extract refused: choose exactly one scope: --scene, --scenes, --unit-range, or --whole-seen",
      );
    if (
      args.scene !== undefined &&
      (!Number.isInteger(args.scene) || args.scene < 0 || args.scene > REALLIVE_SCENE_ID_MAX)
    ) {
      throw new Error(
        `kaifuu extract refused: --scene '${String(args.scene)}' must be a u16 (0..${REALLIVE_SCENE_ID_MAX})`,
      );
    }
    if (
      args.scenes?.some(
        (scene) => !Number.isInteger(scene) || scene < 0 || scene > REALLIVE_SCENE_ID_MAX,
      )
    ) {
      throw new Error("kaifuu extract refused: every --scenes value must be a u16");
    }
    if (
      args.unitRange !== undefined &&
      (!Number.isInteger(args.unitRange.start) ||
        !Number.isInteger(args.unitRange.endExclusive) ||
        args.unitRange.start < 0 ||
        args.unitRange.start >= args.unitRange.endExclusive)
    ) {
      throw new Error(
        "kaifuu extract refused: --unit-range must have non-negative START:END with START < END",
      );
    }
    const hasVault = args.vaultCanonicalId !== undefined && args.vaultCanonicalId.length > 0;
    const hasGameRoot = args.gameRoot !== undefined && args.gameRoot.length > 0;
    if (!hasVault && !hasGameRoot) {
      throw new Error(
        "kaifuu extract refused: sourcing requires --vault-canonical-id <ID> or --game-root <PATH>",
      );
    }
  },
  mode(args) {
    if (args.wholeSeen === true) return "whole-seen";
    if (args.scenes !== undefined) return "scene-set";
    if (args.unitRange !== undefined) return "unit-range";
    return "per-scene";
  },
  parseCli(args) {
    const wholeSeen = args.includes("--whole-seen");
    const sceneTokenPresent = args.includes("--scene");
    const scenesRaw = optionalFlag(args, "--scenes");
    const unitRangeRaw = optionalFlag(args, "--unit-range");
    const sceneRaw = optionalFlag(args, "--scene");
    if (sceneTokenPresent && sceneRaw === undefined)
      throw new Error(
        "extract refused: --scene requires a numeric value (0..65535, e.g. --scene 6010)",
      );
    if (
      [wholeSeen, sceneTokenPresent, scenesRaw !== undefined, unitRangeRaw !== undefined].filter(
        Boolean,
      ).length !== 1
    ) {
      throw new Error(
        "extract refused: choose exactly one scope: --scene, --scenes, --unit-range, or --whole-seen",
      );
    }
    const gameRoot = optionalFlag(args, "--game-root");
    const vaultCanonicalId = optionalFlag(args, "--vault-canonical-id");
    const decompileReportOutputPath = optionalFlag(args, "--decompile-report-output");
    return {
      engine: "reallive",
      gameId: requiredFlag(args, "--game-id"),
      gameVersion: requiredFlag(args, "--game-version"),
      sourceProfileId: requiredFlag(args, "--source-profile-id"),
      sourceLocale: requiredFlag(args, "--source-locale"),
      ...(wholeSeen ? { wholeSeen: true } : {}),
      ...(sceneRaw !== undefined ? { scene: parseRealliveSceneId(sceneRaw) } : {}),
      ...(scenesRaw !== undefined ? { scenes: parseRealliveSceneSet(scenesRaw) } : {}),
      ...(unitRangeRaw !== undefined ? { unitRange: parseRealliveUnitRange(unitRangeRaw) } : {}),
      ...(gameRoot !== undefined ? { gameRoot } : {}),
      ...(vaultCanonicalId !== undefined ? { vaultCanonicalId } : {}),
      ...(decompileReportOutputPath !== undefined ? { decompileReportOutputPath } : {}),
    };
  },
  parseApi(input) {
    assertCapabilityPayload(EXTRACT_CAPABILITIES.reallive, input);
    const vaultCanonicalId = optionalApiString(input, "vaultCanonicalId");
    const gameRoot = optionalApiString(input, "gameRoot");
    const wholeSeen = input.wholeSeen === true;
    const scene = optionalApiScene(input, "scene");
    if (wholeSeen === (scene !== undefined))
      throw new Error(
        "ApiProjectDecodeExtractRequest for reallive requires exactly one mode: scene or wholeSeen",
      );
    if (input.wholeSeen !== undefined && input.wholeSeen !== true)
      throw new Error("ApiProjectDecodeExtractRequest.wholeSeen must be true when supplied");
    return {
      engine: "reallive",
      gameId: requiredApiString(input, "gameId"),
      gameVersion: requiredApiString(input, "gameVersion"),
      sourceProfileId: requiredApiString(input, "sourceProfileId"),
      sourceLocale: requiredApiString(input, "sourceLocale"),
      ...(vaultCanonicalId !== undefined ? { vaultCanonicalId } : {}),
      ...(gameRoot !== undefined ? { gameRoot } : {}),
      ...(scene !== undefined ? { scene } : {}),
      ...(wholeSeen ? { wholeSeen: true } : {}),
    };
  },
};

export const softpalExtractAdapter: ExtractAdapter<"softpal"> = {
  engine: "softpal",
  capability: EXTRACT_CAPABILITIES.softpal,
  buildArgs(args) {
    const out: string[] = ["extract", "--engine", "softpal"];
    if (args.gameRoot !== undefined && args.gameRoot.length > 0)
      out.push("--game-root", args.gameRoot);
    out.push("--scope", "all", "--bundle-output", args.bundleOutputPath);
    return out;
  },
  validate(args, _env) {
    const hasGameRoot = args.gameRoot !== undefined && args.gameRoot.length > 0;
    if (!hasGameRoot)
      throw new Error(
        "kaifuu extract (softpal) refused: sourcing requires a game root — pass gameRoot",
      );
  },
  mode() {
    return "whole-game";
  },
  parseCli(args) {
    if (args.includes("--scene") || args.includes("--whole-seen"))
      throw new Error(
        "extract refused: --engine softpal is whole-game; --scene / --whole-seen are RealLive-only",
      );
    const gameRoot = optionalFlag(args, "--game-root");
    return { engine: "softpal", ...(gameRoot !== undefined ? { gameRoot } : {}) };
  },
  parseApi(input) {
    assertCapabilityPayload(EXTRACT_CAPABILITIES.softpal, input);
    return { engine: "softpal", gameRoot: requiredApiString(input, "gameRoot") };
  },
};

export const rpgMakerExtractAdapter: ExtractAdapter<"rpg-maker"> = {
  engine: "rpg-maker",
  capability: EXTRACT_CAPABILITIES["rpg-maker"],
  buildArgs(args) {
    const out: string[] = ["extract", "--engine", "rpg-maker"];
    if (args.gameDir !== undefined && args.gameDir.length > 0)
      out.push("--game-root", args.gameDir);
    out.push(
      "--game-id",
      args.gameId,
      "--game-version",
      args.gameVersion,
      "--source-profile-id",
      args.sourceProfileId,
      "--source-locale",
      args.sourceLocale,
      "--scope",
      "all",
      "--bundle-output",
      args.bundleOutputPath,
    );
    if (args.findingsOutputPath !== undefined && args.findingsOutputPath.length > 0)
      out.push("--findings-output", args.findingsOutputPath);
    return out;
  },
  validate(args, _env) {
    const hasGameDir = args.gameDir !== undefined && args.gameDir.length > 0;
    if (!hasGameDir)
      throw new Error(
        "kaifuu extract (rpg-maker) refused: sourcing requires a game root — pass gameRoot",
      );
  },
  mode() {
    return "whole-game";
  },
  parseCli(args) {
    if (args.includes("--game-dir"))
      throw new Error("extract refused: --game-dir is not supported; use --game-root <PATH>");
    if (args.includes("--scene") || args.includes("--whole-seen"))
      throw new Error(
        "extract refused: --engine rpg-maker is whole-game; --scene / --whole-seen are RealLive-only",
      );
    const scope = requiredFlag(args, "--scope");
    if (scope !== "all")
      throw new Error("extract refused: --engine rpg-maker supports only --scope all");
    const gameDir = optionalFlag(args, "--game-root");
    const findingsOutputPath = optionalFlag(args, "--findings-output");
    return {
      engine: "rpg-maker",
      gameId: requiredFlag(args, "--game-id"),
      gameVersion: requiredFlag(args, "--game-version"),
      sourceProfileId: requiredFlag(args, "--source-profile-id"),
      sourceLocale: requiredFlag(args, "--source-locale"),
      ...(gameDir !== undefined ? { gameDir } : {}),
      ...(findingsOutputPath !== undefined ? { findingsOutputPath } : {}),
    };
  },
  parseApi(input) {
    assertCapabilityPayload(EXTRACT_CAPABILITIES["rpg-maker"], input);
    return {
      engine: "rpg-maker",
      gameDir: requiredApiString(input, "gameDir"),
      gameId: requiredApiString(input, "gameId"),
      gameVersion: requiredApiString(input, "gameVersion"),
      sourceProfileId: requiredApiString(input, "sourceProfileId"),
      sourceLocale: requiredApiString(input, "sourceLocale"),
    };
  },
};

export const siglusExtractAdapter: ExtractAdapter<"siglus"> = {
  engine: "siglus",
  capability: EXTRACT_CAPABILITIES.siglus,
  buildArgs(args) {
    const out: string[] = ["extract", "--engine", "siglus"];
    if (args.vaultCanonicalId !== undefined && args.vaultCanonicalId.length > 0)
      out.push("--vault-canonical-id", args.vaultCanonicalId);
    if (args.gameRoot !== undefined && args.gameRoot.length > 0)
      out.push("--game-root", args.gameRoot);
    out.push(
      "--game-id",
      args.gameId,
      "--game-version",
      args.gameVersion,
      "--source-profile-id",
      args.sourceProfileId,
      "--source-locale",
      args.sourceLocale,
      "--scope",
      "all",
      "--bundle-output",
      args.bundleOutputPath,
    );
    return out;
  },
  validate(args, _env) {
    const hasVault = args.vaultCanonicalId !== undefined && args.vaultCanonicalId.length > 0;
    const hasGameRoot = args.gameRoot !== undefined && args.gameRoot.length > 0;
    if (hasVault && hasGameRoot)
      throw new Error(
        "kaifuu extract (siglus) refused: provide either a vault canonical id or game root, not both",
      );
    if (!hasVault && !hasGameRoot)
      throw new Error(
        "kaifuu extract (siglus) refused: sourcing requires --vault-canonical-id <ID> or --game-root <PATH>",
      );
  },
  mode() {
    return "whole-game";
  },
  parseCli(args) {
    if (args.includes("--cipher-method")) {
      throw new Error(
        "extract refused: --cipher-method is not a Siglus input; the decoder selects its supported format profile",
      );
    }
    if (args.includes("--scene") || args.includes("--whole-seen"))
      throw new Error(
        "extract refused: --engine siglus is whole-game; --scene / --whole-seen are not supported",
      );
    const gameRoot = optionalFlag(args, "--game-root");
    const vaultCanonicalId = optionalFlag(args, "--vault-canonical-id");
    return {
      engine: "siglus",
      gameId: requiredFlag(args, "--game-id"),
      gameVersion: requiredFlag(args, "--game-version"),
      sourceProfileId: requiredFlag(args, "--source-profile-id"),
      sourceLocale: requiredFlag(args, "--source-locale"),
      ...(gameRoot !== undefined ? { gameRoot } : {}),
      ...(vaultCanonicalId !== undefined ? { vaultCanonicalId } : {}),
    };
  },
  parseApi(input) {
    assertCapabilityPayload(EXTRACT_CAPABILITIES.siglus, input);
    const vaultCanonicalId = optionalApiString(input, "vaultCanonicalId");
    const gameRoot = optionalApiString(input, "gameRoot");
    return {
      engine: "siglus",
      gameId: requiredApiString(input, "gameId"),
      gameVersion: requiredApiString(input, "gameVersion"),
      sourceProfileId: requiredApiString(input, "sourceProfileId"),
      sourceLocale: requiredApiString(input, "sourceLocale"),
      ...(vaultCanonicalId !== undefined ? { vaultCanonicalId } : {}),
      ...(gameRoot !== undefined ? { gameRoot } : {}),
    };
  },
};
