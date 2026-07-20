import { describe, expect, it } from "vitest";

import {
  registeredStructureEngines,
  resolveStructureProvider,
  runStructureProvider,
  structureProviderCapabilities,
} from "../src/structure-export/structure-provider-registry.js";

describe("StructureProvider registry", () => {
  it("requires an engine-discriminated provider and forwards the RealLive native identity", () => {
    const provider = resolveStructureProvider("reallive");
    const source = provider.parseCli([
      "--engine",
      "reallive",
      "--gameexe",
      "game/Gameexe.ini",
      "--seen",
      "game/Seen.txt",
      "--output",
      "out/structure.json",
      "--entry-scene",
      "42",
      "--max-scenes",
      "99",
    ]);
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = runStructureProvider({
      ...source,
      env: { ITOTORI_UTSUSHI_BIN: "utsushi-test" },
      runProcess(command, args) {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.status).toBe(0);
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
          "reallive",
          "--gameexe",
          "game/Gameexe.ini",
          "--seen",
          "game/Seen.txt",
          "--output",
          "out/structure.json",
          "--entry-scene",
          "42",
          "--max-scenes",
          "99",
        ],
      },
    ]);
  });

  it("exposes typed future providers without silently routing them to RealLive", () => {
    expect(registeredStructureEngines()).toEqual(["reallive", "softpal", "siglus"]);
    expect(structureProviderCapabilities().map((capability) => capability.implemented)).toEqual([
      true,
      false,
      false,
    ]);
    expect(() =>
      resolveStructureProvider("softpal").run({
        engine: "softpal",
        gameRoot: "game",
        outputPath: "out/structure.json",
      }),
    ).toThrow("registered typed provider");
    expect(() => resolveStructureProvider("unknown")).toThrow(
      "not a registered structure provider",
    );
  });
});
