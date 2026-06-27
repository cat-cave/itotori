import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRoadmapSpecDagExport } from "./qd-wrapper.mjs";

const root = path.resolve("/repo");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const wrapperPath = path.join(scriptDir, "qd-wrapper.mjs");

test("detects direct qd export to roadmap spec DAG", () => {
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--out", "roadmap/spec-dag.json"]), true);
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--out=roadmap/spec-dag.json"]), true);
  assert.equal(
    isRoadmapSpecDagExport(root, ["export", "--out", path.join(root, "roadmap", "spec-dag.json")]),
    true,
  );
});

test("does not canonicalize unrelated qd exports", () => {
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--json"]), false);
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--out", "roadmap/other.json"]), false);
  assert.equal(isRoadmapSpecDagExport(root, ["node", "show", "ITOTORI-300", "--json"]), false);
});

test("canonicalizes direct qd export to roadmap spec DAG", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qd-wrapper-export-"));
  const repoRoot = path.join(dir, "repo");
  const fakeBinDir = path.join(dir, "bin");
  const fakeQdPath = path.join(dir, "fake-qd.mjs");
  const fakePnpmPath = path.join(fakeBinDir, "pnpm");
  const pnpmArgsPath = path.join(dir, "pnpm-args.txt");
  const exportPath = path.join(repoRoot, "roadmap", "spec-dag.json");

  mkdirSync(path.dirname(exportPath), { recursive: true });
  mkdirSync(path.join(repoRoot, ".qd"), { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });

  writeFileSync(
    fakeQdPath,
    `import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
const outIndex = args.indexOf("--out");
if (!args.includes("export") || outIndex < 0) process.exit(2);
writeFileSync(path.resolve(root, args[outIndex + 1]), '{"b":2,"a":[1,2]}');
`,
  );

  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

writeFileSync(${JSON.stringify(pnpmArgsPath)}, process.argv.slice(2).join("\\n"));
const target = process.argv.at(-1);
const json = JSON.parse(readFileSync(target, "utf8"));
writeFileSync(target, \`\${JSON.stringify(json, null, 2)}\\n\`);
`,
  );
  chmodSync(fakePnpmPath, 0o755);

  const result = spawnSync(
    process.execPath,
    [wrapperPath, "--root", repoRoot, "export", "--out", "roadmap/spec-dag.json"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        QD_REAL_NODE_SCRIPT: fakeQdPath,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join("\n"));
  assert.equal(readFileSync(exportPath, "utf8"), '{\n  "b": 2,\n  "a": [\n    1,\n    2\n  ]\n}\n');
  assert.deepEqual(readFileSync(pnpmArgsPath, "utf8").split("\n"), [
    "exec",
    "vp",
    "check",
    "--fix",
    "--no-lint",
    exportPath,
  ]);
});
