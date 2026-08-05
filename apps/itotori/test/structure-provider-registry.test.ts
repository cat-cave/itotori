import { describe, expect, it } from "vitest";

import { runStructureProvider } from "../src/structure-export/structure-provider-registry.js";

type NativeCall = { command: string; args: string[] };

const MISSING_BRIDGE_DIAGNOSTIC = "missing --bridge";

describe("uniform native structure provider", () => {
  it("forwards the same structure argv for every declared engine", () => {
    const engines = ["reallive", "siglus", "softpal", "rpg-maker"];

    for (const engine of engines) {
      const calls: NativeCall[] = [];
      const result = runStructureProvider({
        engine,
        gameRoot: "game",
        bridgePath: "artifacts/bridge.json",
        outputPath: "artifacts/structure.json",
        env: {},
        runProcess(command, args) {
          calls.push({ command, args });
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(result).toMatchObject({ execution: "native-process", process: { status: 0 } });
      expect(calls).toEqual([
        {
          command: "cargo",
          args: [
            "run",
            "-p",
            "utsushi-cli",
            "--quiet",
            "--",
            "structure",
            "--engine",
            engine,
            "--game-root",
            "game",
            "--bridge",
            "artifacts/bridge.json",
            "--output",
            "artifacts/structure.json",
          ],
        },
      ]);
    }
  });

  it("forwards declared format settings as one generic adapter config", () => {
    const calls: NativeCall[] = [];

    runStructureProvider({
      engine: "hypothetical",
      gameRoot: "game",
      bridgePath: "artifacts/bridge.json",
      outputPath: "artifacts/structure.json",
      adapterConfig: { containerRevision: 3 },
      env: {},
      runProcess(command, args) {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(calls[0]?.args.slice(-11)).toEqual([
      "structure",
      "--engine",
      "hypothetical",
      "--game-root",
      "game",
      "--bridge",
      "artifacts/bridge.json",
      "--output",
      "artifacts/structure.json",
      "--adapter-config",
      '{"containerRevision":3}',
    ]);
  });

  it("relays the native missing-bridge diagnostic through the provider seam", () => {
    let caught: Error | undefined;
    try {
      runStructureProvider({
        engine: "reallive",
        gameRoot: "/synthetic/game",
        bridgePath: "/synthetic/bridge.json",
        outputPath: "/synthetic/structure.json",
        env: {},
        runProcess: () => ({ status: 1, stdout: "", stderr: MISSING_BRIDGE_DIAGNOSTIC }),
      });
    } catch (error) {
      if (error instanceof Error) caught = error;
      else throw error;
    }

    expect(Buffer.byteLength(MISSING_BRIDGE_DIAGNOSTIC, "utf8")).toBe(16);
    expect(caught?.message).toContain(
      `utsushi structure failed with status 1: ${MISSING_BRIDGE_DIAGNOSTIC}`,
    );
    expect(caught?.message).not.toContain("REDACTED_CONTENT kind=nativestderr");
  });
});
