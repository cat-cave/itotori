import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// The live-provider secret env-var names that must NEVER reach a spawned
// native-CLI child. This doctor is Node-built-ins-only and runs BEFORE
// `pnpm install`, so it cannot import the compiled module — instead it reads
// the JSON array from the SINGLE source of truth
// (apps/itotori/src/env/live-provider-secret-vars.{ts,js}) at runtime, so the
// list can never drift from the app's env-file allowlist / spawn-scrub
// boundary.
//
// DURABILITY: an installed/packaged artifact ships the COMPILED `dist/` output
// and may NOT ship `src/`. Both the `.ts` source and the emitted `.js` carry
// the identical marker block, so the doctor prefers the shipped `dist/.js` and
// falls back to the `src/.ts` (dev / pre-build checkout). A drift test asserts
// the two blocks stay identical.
// Ordered candidate locations for the single-source marker block. `dist` first
// so an installed artifact (compiled, no src) resolves; `src` as the dev
// fallback. Relative to REPO_ROOT.
export const LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES = [
  "apps/itotori/dist/env/live-provider-secret-vars.js",
  "apps/itotori/src/env/live-provider-secret-vars.ts",
];

/**
 * Extract + validate the canonical array from a marker-block source body. The
 * `.ts` and emitted `.js` share the exact `LIVE_PROVIDER_SECRET_VARS_JSON = [ … ]`
 * literal, so the same parser handles both. Exported for the drift test.
 */
export function parseLiveProviderSecretVarsBlock(source) {
  const block = /LIVE_PROVIDER_SECRET_VARS_JSON\s*=\s*(\[[\s\S]*?\]);/.exec(source);
  if (block === null) {
    throw new Error("native-deps: could not find the LIVE_PROVIDER_SECRET_VARS_JSON marker block");
  }
  // Tolerate the trailing comma prettier keeps in the array literal.
  const jsonText = block[1].replace(/,(\s*\])/u, "$1");
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((v) => typeof v !== "string")) {
    throw new Error("native-deps: LIVE_PROVIDER_SECRET_VARS block is not a non-empty string array");
  }
  return parsed;
}

function readLiveProviderSecretVars() {
  const tried = [];
  for (const rel of LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES) {
    tried.push(rel);
    let source;
    try {
      source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      continue; // candidate absent (e.g. dist-only artifact has no src) — try next
    }
    return parseLiveProviderSecretVarsBlock(source);
  }
  throw new Error(
    `native-deps: could not read the live-provider secret allowlist from any of: ${tried.join(", ")}`,
  );
}

const LIVE_PROVIDER_SECRET_VARS = readLiveProviderSecretVars();

// A live run may have loaded the OpenRouter credentials into this process's env
// (via the external env-file workflow) before the doctor runs, so — exactly
// like the app's `spawnNativeCliProcess` boundary — scrub the live-provider
// secrets from every child env: a decode/render/probe/build child never needs
// OpenRouter creds.
function scrubLiveProviderSecretsFromEnv(env) {
  const scrubbed = { ...env };
  for (const key of LIVE_PROVIDER_SECRET_VARS) {
    delete scrubbed[key];
  }
  return scrubbed;
}
export const NATIVE_CHILD_ENV = scrubLiveProviderSecretsFromEnv(process.env);

// A sentinel path that is guaranteed NOT to exist, used as a --game-root for the
// kaifuu contract probe so the bin fails at game-root resolution WITHOUT decoding
// or writing anything. Both the root and the bundle-output live under this
// nonexistent directory, so even the write path (never reached) could not
// touch a real file.
const DOCTOR_PROBE_MISSING_DIR = path.join(
  tmpdir(),
  "itotori-doctor-probe-nonexistent-DO-NOT-CREATE",
);
const DOCTOR_PROBE_MISSING_ROOT = path.join(DOCTOR_PROBE_MISSING_DIR, "game-root");
const DOCTOR_PROBE_MISSING_BUNDLE = path.join(DOCTOR_PROBE_MISSING_DIR, "bundle.json");

// The kaifuu/utsushi CLI binaries the localize + render pipeline drive. Bin
// names are the crate names (default cargo bin target).
//
// `contractProbe` is a BEHAVIORAL subcommand-contract handshake, not a mere
// help-banner substring: the doctor INVOKES the real subcommand (in a safe
// no-real-work mode) and asserts the bin honors the CURRENT flag contract the
// pipeline depends on. A mid-age bin that still prints a plausible top-level
// banner but no longer honors the subcommand contract FAILS here — which a
// top-level `--help` substring could not catch.
export const RUST_BINS = [
  {
    name: "kaifuu-cli",
    envVar: "ITOTORI_KAIFUU_BIN",
    role: "decode / patch driver",
    contractProbe: {
      description: "extract --whole-seen accepts an OPTIONAL --scene",
      args: [
        "extract",
        "--engine",
        "reallive",
        "--whole-seen",
        "--game-id",
        "doctor-probe",
        "--game-version",
        "doctor-probe",
        "--source-profile-id",
        "doctor-probe",
        "--source-locale",
        "doctor-probe",
        "--bundle-output",
        DOCTOR_PROBE_MISSING_BUNDLE,
        "--game-root",
        DOCTOR_PROBE_MISSING_ROOT,
      ],
      requireAll: [],
      rejectAny: ["--scene", "--output"],
    },
  },
  {
    name: "utsushi-cli",
    envVar: "ITOTORI_UTSUSHI_BIN",
    role: "render / conformance driver",
    contractProbe: {
      description: "render-validate exposes the current flag contract",
      args: ["render-validate", "--help"],
      requireAll: [
        "render-validate",
        "--engine reallive",
        "--artifact-root",
        "--require-semantic-reached-path",
      ],
      rejectAny: [],
    },
  },
];

// Chromium-family executables to look for on PATH, mirroring the Rust
// UTSUSHI_BROWSER_BIN PATH fallback (crates/utsushi-fixture/tests).
export const CHROMIUM_PATH_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "chrome",
];

// Which deps each install profile requires. A headless localize run needs the
// core three; render / e2e additionally needs Chromium.
export const PROFILES = {
  core: ["node", "rust", "postgres"],
  render: ["node", "rust", "postgres", "chromium"],
  full: ["node", "rust", "postgres", "chromium"],
};
