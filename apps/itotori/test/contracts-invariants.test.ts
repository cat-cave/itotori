import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FactSchema,
  IdentifierSchema,
  SubjectIdSchema,
  TermRulingBodySchema,
  terminalContractSchemas,
  type TerminalContractName,
} from "../src/contracts/index.js";
import { terminalContractExamples } from "./contract-fixtures.js";
import { unitFactExample } from "./contract-fixtures-core.js";

type PathPart = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectPaths(value: unknown, path: readonly PathPart[] = []): readonly PathPart[][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  }
  if (!isRecord(value)) return [];
  return [
    [...path],
    ...Object.entries(value).flatMap(([key, item]) => objectPaths(item, [...path, key])),
  ];
}

function addExtraProperty(value: unknown, path: readonly PathPart[]): unknown {
  const clone = structuredClone(value);
  let cursor: unknown = clone;
  for (const part of path) {
    if (Array.isArray(cursor) && typeof part === "number") {
      cursor = cursor[part];
    } else if (isRecord(cursor) && typeof part === "string") {
      cursor = cursor[part];
    } else {
      throw new Error(`fixture path is not traversable: ${path.join(".")}`);
    }
  }
  if (!isRecord(cursor)) throw new Error(`fixture path is not an object: ${path.join(".")}`);
  cursor.__unexpectedContractProperty = true;
  return clone;
}

function withoutSchemaVersion(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("terminal fixture must be an object");
  const { schemaVersion: _schemaVersion, ...rest } = value;
  return rest;
}

function withWrongSchemaVersion(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("terminal fixture must be an object");
  return { ...value, schemaVersion: "itotori.guessed-old-version.v0" };
}

const arbitraryJsonValues: readonly unknown[] = [
  null,
  true,
  false,
  0,
  1.5,
  "raw JSON",
  [],
  [1, "two", null],
  {},
  { rawJson: { deeply: ["nested", 1, true] } },
  { schemaVersion: "1", value: { arbitrary: "payload" } },
];

function walkJsonSchema(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJsonSchema(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  const meaningfulKeys = Object.keys(value).filter(
    (key) => !["$schema", "title", "description", "examples", "default"].includes(key),
  );
  const isSchemaMap = path.endsWith(".properties") || path.endsWith(".$defs");
  if (!isSchemaMap) {
    expect(meaningfulKeys, `${path} contains an unconstrained schema`).not.toHaveLength(0);
  }

  if (value.type === "object") {
    expect(value.additionalProperties, `${path} permits unknown properties`).toBe(false);
  }
  expect(value.additionalProperties, `${path} has a permissive catchall`).not.toBe(true);
  if (isRecord(value.additionalProperties)) {
    throw new Error(`${path} has a schema-valued catchall`);
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== "additionalProperties") walkJsonSchema(child, `${path}.${key}`);
  }
}

describe("terminal contract strictness", () => {
  it("accepts one canonical example for every terminal contract", () => {
    for (const [name, schema] of Object.entries(terminalContractSchemas)) {
      const example = terminalContractExamples[name as TerminalContractName];
      expect(schema.safeParse(example), name).toMatchObject({ success: true });
    }
  });

  it("rejects an extra top-level property in every terminal contract", () => {
    for (const [name, schema] of Object.entries(terminalContractSchemas)) {
      const example = terminalContractExamples[name as TerminalContractName];
      expect(schema.safeParse(addExtraProperty(example, [])).success, name).toBe(false);
    }
  });

  it("rejects extra properties at every populated nested object boundary", () => {
    for (const [name, schema] of Object.entries(terminalContractSchemas)) {
      const example = terminalContractExamples[name as TerminalContractName];
      for (const path of objectPaths(example)) {
        expect(
          schema.safeParse(addExtraProperty(example, path)).success,
          `${name}:${path.join(".")}`,
        ).toBe(false);
      }
    }
  });

  it("requires the one canonical schema version on every terminal contract", () => {
    for (const [name, schema] of Object.entries(terminalContractSchemas)) {
      const example = terminalContractExamples[name as TerminalContractName];
      expect(schema.safeParse(withoutSchemaVersion(example)).success, `${name}:missing`).toBe(
        false,
      );
      expect(schema.safeParse(withWrongSchemaVersion(example)).success, `${name}:wrong`).toBe(
        false,
      );
    }
  });

  it("rejects arbitrary JSON in every terminal contract", () => {
    for (const [name, schema] of Object.entries(terminalContractSchemas)) {
      for (const candidate of arbitraryJsonValues) {
        expect(schema.safeParse(candidate).success, `${name}:${JSON.stringify(candidate)}`).toBe(
          false,
        );
      }
    }
  });

  it.each(Object.entries(terminalContractSchemas))(
    "emits a closed %s provider schema without unconstrained JSON nodes",
    (name, schema) => {
      walkJsonSchema(z.toJSONSchema(schema), name);
    },
  );

  it("contains no raw-JSON or salvage constructors in the contract source", () => {
    const contractDirectory = fileURLToPath(new URL("../src/contracts/", import.meta.url));
    const source = readdirSync(contractDirectory)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(`${contractDirectory}/${file}`, "utf8"))
      .join("\n");
    const forbidden = [
      /z\.(?:any|unknown|json|record|looseObject|preprocess|coerce)\s*\(/u,
      /\.(?:passthrough|catchall|transform|catch)\s*\(/u,
    ];
    for (const pattern of forbidden) expect(source).not.toMatch(pattern);
  });
});

describe("grounded fact boundary", () => {
  it("rejects model-authored replacement fields on facts and fact values", () => {
    const forbiddenFields = [
      "replacement",
      "replacementValue",
      "overrideValue",
      "substitutedValue",
      "proposedValue",
      "modelValue",
      "targetText",
    ] as const;
    for (const field of forbiddenFields) {
      expect(
        FactSchema.safeParse({ ...unitFactExample, [field]: "model edit" }).success,
        field,
      ).toBe(false);
      expect(
        FactSchema.safeParse({
          ...unitFactExample,
          value: { ...unitFactExample.value, [field]: "model edit" },
        }).success,
        `value.${field}`,
      ).toBe(false);
    }
  });

  it("keeps target-form decisions out of source term rulings", () => {
    const sourceRuling = {
      termId: "term:1",
      sourceForm: "source-term",
      meaning: "Source-language meaning.",
      register: "formal",
      confidence: "high",
      sourceScope: { kind: "global" },
      aliases: [],
    };
    expect(TermRulingBodySchema.safeParse(sourceRuling).success).toBe(true);
    expect(
      TermRulingBodySchema.safeParse({ ...sourceRuling, canonicalTarget: "model replacement" })
        .success,
    ).toBe(false);
  });
});

describe("subject identifiers", () => {
  it("accepts source-language identity text while keeping system identifiers ASCII-only", () => {
    expect(SubjectIdSchema.parse("reallive:namae:凛")).toBe("reallive:namae:凛");
    // Compound source names join with `・` (U+30FB) — a legitimate identity id.
    expect(SubjectIdSchema.parse("reallive:namae:和人・しずね")).toBe(
      "reallive:namae:和人・しずね",
    );
    expect(() => SubjectIdSchema.parse("has space")).toThrow();
    expect(() => SubjectIdSchema.parse("name\u0000")).toThrow();
    expect(() => IdentifierSchema.parse("reallive:namae:凛")).toThrow();
  });
});
