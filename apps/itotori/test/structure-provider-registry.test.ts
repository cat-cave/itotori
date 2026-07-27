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

  it("runs the Softpal native producer through the shared Utsushi seam", () => {
    expect(registeredStructureEngines()).toEqual(["reallive", "softpal", "siglus"]);
    expect(structureProviderCapabilities().map((capability) => capability.implemented)).toEqual([
      true,
      true,
      true,
    ]);
    const calls: Array<{ command: string; args: string[] }> = [];
    const source = resolveStructureProvider("softpal").parseCli([
      "--engine",
      "softpal",
      "--game-root",
      "game",
      "--output",
      "out/structure.json",
    ]);
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
          "softpal",
          "--game-root",
          "game",
          "--output",
          "out/structure.json",
        ],
      },
    ]);
  });

  it("runs the Siglus provider through the native producer without routing it to RealLive", () => {
    const source = resolveStructureProvider("siglus").parseCli([
      "--engine",
      "siglus",
      "--scene",
      "game/Scene.pck",
      "--gameexe",
      "game/Gameexe.dat",
      "--output",
      "out/structure.json",
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
    expect(calls[0]?.args.slice(-9)).toEqual([
      "structure",
      "--engine",
      "siglus",
      "--gameexe",
      "game/Gameexe.dat",
      "--scene",
      "game/Scene.pck",
      "--output",
      "out/structure.json",
    ]);
  });

  it("rejects an unregistered provider", () => {
    expect(() => resolveStructureProvider("unknown")).toThrow("not a registered structure provider");
  });
});
