import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";

describe("command-specific CLI help", () => {
  it("prints the structure-export flags instead of generic top-level help", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await runItotoriCliCommand(["structure-export", "--help"], noOpDependencies());
    } finally {
      spy.mockRestore();
    }
    const output = writes.join("");
    expect(output).toContain("itotori structure-export --engine <ENGINE> --output <JSON> ...");
    expect(output).toContain("--engine reallive --gameexe <INI> --seen <TXT>");
    expect(output).not.toContain("SETUP:");
  });
});

function noOpDependencies(): ItotoriCliDependencies {
  return {
    io: {
      readJson: () => undefined,
      writeJson: () => undefined,
    },
    migrateDatabase: async () => undefined,
    resetDatabase: async () => undefined,
    withServices: async () => {
      throw new Error("help must not open services");
    },
  };
}
