// itotori-installable-package-artifact — the publishable itotori CLI bundle.
//
// The itotori monorepo is a private pnpm+nix dev workspace (root package.json
// `private: true`, `bin: null`, every internal `@itotori/*` package `private`
// at `0.0.0`). A non-clone user cannot `npm install` it. This script produces
// the REAL installable artifact: a single self-contained `dist/cli.js` whose
// `bin` entry is `itotori`, versioned by the product semver
// (`ITOTORI_PRODUCT_VERSION`), bundling the compiled CLI + every workspace
// dependency so the installed bin runs WITHOUT the monorepo's `node_modules`.
//
//   node packages/itotori-cli/build.mjs     # dist/cli.js + migrations/
//
// Design (see docs/install.md §0 + docs/native-deps-provisioning.md):
//
// - **Self-contained bundle.** esbuild bundles `apps/itotori/src/cli.ts` plus
//   the workspace packages (`@itotori/db`, `@itotori/ds`,
//   `@itotori/localization-bridge-schema`) directly from their TypeScript
//   source (via aliases — no pre-build of the deps required) into ONE ESM file.
//   `--platform=node` externalizes only Node built-ins, so the installed bin
//   needs nothing but a matching Node runtime — no `pg`, no `drizzle-orm`, no
//   workspace symlinks. A `createRequire` banner lets the bundled CJS deps
//   (`pg`) call `require('events')` natively from the ESM output.
//
// - **Versioned by the product semver.** `ITOTORI_PRODUCT_VERSION` is the
//   single source of truth (packages/localization-bridge-schema/src/product-version.ts).
//   The CLI reports it via `itotori --version`; this build asserts the
//   `package.json` `version` field matches it so a drift fails the build
//   (and `just check`), mirroring apps/itotori/test/version.test.ts.
//
// - **Migration SQL shipped alongside.** `@itotori/db`'s `migrate()` reads each
//   `migrations/*.sql` via `dirname(import.meta.url)/../migrations/<file>`.
//   From the bundle at `dist/cli.js` that resolves to `dist/../migrations/`
//   (the package root `migrations/`), so the 68 migration files are copied
//   there and `itotori db-migrate` / `itotori localize` resolve them on an
//   installed machine exactly as in the dev shell.
//
// The native runtime deps (kaifuu/utsushi Rust bins, Postgres, Chromium) are
// provisioned by the sibling `itotori-native-deps-provisioning` node
// (`just doctor` / `just provision-native-deps`); this artifact is the bin +
// the compiled CLI surface that consumes them.

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Resolve esbuild from the repo root's dependency tree (vite pulls it in).
// The installable package itself declares NO runtime dependencies — the bundle
// is self-contained — so esbuild is a build-time-only tool resolved transitively
// rather than a declared devDependency of the published surface.
const rootRequire = createRequire(path.join(repoRoot, "package.json"));
const viteRequire = createRequire(rootRequire.resolve("vite"));
const { build } = await import(viteRequire.resolve("esbuild"));

const ENTRY = path.join(repoRoot, "apps/itotori/src/cli.ts");
const OUT_DIR = path.join(here, "dist");
const OUT_FILE = path.join(OUT_DIR, "cli.js");
const MIGRATIONS_SRC = path.join(repoRoot, "packages/itotori-db/migrations");
const MIGRATIONS_OUT = path.join(here, "migrations");

// The version stamped into the installable package MUST equal the product
// semver. Parse it from the source literal (the same source `itotori --version`
// reports) so the build fails loudly on a drift, before producing an artifact.
const PRODUCT_VERSION = readProductVersion();
const pkgJson = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
if (pkgJson.version !== PRODUCT_VERSION) {
  throw new Error(
    `itotori-cli build: package.json version "${pkgJson.version}" does not match ` +
      `ITOTORI_PRODUCT_VERSION "${PRODUCT_VERSION}" in ` +
      `packages/localization-bridge-schema/src/product-version.ts. ` +
      `Bump the package.json version to match before publishing.`,
  );
}

const NODE_SHEBANG = "#!/usr/bin/env node";

// A `require` for the bundled CJS deps (pg) to call into Node built-ins from
// the ESM output. Prepended as a banner after esbuild preserves the entrypoint
// shebang.
const BANNER = `import { createRequire as __itotoriCreateRequire } from "node:module";
const require = __itotoriCreateRequire(import.meta.url);
`;

try {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2024",
    outfile: OUT_FILE,
    banner: { js: BANNER },
    logLevel: "warning",
    // Resolve the workspace packages to their TypeScript SOURCE so the bundle
    // is self-contained: no dependency on a pre-built `dist/` for the internal
    // `@itotori/*` packages, and no `workspace:*` references reach the tarball.
    alias: {
      "@itotori/db": path.join(repoRoot, "packages/itotori-db/src/index.ts"),
      "@itotori/localization-bridge-schema": path.join(
        repoRoot,
        "packages/localization-bridge-schema/src/index.ts",
      ),
      "@itotori/ds": path.join(repoRoot, "packages/itotori-ds/src/index.ts"),
    },
    // `pg` etc. are bundled in (self-contained). Only Node built-ins are
    // external (handled by --platform=node).
    legalComments: "none",
    sourcesContent: false,
  });
} catch (err) {
  console.error("itotori-cli build: esbuild failed");
  throw err;
}

normalizeCliShebang();

// Ship the migration SQL files the bundle's `migrate()` reads at runtime.
rmSync(MIGRATIONS_OUT, { recursive: true, force: true });
mkdirSync(MIGRATIONS_OUT, { recursive: true });
let migrationCount = 0;
for (const file of readdirSync(MIGRATIONS_SRC)) {
  if (file.endsWith(".sql")) {
    copyFileSync(path.join(MIGRATIONS_SRC, file), path.join(MIGRATIONS_OUT, file));
    migrationCount += 1;
  }
}
if (migrationCount === 0) {
  throw new Error(`itotori-cli build: no .sql migrations found at ${MIGRATIONS_SRC}`);
}

process.stdout.write(
  `itotori-cli build: dist/cli.js + ${migrationCount} migrations (version ${PRODUCT_VERSION})\n`,
);

function readProductVersion() {
  const src = readFileSync(
    path.join(repoRoot, "packages/localization-bridge-schema/src/product-version.ts"),
    "utf8",
  );
  const m = /ITOTORI_PRODUCT_VERSION\s*=\s*"([^"]+)"/.exec(src);
  if (m === null) {
    throw new Error(
      "itotori-cli build: could not find ITOTORI_PRODUCT_VERSION in product-version.ts",
    );
  }
  return m[1];
}

function normalizeCliShebang() {
  const src = readFileSync(OUT_FILE, "utf8");
  const body = src.replace(/^(?:#![^\n]*(?:\n|$))+/u, "");
  const normalized = `${NODE_SHEBANG}\n${body}`;
  if (normalized !== src) {
    writeFileSync(OUT_FILE, normalized);
  }
}
