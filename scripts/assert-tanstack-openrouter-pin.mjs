#!/usr/bin/env node
// CI guard: the temporary TanStack AI / OpenRouter SDK pin stays exact.
//
// Asserts that apps/itotori, the root pnpm.overrides entry, and pnpm-lock.yaml
// all agree with the canonical pin record in scripts/lint/tanstack-openrouter-pin.json:
// exact version specifiers (no ^/~), matching lockfile integrity hashes, a
// single materialised @openrouter/sdk version (the override, not the adapter's
// stale declared pin), and recorded publish-commit provenance fields.
//
// Exit codes: 0 = pin holds; 1 = drift or missing pin sites.
// Wired into `just ci-tier0-meta` (test then run).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(here, ".."));
const DEFAULT_PIN_PATH = join(here, "lint", "tanstack-openrouter-pin.json");

const PACKAGE_NAMES = ["@tanstack/ai", "@tanstack/ai-openrouter", "@openrouter/sdk"];

export function loadPin(path = DEFAULT_PIN_PATH) {
  if (!existsSync(path)) {
    throw new Error(`pin record missing: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function isExactVersion(specifier) {
  return typeof specifier === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/.test(specifier);
}

// Collect failures against a synthetic tree. Exported for unit tests.
export function evaluatePin({ pin, rootPackageJson, appPackageJson, lockfileText }) {
  const failures = [];
  const packages = pin.packages ?? {};
  for (const name of PACKAGE_NAMES) {
    if (!packages[name]?.version || !packages[name]?.integrity || !packages[name]?.publishCommit) {
      failures.push(`pin record incomplete for ${name} (need version, integrity, publishCommit)`);
    }
  }

  const overrideName = pin.overridePackage ?? "@openrouter/sdk";
  const expectedSdk = packages[overrideName]?.version;
  const rootOverride = rootPackageJson?.pnpm?.overrides?.[overrideName];
  if (rootOverride !== expectedSdk) {
    failures.push(
      `root package.json pnpm.overrides["${overrideName}"] must be exact "${expectedSdk}" (got ${JSON.stringify(rootOverride)})`,
    );
  }

  const appDeps = appPackageJson?.dependencies ?? {};
  for (const name of PACKAGE_NAMES) {
    const expected = packages[name]?.version;
    const got = appDeps[name];
    if (got !== expected) {
      failures.push(
        `apps/itotori dependency ${name} must be exact "${expected}" (got ${JSON.stringify(got)})`,
      );
    } else if (!isExactVersion(got)) {
      failures.push(`apps/itotori dependency ${name} must be an exact version, not a range`);
    }
  }

  if (typeof lockfileText !== "string" || lockfileText.length === 0) {
    failures.push("pnpm-lock.yaml missing or empty");
    return failures;
  }

  // Lockfile overrides block (top-level YAML map under "overrides:").
  const overrideBlock = lockfileText.match(/^overrides:\n((?:  .+\n)+)/m);
  if (!overrideBlock) {
    failures.push('pnpm-lock.yaml missing top-level "overrides:" block');
  } else {
    const line = overrideBlock[1]
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`'${overrideName}':`) || l.startsWith(`${overrideName}:`));
    const match = line?.match(/:\s*(.+)\s*$/);
    const lockOverride = match?.[1]?.replace(/^['"]|['"]$/g, "");
    if (lockOverride !== expectedSdk) {
      failures.push(
        `pnpm-lock.yaml overrides["${overrideName}"] must be "${expectedSdk}" (got ${JSON.stringify(lockOverride)})`,
      );
    }
  }

  // Importer pins for apps/itotori (specifier + resolved version).
  const importerMatch = lockfileText.match(
    /^ {2}apps\/itotori:\n([\s\S]*?)(?=^ {2}[A-Za-z.@]|^packages:)/m,
  );
  if (!importerMatch) {
    failures.push('pnpm-lock.yaml missing "apps/itotori" importer block');
  } else {
    const importer = importerMatch[1];
    for (const name of PACKAGE_NAMES) {
      const expected = packages[name].version;
      const re = new RegExp(
        `^ {6}'${name.replace("/", "\\/")}':\\n {8}specifier: (.+)\\n {8}version: (.+)$`,
        "m",
      );
      const m = importer.match(re);
      if (!m) {
        failures.push(`pnpm-lock.yaml apps/itotori importer missing ${name}`);
        continue;
      }
      const specifier = m[1].trim();
      const version = m[2].trim().split("(")[0]; // strip peer suffix if any
      if (specifier !== expected) {
        failures.push(
          `pnpm-lock.yaml apps/itotori ${name} specifier must be "${expected}" (got "${specifier}")`,
        );
      }
      if (!version.startsWith(expected)) {
        failures.push(
          `pnpm-lock.yaml apps/itotori ${name} version must resolve to "${expected}" (got "${version}")`,
        );
      }
    }
  }

  // Packages catalogue: exact integrity for each pinned tarball; no second SDK version.
  for (const name of PACKAGE_NAMES) {
    const expected = packages[name];
    const key = `'${name}@${expected.version}':`;
    const idx = lockfileText.indexOf(`\n  ${key}`);
    if (idx === -1 && !lockfileText.startsWith(`  ${key}`)) {
      failures.push(`pnpm-lock.yaml packages catalogue missing ${name}@${expected.version}`);
      continue;
    }
    const start = idx === -1 ? 0 : idx + 1;
    const slice = lockfileText.slice(start, start + 400);
    const integ = slice.match(/resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/);
    if (!integ) {
      failures.push(`pnpm-lock.yaml missing integrity for ${name}@${expected.version}`);
    } else if (integ[1] !== expected.integrity) {
      failures.push(
        `pnpm-lock.yaml integrity for ${name}@${expected.version} drifted (expected pin record hash)`,
      );
    }
  }

  // Forbid a second materialised @openrouter/sdk version in the packages catalogue.
  const sdkVersionKeys = [...lockfileText.matchAll(/^ {2}'@openrouter\/sdk@([^']+)':\s*$/gm)].map(
    (m) => m[1],
  );
  const uniqueSdk = [...new Set(sdkVersionKeys)];
  if (uniqueSdk.length !== 1 || uniqueSdk[0] !== expectedSdk) {
    failures.push(
      `pnpm-lock.yaml must materialise exactly one @openrouter/sdk version "${expectedSdk}" (found ${JSON.stringify(uniqueSdk)})`,
    );
  }

  // Snapshot for the adapter (peer-resolved key under packages:) must depend on
  // the overridden SDK, not the stale declare.
  const adapterVer = packages["@tanstack/ai-openrouter"].version;
  const adapterEsc = adapterVer.replace(/\./g, "\\.");
  const adapterHeaderRe = new RegExp(
    `^ {2}'@tanstack/ai-openrouter@${adapterEsc}(?:\\([^)]*\\))?':\\s*$`,
    "m",
  );
  if (!adapterHeaderRe.test(lockfileText)) {
    failures.push(`pnpm-lock.yaml missing snapshot for @tanstack/ai-openrouter@${adapterVer}`);
  } else {
    // Require a deps line of the form `      '@openrouter/sdk': <expected>` under
    // some adapter snapshot block. Scan line-windows after each adapter header.
    const lines = lockfileText.split(/\r?\n/u);
    let adapterHasOverride = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^ {2}'@tanstack\/ai-openrouter@/.test(lines[i])) continue;
      if (!lines[i].includes(`@${adapterVer}`)) continue;
      for (let j = i + 1; j < lines.length && j < i + 20; j += 1) {
        if (/^ {2}'/.test(lines[j])) break; // next packages entry
        if (new RegExp(`^ {6}'@openrouter/sdk':\\s*${expectedSdk}\\b`).test(lines[j])) {
          adapterHasOverride = true;
          break;
        }
      }
      if (adapterHasOverride) break;
    }
    if (!adapterHasOverride) {
      failures.push(
        `@tanstack/ai-openrouter lockfile snapshot must resolve @openrouter/sdk to ${expectedSdk} (override), not the adapter-declared pin`,
      );
    }
  }

  // Provenance: publish commits must look like full git SHAs (audit trail).
  for (const name of PACKAGE_NAMES) {
    const commit = packages[name]?.publishCommit;
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
      failures.push(`pin record publishCommit for ${name} must be a 40-char lowercase git SHA`);
    }
  }

  return failures;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function checkRepo(root = repoRoot, pinPath = DEFAULT_PIN_PATH) {
  const pin = loadPin(pinPath);
  const rootPackageJson = readJson(join(root, "package.json"));
  const appPackageJson = readJson(join(root, pin.appPackagePath ?? "apps/itotori/package.json"));
  const lockPath = join(root, "pnpm-lock.yaml");
  const lockfileText = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "";
  return evaluatePin({ pin, rootPackageJson, appPackageJson, lockfileText });
}

function main(argv) {
  const rootArg = argv.find((a) => a.startsWith("--root="));
  const root = rootArg ? resolve(rootArg.slice("--root=".length)) : repoRoot;
  const failures = checkRepo(root);
  if (failures.length > 0) {
    console.error("tanstack/openrouter pin assertion failed:");
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  const pin = loadPin(DEFAULT_PIN_PATH);
  const versions = PACKAGE_NAMES.map((n) => `${n}@${pin.packages[n].version}`).join(", ");
  console.log(
    `tanstack/openrouter pin verified (${versions}; override @openrouter/sdk@${pin.packages["@openrouter/sdk"].version})`,
  );
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("assert-tanstack-openrouter-pin.mjs")
) {
  main(process.argv.slice(2));
}
