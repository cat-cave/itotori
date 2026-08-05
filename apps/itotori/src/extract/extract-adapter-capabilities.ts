import {
  REALLIVE_SCENE_ID_MAX,
  type ExtractCapability,
  type ExtractEngineId,
} from "./extract-adapter-types.js";

export const EXTRACT_CAPABILITIES = {
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
      {
        id: "scene-set",
        label: "Scene set",
        fixedValues: {},
        fields: [{ key: "scenes", label: "Scene ids", input: "text", required: true }],
      },
      {
        id: "unit-range",
        label: "Unit range",
        fixedValues: {},
        fields: [{ key: "unitRange", label: "Unit range", input: "text", required: true }],
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
  siglus: {
    engine: "siglus",
    label: "Siglus",
    summary:
      "Siglus Scene.pck + Gameexe.dat: one whole-game bridge from a vault claim or game root.",
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
    modes: [{ id: "whole-game", label: "Entire game", fixedValues: {}, fields: [] }],
  },
} as const satisfies Readonly<Record<ExtractEngineId, ExtractCapability>>;

export type ExtractModeForEngine<E extends ExtractEngineId> =
  (typeof EXTRACT_CAPABILITIES)[E]["modes"][number]["id"];

export type ExtractOutcome = {
  [E in ExtractEngineId]: { engine: E; mode: ExtractModeForEngine<E> };
}[ExtractEngineId];
