// Regression suite for the TanStack AI / OpenRouter temporary-pin guard.
// Proves exact-version enforcement, override drift detection, lockfile
// integrity mismatch, and multi-SDK materialisation rejection; CLI exits 0
// on the current green repo.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePin,
  isExactVersion,
  loadPin,
  checkRepo,
} from "./assert-tanstack-openrouter-pin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "assert-tanstack-openrouter-pin.mjs");
const pinPath = join(here, "lint", "tanstack-openrouter-pin.json");
const repoRoot = join(here, "..");

const pin = loadPin(pinPath);

function baseLockfile(overrides = {}) {
  const sdk = pin.packages["@openrouter/sdk"].version;
  const ai = pin.packages["@tanstack/ai"].version;
  const or = pin.packages["@tanstack/ai-openrouter"].version;
  const sdkInteg = pin.packages["@openrouter/sdk"].integrity;
  const aiInteg = pin.packages["@tanstack/ai"].integrity;
  const orInteg = pin.packages["@tanstack/ai-openrouter"].integrity;

  const overrideLine = overrides.lockOverride ?? `  '@openrouter/sdk': ${sdk}\n`;
  const secondSdk = overrides.secondSdk
    ? `  '@openrouter/sdk@0.13.20':\n    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}\n\n`
    : "";
  const adapterSdkDep = overrides.adapterSdkDep ?? `      '@openrouter/sdk': ${sdk}\n`;

  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
${overrideLine}
importers:

  apps/itotori:
    dependencies:
      '@openrouter/sdk':
        specifier: ${sdk}
        version: ${sdk}
      '@tanstack/ai':
        specifier: ${ai}
        version: ${ai}
      '@tanstack/ai-openrouter':
        specifier: ${or}
        version: ${or}(@tanstack/ai@${ai})

packages:

  '@openrouter/sdk@${sdk}':
    resolution: {integrity: ${sdkInteg}}

${secondSdk}  '@tanstack/ai-openrouter@${or}':
    resolution: {integrity: ${orInteg}}
    peerDependencies:
      '@tanstack/ai': ^${ai}

  '@tanstack/ai@${ai}':
    resolution: {integrity: ${aiInteg}}

  '@tanstack/ai-openrouter@${or}(@tanstack/ai@${ai})':
    dependencies:
${adapterSdkDep}      '@tanstack/ai': ${ai}
`;
}

function greenInputs(mutators = {}) {
  const rootPackageJson = {
    pnpm: { overrides: { "@openrouter/sdk": pin.packages["@openrouter/sdk"].version } },
    ...mutators.root,
  };
  if (mutators.rootOverride !== undefined) {
    rootPackageJson.pnpm = { overrides: { "@openrouter/sdk": mutators.rootOverride } };
  }
  const appPackageJson = {
    dependencies: {
      "@tanstack/ai": pin.packages["@tanstack/ai"].version,
      "@tanstack/ai-openrouter": pin.packages["@tanstack/ai-openrouter"].version,
      "@openrouter/sdk": pin.packages["@openrouter/sdk"].version,
    },
    ...mutators.app,
  };
  if (mutators.appDeps) {
    appPackageJson.dependencies = { ...appPackageJson.dependencies, ...mutators.appDeps };
  }
  return {
    pin: mutators.pin ?? pin,
    rootPackageJson,
    appPackageJson,
    lockfileText: mutators.lockfileText ?? baseLockfile(mutators.lock),
  };
}

test("isExactVersion accepts semver triples and rejects ranges", () => {
  assert.equal(isExactVersion("0.40.0"), true);
  assert.equal(isExactVersion("0.13.55"), true);
  assert.equal(isExactVersion("^0.40.0"), false);
  assert.equal(isExactVersion("~0.15.8"), false);
  assert.equal(isExactVersion("workspace:*"), false);
});

test("green synthetic tree has zero failures", () => {
  assert.deepEqual(evaluatePin(greenInputs()), []);
});

test("flags root override drift", () => {
  const failures = evaluatePin(greenInputs({ rootOverride: "0.13.20" }));
  assert.ok(failures.some((f) => f.includes('pnpm.overrides["@openrouter/sdk"]')));
});

test("flags apps/itotori range or version drift", () => {
  const range = evaluatePin(greenInputs({ appDeps: { "@tanstack/ai": "^0.40.0" } }));
  assert.ok(range.some((f) => f.includes("@tanstack/ai")));
  const drift = evaluatePin(greenInputs({ appDeps: { "@openrouter/sdk": "0.13.59" } }));
  assert.ok(drift.some((f) => f.includes("@openrouter/sdk") && f.includes("0.13.55")));
});

test("flags lockfile integrity drift", () => {
  const bad = baseLockfile().replace(
    pin.packages["@tanstack/ai"].integrity,
    "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  );
  const failures = evaluatePin(greenInputs({ lockfileText: bad }));
  assert.ok(failures.some((f) => f.includes("integrity") && f.includes("@tanstack/ai")));
});

test("flags a second materialised @openrouter/sdk version", () => {
  const failures = evaluatePin(greenInputs({ lock: { secondSdk: true } }));
  assert.ok(failures.some((f) => f.includes("exactly one @openrouter/sdk")));
});

test("flags adapter snapshot still resolving the stale declared SDK", () => {
  const failures = evaluatePin(
    greenInputs({ lock: { adapterSdkDep: "      '@openrouter/sdk': 0.13.20\n" } }),
  );
  assert.ok(failures.some((f) => f.includes("adapter") || f.includes("@openrouter/sdk")));
});

test("flags incomplete publishCommit provenance", () => {
  const broken = structuredClone(pin);
  broken.packages["@tanstack/ai"].publishCommit = "not-a-sha";
  const failures = evaluatePin(greenInputs({ pin: broken }));
  assert.ok(failures.some((f) => f.includes("publishCommit") && f.includes("@tanstack/ai")));
});

test("checkRepo passes on the real workspace", () => {
  assert.deepEqual(checkRepo(repoRoot), []);
});

test("CLI exits 0 on the real workspace", () => {
  const stdout = execFileSync("node", [scriptPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: repoRoot,
  });
  assert.match(stdout, /pin verified/);
});

test("CLI exits 1 when root is a drifted synthetic tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "tanstack-pin-"));
  mkdirSync(join(dir, "apps/itotori"), { recursive: true });
  mkdirSync(join(dir, "scripts/lint"), { recursive: true });
  writeFileSync(join(dir, "scripts/lint/tanstack-openrouter-pin.json"), readFileSync(pinPath));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ pnpm: { overrides: { "@openrouter/sdk": "9.9.9" } } }),
  );
  writeFileSync(
    join(dir, "apps/itotori/package.json"),
    JSON.stringify({
      dependencies: {
        "@tanstack/ai": pin.packages["@tanstack/ai"].version,
        "@tanstack/ai-openrouter": pin.packages["@tanstack/ai-openrouter"].version,
        "@openrouter/sdk": pin.packages["@openrouter/sdk"].version,
      },
    }),
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), baseLockfile());

  // The CLI loads pin from its own scripts/lint next to the script file, not
  // from --root. Drive evaluatePin via a tiny runner instead.
  let code = 0;
  let stderr = "";
  try {
    execFileSync(
      "node",
      [
        "-e",
        `
        import { evaluatePin, loadPin } from ${JSON.stringify(scriptPath)};
        import { readFileSync } from "node:fs";
        const pin = loadPin(${JSON.stringify(join(dir, "scripts/lint/tanstack-openrouter-pin.json"))});
        const failures = evaluatePin({
          pin,
          rootPackageJson: JSON.parse(readFileSync(${JSON.stringify(join(dir, "package.json"))}, "utf8")),
          appPackageJson: JSON.parse(readFileSync(${JSON.stringify(join(dir, "apps/itotori/package.json"))}, "utf8")),
          lockfileText: readFileSync(${JSON.stringify(join(dir, "pnpm-lock.yaml"))}, "utf8"),
        });
        if (failures.length) { console.error(failures.join("\\n")); process.exit(1); }
        `,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    code = err.status ?? 1;
    stderr = err.stderr ?? "";
  }
  assert.equal(code, 1);
  assert.match(stderr, /overrides|0\.13\.55|9\.9\.9/);
});
