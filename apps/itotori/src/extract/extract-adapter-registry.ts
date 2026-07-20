// extract-adapter-registry — the engine-discriminated extract dispatch table.
//
// Every `itotori extract` (CLI, Studio decode/extract runner, corpus-manifest
// validation, patchback input loader) resolves an ADAPTER from this registry by
// the request's REQUIRED `engine` discriminant, then delegates argv construction,
// pre-spawn validation, mode reporting, and user-shaped CLI flag parsing to that
// adapter. There is NO default engine: an omitted or unregistered engine is
// REJECTED at the boundary (`resolveExtractAdapter` throws) rather than silently
// becoming RealLive. Adding an engine is a single registry entry — no caller
// grows another `if engine` dispatch branch, and CLI/API availability is derived
// from the registered capabilities.
//
// Each adapter OWNS its validated source + identity inputs (a typed per-engine
// `*ExtractSource`); the shared spawn orchestration (`runKaifuuExtract`, in
// `kaifuu-extract-seam`) is engine-agnostic. Output is always the common
// `BridgeBundleV02` the localize consumer ingests, regardless of engine.

import type { NativeCliProcessResult } from "../native-bin/cli-bin-resolver.js";
import { optionalFlag, requiredFlag } from "../cli/flags.js";

/** The native-process result the injectable `runProcess` seam returns. */
export type KaifuuProcessResult = NativeCliProcessResult;

/** The extract shapes a produced bridge can represent. */
export type ExtractMode = "per-scene" | "whole-seen" | "whole-game";

/** The highest scene id RealLive's u16 scene directory can address. */
export const REALLIVE_SCENE_ID_MAX = 65_535;

// ---------------------------------------------------------------------------
// Per-engine SOURCE inputs — identity + sourcing + mode, no process concerns.
// These are what a decode/extract REQUEST carries; the process-level fields
// (`bundleOutputPath`, `env`, `runProcess`, `log`) are added by the seam.
// ---------------------------------------------------------------------------

/**
 * The sourcing + identity inputs a RealLive extract needs. The four identity
 * fields mirror kaifuu-cli's `required_reallive_metadata_flag` (`--game-id` /
 * `--game-version` / `--source-profile-id` / `--source-locale`); sourcing is
 * EITHER by-id through the read-only vault OR a raw game root. Mode is per-scene
 * (`scene`, u16) XOR whole-Seen (`wholeSeen`).
 */
export type RealliveExtractSource = {
  engine: "reallive";
  /** Sourcing (alpha production): resolve the corpus by-id through the vault. */
  vaultCanonicalId?: string;
  /**
   * Sourcing (raw-path helper): a game root containing REALLIVEDATA/Seen.txt.
   * When omitted, kaifuu-cli falls back to the ITOTORI_REAL_GAME_ROOT env var.
   */
  gameRoot?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  /** Per-scene mode: the scene id (u16). Mutually exclusive with wholeSeen. */
  scene?: number;
  /** Whole-game mode: one bridge over the entire Seen.txt. */
  wholeSeen?: boolean;
  /** Optional: kaifuu's alpha-006e decompile report (zero-unknown property). */
  decompileReportOutputPath?: string;
};

/**
 * The inputs a Softpal extract needs. Softpal takes the game root POSITIONALLY
 * (matching the `extract --engine softpal <root>` arm); it enumerates
 * SCRIPT.SRC + TEXT.DAT (from `data.pac` or a loose pair) and needs no scene
 * index, vault identity, or user-provided key.
 */
export type SoftpalExtractSource = {
  engine: "softpal";
  /**
   * The Softpal game root (passed positionally). When omitted, kaifuu-cli falls
   * back to the ITOTORI_REAL_GAME_ROOT_SOFTPAL env var.
   */
  gameRoot?: string;
};

/**
 * The inputs an RPG Maker MV/MZ extract needs. It walks the game's `www/data/
 * *.json` surfaces into one whole-game bridge; identity metadata mirrors the
 * RealLive flag-shape. When `gameDir` is omitted, kaifuu-cli falls back to the
 * ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ env var.
 */
export type RpgMakerExtractSource = {
  engine: "rpg-maker";
  /** The game's `www/` directory (passed as `--game-dir`). */
  gameDir?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  /** Optional sanitized per-kind finding census (counts only — never text). */
  findingsOutputPath?: string;
};

/** A decode/extract REQUEST — an engine-discriminated source union. */
export type ExtractSource = RealliveExtractSource | SoftpalExtractSource | RpgMakerExtractSource;

/** Process-level inputs the seam adds around a source to spawn kaifuu-cli. */
export type ExtractProcessArgs = {
  /** Where kaifuu writes the BridgeBundle (the localize consumer's input). */
  bundleOutputPath: string;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests. Defaults to a real `spawnSync`. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult;
  log?: (message: string) => void;
};

/** A RealLive extract invocation (source + process). */
export type KaifuuRealliveExtractArgs = RealliveExtractSource & ExtractProcessArgs;
/** A Softpal extract invocation (source + process). */
export type KaifuuSoftpalExtractArgs = SoftpalExtractSource & ExtractProcessArgs;
/** An RPG Maker MV/MZ extract invocation (source + process). */
export type KaifuuRpgMakerExtractArgs = RpgMakerExtractSource & ExtractProcessArgs;

/** Engine-discriminated extract args — a RealLive, Softpal, OR RPG Maker call. */
export type KaifuuExtractArgs =
  | KaifuuRealliveExtractArgs
  | KaifuuSoftpalExtractArgs
  | KaifuuRpgMakerExtractArgs;

/** Correlates each engine id to its full (source + process) args type. */
type ExtractArgsByEngine = {
  reallive: KaifuuRealliveExtractArgs;
  softpal: KaifuuSoftpalExtractArgs;
  "rpg-maker": KaifuuRpgMakerExtractArgs;
};

/** Correlates each engine id to its request source type. */
type ExtractSourceByEngine = {
  reallive: RealliveExtractSource;
  softpal: SoftpalExtractSource;
  "rpg-maker": RpgMakerExtractSource;
};

/** The engines this registry can extract. */
export type ExtractEngineId = keyof ExtractArgsByEngine;

/** Back-compat alias for the engine id union. */
export type KaifuuEngine = ExtractEngineId;

/** What an engine's extract adapter can do — used to derive CLI/API availability. */
export type ExtractFormField = {
  /** The request-payload property this control owns. */
  key: string;
  /** The operator-facing label. */
  label: string;
  input: "text" | "number";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
};

export type ExtractFormConstraint = {
  kind: "exactly-one";
  fields: readonly string[];
  message: string;
};

export type ExtractModeCapability = {
  /** The mode the adapter reports after a successful extraction. */
  id: ExtractMode;
  /** The operator-facing mode label. */
  label: string;
  /** Values selected by this mode that do not need a control. */
  fixedValues: Readonly<Record<string, string | number | boolean>>;
  /** Fields shown only while this mode is selected. */
  fields: readonly ExtractFormField[];
};

/**
 * The registry-owned capability descriptor consumed by CLI help, the HTTP
 * contract, and Studio. An adapter owns every engine-specific form field and
 * mode label; callers never infer them from an engine name.
 */
export type ExtractCapability = {
  engine: ExtractEngineId;
  label: string;
  /** Human summary for CLI help + capability reporting. */
  summary: string;
  /** Fields that apply to every mode of this adapter. */
  fields: readonly ExtractFormField[];
  /** Source constraints expressed over the adapter's form fields. */
  constraints: readonly ExtractFormConstraint[];
  /** The extract modes this adapter can produce. */
  modes: readonly ExtractModeCapability[];
};

/**
 * The per-engine extract adapter. `E` binds every method to the engine's OWN
 * typed inputs, so an adapter never sees another engine's request shape.
 */
export interface ExtractAdapter<E extends ExtractEngineId> {
  readonly engine: E;
  readonly capability: ExtractCapability;
  /** Build the kaifuu-cli `extract --engine <e>` argv (no binary prefix). */
  buildArgs(args: ExtractArgsByEngine[E]): string[];
  /** Reject an unsatisfiable request BEFORE spawning (clear user-facing UX). */
  validate(args: ExtractArgsByEngine[E], env: NodeJS.ProcessEnv): void;
  /** The mode this request produces. */
  mode(args: ExtractArgsByEngine[E]): ExtractMode;
  /** Parse the user-shaped `itotori extract --engine <e> ...` flags to a source. */
  parseCli(args: readonly string[]): ExtractSourceByEngine[E];
  /** Parse the public Studio request payload for this adapter alone. */
  parseApi(input: ExtractApiPayload): ExtractSourceByEngine[E];
}

/**
 * An adapter erased to the request union — what the registry stores and the
 * shared dispatch calls. The single `as unknown as` cast in
 * {@link defineExtractAdapter} is the ONLY place a narrow adapter is widened;
 * the registry guarantees each adapter only ever receives its own engine's
 * request, so the erased call is sound at runtime.
 */
export type AnyExtractAdapter = {
  readonly engine: ExtractEngineId;
  readonly capability: ExtractCapability;
  buildArgs(args: KaifuuExtractArgs): string[];
  validate(args: KaifuuExtractArgs, env: NodeJS.ProcessEnv): void;
  mode(args: KaifuuExtractArgs): ExtractMode;
  parseCli(args: readonly string[]): ExtractSource;
  parseApi(input: ExtractApiPayload): ExtractSource;
};

function defineExtractAdapter<E extends ExtractEngineId>(
  adapter: ExtractAdapter<E>,
): AnyExtractAdapter {
  return adapter as unknown as AnyExtractAdapter;
}

/** The untyped JSON-object payload received at the Studio HTTP boundary. */
export type ExtractApiPayload = Readonly<Record<string, unknown>>;

const EXTRACT_CAPABILITIES = {
  reallive: {
    engine: "reallive",
    label: "RealLive",
    summary:
      "RealLive Seen.txt: per-scene or whole archive; sourced by a vault canonical id or game root.",
    fields: [
      {
        key: "vaultCanonicalId",
        label: "Vault canonical id",
        input: "text",
        required: false,
        placeholder: "vault canonical id",
      },
      {
        key: "gameRoot",
        label: "Game root path",
        input: "text",
        required: false,
        placeholder: "/path/to/game",
      },
      { key: "gameId", label: "Game id", input: "text", required: true },
      {
        key: "gameVersion",
        label: "Game version",
        input: "text",
        required: true,
        defaultValue: "1.0",
      },
      { key: "sourceProfileId", label: "Source profile id", input: "text", required: true },
      {
        key: "sourceLocale",
        label: "Source locale",
        input: "text",
        required: true,
        defaultValue: "ja-JP",
      },
    ],
    constraints: [
      {
        kind: "exactly-one",
        fields: ["vaultCanonicalId", "gameRoot"],
        message: "Provide exactly one source: a vault canonical id or game root path.",
      },
    ],
    modes: [
      {
        id: "whole-seen",
        label: "Entire Seen archive",
        fixedValues: { wholeSeen: true },
        fields: [],
      },
      {
        id: "per-scene",
        label: "Single scene",
        fixedValues: {},
        fields: [
          {
            key: "scene",
            label: "Scene id",
            input: "number",
            required: true,
            placeholder: "0..65535",
            min: 0,
            max: REALLIVE_SCENE_ID_MAX,
          },
        ],
      },
    ],
  },
  softpal: {
    engine: "softpal",
    label: "Softpal",
    summary: "Softpal SCRIPT.SRC + TEXT.DAT: one whole-game bridge from a game root.",
    fields: [
      {
        key: "gameRoot",
        label: "Game root path",
        input: "text",
        required: true,
        placeholder: "/path/to/game",
      },
    ],
    constraints: [],
    modes: [{ id: "whole-game", label: "Entire game", fixedValues: {}, fields: [] }],
  },
  "rpg-maker": {
    engine: "rpg-maker",
    label: "RPG Maker MV/MZ",
    summary: "RPG Maker MV/MZ JSON: one whole-game bridge from the game's www directory.",
    fields: [
      {
        key: "gameDir",
        label: "Game www/ directory",
        input: "text",
        required: true,
        placeholder: "/path/to/game/www",
      },
      { key: "gameId", label: "Game id", input: "text", required: true },
      {
        key: "gameVersion",
        label: "Game version",
        input: "text",
        required: true,
        defaultValue: "1.0",
      },
      { key: "sourceProfileId", label: "Source profile id", input: "text", required: true },
      {
        key: "sourceLocale",
        label: "Source locale",
        input: "text",
        required: true,
        defaultValue: "ja-JP",
      },
    ],
    constraints: [],
    modes: [{ id: "whole-game", label: "Entire game", fixedValues: {}, fields: [] }],
  },
} as const satisfies Readonly<Record<ExtractEngineId, ExtractCapability>>;

/** The extract modes advertised by one registered adapter. */
export type ExtractModeForEngine<E extends ExtractEngineId> =
  (typeof EXTRACT_CAPABILITIES)[E]["modes"][number]["id"];

/** The engine/mode response discriminant, derived from registry capabilities. */
export type ExtractOutcome = {
  [E in ExtractEngineId]: { engine: E; mode: ExtractModeForEngine<E> };
}[ExtractEngineId];

// ---------------------------------------------------------------------------
// RealLive adapter
// ---------------------------------------------------------------------------

const realliveExtractAdapter: ExtractAdapter<"reallive"> = {
  engine: "reallive",
  capability: EXTRACT_CAPABILITIES.reallive,
  buildArgs(args) {
    // Ordering mirrors the suite runner's Phase 1 invocation:
    //   extract --engine reallive
    //     [--vault-canonical-id <ID> | --game-root <PATH>]
    //     --game-id <ID> --game-version <V> --source-profile-id <ID> --source-locale <L>
    //     (--scene <N> | --whole-seen)
    //     --bundle-output <PATH> [--decompile-report-output <PATH>]
    const out: string[] = ["extract", "--engine", "reallive"];
    if (args.vaultCanonicalId !== undefined && args.vaultCanonicalId.length > 0) {
      out.push("--vault-canonical-id", args.vaultCanonicalId);
    }
    if (args.gameRoot !== undefined && args.gameRoot.length > 0) {
      out.push("--game-root", args.gameRoot);
    }
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
    if (args.wholeSeen === true) {
      out.push("--whole-seen");
    } else if (args.scene !== undefined) {
      out.push("--scene", String(args.scene));
    }
    out.push("--bundle-output", args.bundleOutputPath);
    if (args.decompileReportOutputPath !== undefined) {
      out.push("--decompile-report-output", args.decompileReportOutputPath);
    }
    return out;
  },
  validate(args, env) {
    if (args.wholeSeen === true && args.scene !== undefined) {
      throw new Error(
        "kaifuu extract refused: --whole-seen and --scene are mutually exclusive (--whole-seen produces one bridge over the entire Seen.txt)",
      );
    }
    if (args.wholeSeen !== true && args.scene === undefined) {
      throw new Error(
        "kaifuu extract refused: provide --scene <N> (per-scene) or --whole-seen (whole-game)",
      );
    }
    if (
      args.scene !== undefined &&
      (!Number.isInteger(args.scene) || args.scene < 0 || args.scene > REALLIVE_SCENE_ID_MAX)
    ) {
      throw new Error(
        `kaifuu extract refused: --scene '${String(args.scene)}' must be a u16 (0..${REALLIVE_SCENE_ID_MAX})`,
      );
    }
    // Sourcing: at least one route must be resolvable BEFORE spawning.
    const hasVault = args.vaultCanonicalId !== undefined && args.vaultCanonicalId.length > 0;
    const hasGameRoot = args.gameRoot !== undefined && args.gameRoot.length > 0;
    const hasEnvGameRoot =
      env.ITOTORI_REAL_GAME_ROOT !== undefined && env.ITOTORI_REAL_GAME_ROOT.length > 0;
    if (!hasVault && !hasGameRoot && !hasEnvGameRoot) {
      throw new Error(
        "kaifuu extract refused: sourcing requires --vault-canonical-id <ID>, --game-root <PATH>, or the ITOTORI_REAL_GAME_ROOT env var",
      );
    }
  },
  mode(args) {
    return args.wholeSeen === true ? "whole-seen" : "per-scene";
  },
  parseCli(args) {
    const wholeSeen = args.includes("--whole-seen");
    const sceneTokenPresent = args.includes("--scene");
    const sceneRaw = optionalFlag(args, "--scene");
    // Resolve the mode at parse time so a user-shaped invocation gets a clear,
    // immediate error rather than a confusing one deep in the seam.
    if (wholeSeen && sceneTokenPresent) {
      throw new Error(
        "extract refused: --whole-seen and --scene are mutually exclusive (choose one extract mode)",
      );
    }
    if (sceneTokenPresent && sceneRaw === undefined) {
      throw new Error(
        "extract refused: --scene requires a numeric value (0..65535, e.g. --scene 6010)",
      );
    }
    if (!wholeSeen && !sceneTokenPresent) {
      throw new Error(
        "extract refused: provide --scene <N> (per-scene) or --whole-seen (whole-game)",
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
    if (wholeSeen === (scene !== undefined)) {
      throw new Error(
        "ApiProjectDecodeExtractRequest for reallive requires exactly one mode: scene or wholeSeen",
      );
    }
    if (input.wholeSeen !== undefined && input.wholeSeen !== true) {
      throw new Error("ApiProjectDecodeExtractRequest.wholeSeen must be true when supplied");
    }
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

function parseRealliveSceneId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > REALLIVE_SCENE_ID_MAX ||
    String(parsed) !== value
  ) {
    throw new Error(
      `extract refused: --scene '${value}' must be a u16 (0..${REALLIVE_SCENE_ID_MAX})`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Softpal adapter
// ---------------------------------------------------------------------------

const softpalExtractAdapter: ExtractAdapter<"softpal"> = {
  engine: "softpal",
  capability: EXTRACT_CAPABILITIES.softpal,
  buildArgs(args) {
    // The game root is POSITIONAL:
    //   extract --engine softpal [<root>] --bundle-output <PATH>
    const out: string[] = ["extract", "--engine", "softpal"];
    if (args.gameRoot !== undefined && args.gameRoot.length > 0) {
      out.push(args.gameRoot);
    }
    out.push("--bundle-output", args.bundleOutputPath);
    return out;
  },
  validate(args, env) {
    const hasGameRoot = args.gameRoot !== undefined && args.gameRoot.length > 0;
    const hasEnvGameRoot =
      env.ITOTORI_REAL_GAME_ROOT_SOFTPAL !== undefined &&
      env.ITOTORI_REAL_GAME_ROOT_SOFTPAL.length > 0;
    if (!hasGameRoot && !hasEnvGameRoot) {
      throw new Error(
        "kaifuu extract (softpal) refused: sourcing requires a game root — pass gameRoot or set the ITOTORI_REAL_GAME_ROOT_SOFTPAL env var",
      );
    }
  },
  mode() {
    return "whole-game";
  },
  parseCli(args) {
    if (args.includes("--scene") || args.includes("--whole-seen")) {
      throw new Error(
        "extract refused: --engine softpal is whole-game; --scene / --whole-seen are RealLive-only",
      );
    }
    const gameRoot = optionalFlag(args, "--game-root");
    return {
      engine: "softpal",
      ...(gameRoot !== undefined ? { gameRoot } : {}),
    };
  },
  parseApi(input) {
    assertCapabilityPayload(EXTRACT_CAPABILITIES.softpal, input);
    return { engine: "softpal", gameRoot: requiredApiString(input, "gameRoot") };
  },
};

// ---------------------------------------------------------------------------
// RPG Maker MV/MZ adapter
// ---------------------------------------------------------------------------

const rpgMakerExtractAdapter: ExtractAdapter<"rpg-maker"> = {
  engine: "rpg-maker",
  capability: EXTRACT_CAPABILITIES["rpg-maker"],
  buildArgs(args) {
    //   extract --engine rpg-maker [--game-dir <www>]
    //     --game-id <ID> --game-version <V> --source-profile-id <ID> --source-locale <L>
    //     --bundle-output <PATH> [--findings-output <PATH>]
    const out: string[] = ["extract", "--engine", "rpg-maker"];
    if (args.gameDir !== undefined && args.gameDir.length > 0) {
      out.push("--game-dir", args.gameDir);
    }
    out.push(
      "--game-id",
      args.gameId,
      "--game-version",
      args.gameVersion,
      "--source-profile-id",
      args.sourceProfileId,
      "--source-locale",
      args.sourceLocale,
      "--bundle-output",
      args.bundleOutputPath,
    );
    if (args.findingsOutputPath !== undefined && args.findingsOutputPath.length > 0) {
      out.push("--findings-output", args.findingsOutputPath);
    }
    return out;
  },
  validate(args, env) {
    const hasGameDir = args.gameDir !== undefined && args.gameDir.length > 0;
    const hasEnvGameDir =
      env.ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ !== undefined &&
      env.ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ.length > 0;
    if (!hasGameDir && !hasEnvGameDir) {
      throw new Error(
        "kaifuu extract (rpg-maker) refused: sourcing requires a game www/ dir — pass gameDir or set the ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ env var",
      );
    }
  },
  mode() {
    return "whole-game";
  },
  parseCli(args) {
    if (args.includes("--scene") || args.includes("--whole-seen")) {
      throw new Error(
        "extract refused: --engine rpg-maker is whole-game; --scene / --whole-seen are RealLive-only",
      );
    }
    const gameDir = optionalFlag(args, "--game-dir");
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

function assertCapabilityPayload(capability: ExtractCapability, input: ExtractApiPayload): void {
  const allowed = new Set<string>(["engine"]);
  for (const field of capability.fields) {
    allowed.add(field.key);
  }
  for (const mode of capability.modes) {
    for (const field of mode.fields) {
      allowed.add(field.key);
    }
    for (const key of Object.keys(mode.fixedValues)) {
      allowed.add(key);
    }
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(
        `ApiProjectDecodeExtractRequest.${key} is not supported by the ${capability.engine} adapter`,
      );
    }
  }
  for (const field of capability.fields) {
    if (field.required) {
      assertApiFormField(input[field.key], field);
    }
  }
  for (const constraint of capability.constraints) {
    const supplied = constraint.fields.filter((field) => hasApiValue(input[field]));
    if (constraint.kind === "exactly-one" && supplied.length !== 1) {
      throw new Error(`ApiProjectDecodeExtractRequest ${constraint.message}`);
    }
  }
}

function assertApiFormField(value: unknown, field: ExtractFormField): void {
  if (field.input === "text") {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`ApiProjectDecodeExtractRequest.${field.key} is required`);
    }
    return;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    (field.min !== undefined && value < field.min) ||
    (field.max !== undefined && value > field.max)
  ) {
    throw new Error(`ApiProjectDecodeExtractRequest.${field.key} is invalid`);
  }
}

function hasApiValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredApiString(input: ExtractApiPayload, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`ApiProjectDecodeExtractRequest.${field} is required`);
  }
  return value;
}

function optionalApiString(input: ExtractApiPayload, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`ApiProjectDecodeExtractRequest.${field} must be a non-empty string`);
  }
  return value;
}

function optionalApiScene(input: ExtractApiPayload, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > REALLIVE_SCENE_ID_MAX
  ) {
    throw new Error(`ApiProjectDecodeExtractRequest.${field} must be a u16 (0..65535)`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const EXTRACT_ADAPTERS: Readonly<Record<ExtractEngineId, AnyExtractAdapter>> = {
  reallive: defineExtractAdapter(realliveExtractAdapter),
  softpal: defineExtractAdapter(softpalExtractAdapter),
  "rpg-maker": defineExtractAdapter(rpgMakerExtractAdapter),
};

/** The engines with a registered extract adapter, in registration order. */
export function registeredExtractEngines(): ExtractEngineId[] {
  return Object.keys(EXTRACT_ADAPTERS) as ExtractEngineId[];
}

/** Whether `engine` names a registered extract adapter. */
export function isRegisteredExtractEngine(engine: string): engine is ExtractEngineId {
  return Object.prototype.hasOwnProperty.call(EXTRACT_ADAPTERS, engine);
}

/** The registered capabilities, in registration order (CLI/API availability). */
export function extractCapabilities(): ExtractCapability[] {
  return registeredExtractEngines().map((engine) => EXTRACT_CAPABILITIES[engine]);
}

/** Parse the engine-discriminated Studio HTTP request through its adapter. */
export function parseExtractApiRequest(body: unknown): ExtractSource {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ApiProjectDecodeExtractRequest must be an object");
  }
  const input = body as ExtractApiPayload;
  if (typeof input.engine !== "string") {
    throw new Error("ApiProjectDecodeExtractRequest.engine is required");
  }
  return resolveExtractAdapter(input.engine).parseApi(input);
}

/** Whether a response mode is one the registered engine capability advertises. */
export function isExtractModeForEngine(engine: string, mode: string): boolean {
  return resolveExtractAdapter(engine).capability.modes.some((option) => option.id === mode);
}

/**
 * Resolve the extract adapter for `engine`. There is NO default: an omitted or
 * unregistered engine is REJECTED here, at the boundary, rather than silently
 * routed to RealLive.
 */
export function resolveExtractAdapter(engine: string): AnyExtractAdapter {
  if (!isRegisteredExtractEngine(engine)) {
    throw new Error(
      `extract refused: --engine '${engine}' is not a registered extract adapter (registered: ${registeredExtractEngines().join(", ")})`,
    );
  }
  return EXTRACT_ADAPTERS[engine];
}
