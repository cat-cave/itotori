import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.length > 0) {
      return error.stdout.trim();
    }
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    console.error(`affected: git ${args.join(" ")} failed: ${stderr || error.message}`);
    process.exit(1);
  }
}

function gitLines(args) {
  return git(args).split("\n").filter(Boolean);
}

const taskOrder = [
  "ci",
  "check",
  "schema",
  "ci-itotori",
  "ci-kaifuu",
  "ci-utsushi",
  "fixtures-validate",
  "localize-project-test",
  "alpha-proof",
  "roadmap-validate",
];

const broadRootFiles = new Set([
  ".node-version",
  "Cargo.lock",
  "Cargo.toml",
  "deny.toml",
  "docker-compose.yml",
  "justfile",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "rust-toolchain.toml",
  "tsconfig.base.json",
  "vite.config.ts",
]);

function add(tasks, ...names) {
  for (const name of names) {
    tasks.add(name);
  }
}

function addAllProjectGates(tasks) {
  add(tasks, "schema", "ci-itotori", "ci-kaifuu", "ci-utsushi");
}

function addFixtureGates(tasks) {
  add(tasks, "fixtures-validate", "alpha-proof");
}

function isDocsOnly(path) {
  return path === "README.md" || path.startsWith("docs/") || path.endsWith(".md");
}

function isRootPath(path) {
  return !path.includes("/");
}

export function affectedTasks(changedPaths) {
  const tasks = new Set();

  for (const rawPath of changedPaths) {
    const path = rawPath.replaceAll("\\", "/");

    if (
      broadRootFiles.has(path) ||
      (isRootPath(path) && !isDocsOnly(path)) ||
      path.startsWith(".github/") ||
      path.startsWith("scripts/")
    ) {
      add(tasks, "ci");
    } else if (path.startsWith("roadmap/")) {
      add(tasks, "roadmap-validate");
    } else if (path.startsWith("packages/localization-bridge-schema/")) {
      addAllProjectGates(tasks);
      add(tasks, "alpha-proof");
    } else if (path.startsWith("fixtures/")) {
      addFixtureGates(tasks);
    } else if (path.startsWith("presets/")) {
      // presets/*.json are consumed by the ci-itotori localize-project-stage
      // vitest (e.g. presets/localize-project.pair-policy.json). `just check`
      // never runs app vitest, so a preset change must select ci-itotori.
      add(tasks, "ci-itotori");
      // The same presets are ALSO read by suite/scripts/localize-project/
      // run.test.mjs (DEFAULT_PAIR_POLICY_PATH = presets/localize-project.
      // pair-policy.json and presets/localize-project.alpha-target-data.json),
      // which runs ONLY under the localize-project-test lane (justfile:
      // `node --test suite/scripts/localize-project/*.test.mjs`), never under
      // ci-itotori. A preset change must select that lane too, or it could
      // break the localize-project test undetected.
      add(tasks, "localize-project-test");
    } else if (
      path.startsWith("suite/scripts/alpha-public-fixture/") ||
      path.startsWith("suite/scripts/itotori-fixture-iteration/") ||
      path.startsWith("suite/scripts/itotori-iteration-fixture/")
    ) {
      // alpha-proof runs the focused sibling Node unit suites through
      // `alpha-iteration-unit-test`, then executes the public-fixture
      // vertical. Route every source or test change in these directories to
      // that gate; `just check` does not run these suites.
      add(tasks, "alpha-proof");
    } else if (path.startsWith("suite/scripts/localize-project/")) {
      add(tasks, "localize-project-test");
    } else if (path.startsWith("packages/spec-dag-dashboard/")) {
      // spec-dag-dashboard vitest (incl. the db-audit-findings suite that needs
      // ci Postgres) runs in NO fine-grained lane — only the full `ci` gate's
      // recursive `vp run -r test`. Route it to the complete gate.
      add(tasks, "ci");
    } else if (path.startsWith("apps/itotori/") || path.startsWith("packages/itotori-db/")) {
      add(tasks, "ci-itotori");
    } else if (path.startsWith("apps/runtime-web-review/")) {
      add(tasks, "ci-utsushi");
    } else if (path.startsWith("crates/kaifuu-")) {
      add(tasks, "ci-kaifuu");
    } else if (path.startsWith("crates/utsushi-")) {
      add(tasks, "ci-utsushi");
    } else if (!isDocsOnly(path)) {
      add(tasks, "check");
    }
  }

  if (tasks.has("ci")) {
    tasks.delete("check");
    tasks.delete("schema");
    tasks.delete("ci-itotori");
    tasks.delete("ci-kaifuu");
    tasks.delete("ci-utsushi");
    tasks.delete("localize-project-test");
    tasks.delete("roadmap-validate");
  }

  if (tasks.has("check")) {
    tasks.delete("localize-project-test");
    tasks.delete("roadmap-validate");
  }

  return taskOrder.filter((task) => tasks.has(task));
}

// ---------------------------------------------------------------------------
// qd-full-ci affected-lane selection
//
// affectedTasks() (above) maps a changed-path set to the fine-grained project
// gates. affectedCiLanes() layers the coarse `just ci` sub-lanes on top so the
// per-gate qd-full-ci run can pay only for what a diff can affect:
//
//   * broad / shared / foundational change (workspace Cargo.toml, justfile,
//     scripts/, .github/ — including the tier dispatcher pr-tiers.yml, reusable
//     _tier0.yml/_tier1.yml, and setup-itotori composite — root files) ->
//     affectedTasks() collapses to the `ci` sentinel, so affectedCiLanes()
//     returns exactly ["ci"] (the FULL gate). A change to any CI-defining file
//     forces the relevant lanes to re-run; the conservative mapping is the full
//     local `ci` gate (covers every just lane the tier workflows exercise).
//   * apps/itotori-only / TS-only change -> ci-itotori (+ check); NO rust
//     build/test and NO mutation-differential lane.
//   * a crates/kaifuu-* or crates/utsushi-* change -> that family's rust gate
//     (the fast, copyright-free SYNTHETIC suites) PLUS the mutation-differential
//     differential guardrail (proving synthetic >= real for regression
//     detection), expanded dependency-graph-correct: a change to a crate family
//     that another family depends on also runs the dependents' gate (utsushi
//     depends on kaifuu, so a kaifuu change runs ci-utsushi too). The ~30-45min
//     real-bytes lane is NOT selected per-gate — it is periodic-only
//     (`just real-bytes-oracle`). coverage-parity runs in the base `check` gate.
//
// The dependency direction is derived from the workspace Cargo.toml manifests
// (buildCrateFamilyDependents), never hard-coded, so it stays correct as deps
// change. Bias is conservative: when in doubt a lane is selected, never skipped.
// ---------------------------------------------------------------------------

const laneOrder = [
  "ci",
  "check",
  "schema",
  "ci-itotori",
  "ci-kaifuu",
  "ci-utsushi",
  "mutation-differential",
  "fixtures-validate",
  "localize-project-test",
  "alpha-proof",
  "roadmap-validate",
];

const rustFamilyGate = new Map([
  ["kaifuu", "ci-kaifuu"],
  ["utsushi", "ci-utsushi"],
]);

function crateFamilyOf(packageName) {
  return packageName.split("-")[0];
}

function readWorkspaceMembers(root) {
  const cargo = readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const match = cargo.match(/^\[workspace\][\s\S]*?^members\s*=\s*\[([\s\S]*?)^\]/m);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((member) => member[1]);
}

function readPackageName(root, member) {
  const manifest = readFileSync(path.join(root, member, "Cargo.toml"), "utf8");
  let inPackageSection = false;
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "[package]") {
      inPackageSection = true;
      continue;
    }
    if (inPackageSection && trimmed.startsWith("[") && trimmed.endsWith("]")) break;
    const name = inPackageSection ? trimmed.match(/^name\s*=\s*"([^"]+)"/) : null;
    if (name) return name[1];
  }
  return path.basename(member);
}

function workspaceDependencyNames(manifest, packageNames) {
  const names = new Set();
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\b/);
    if (match && packageNames.has(match[1])) names.add(match[1]);
  }
  return names;
}

// Build the crate-FAMILY reverse-dependency closure from the workspace manifests.
// Returns Map<family, string[]> where the value lists every family that (transitively)
// depends on the key family. Example here: { kaifuu -> ["utsushi"] } (utsushi crates
// depend on kaifuu crates; nothing depends on utsushi).
export function buildCrateFamilyDependents(root = repoRoot) {
  const members = readWorkspaceMembers(root).filter((member) => member.startsWith("crates/"));
  const packageFamily = new Map();
  const memberByPackage = new Map();
  for (const member of members) {
    const pkg = readPackageName(root, member);
    packageFamily.set(pkg, crateFamilyOf(pkg));
    memberByPackage.set(pkg, member);
  }
  const packageNames = new Set(packageFamily.keys());

  const directDependents = new Map(); // family -> Set(families that directly depend on it)
  for (const [pkg, member] of memberByPackage) {
    const family = packageFamily.get(pkg);
    const manifest = readFileSync(path.join(root, member, "Cargo.toml"), "utf8");
    for (const dep of workspaceDependencyNames(manifest, packageNames)) {
      const depFamily = packageFamily.get(dep);
      if (!depFamily || depFamily === family) continue;
      if (!directDependents.has(depFamily)) directDependents.set(depFamily, new Set());
      directDependents.get(depFamily).add(family);
    }
  }

  const closure = new Map();
  for (const family of new Set(packageFamily.values())) {
    const seen = new Set();
    const stack = [...(directDependents.get(family) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      for (const downstream of directDependents.get(next) ?? []) stack.push(downstream);
    }
    if (seen.size > 0) closure.set(family, [...seen].sort());
  }
  return closure;
}

// Map a changed-path set to the ordered list of `just` lanes qd-full-ci should run.
// Returns ["ci"] for a full gate, [] for a docs-only diff, or a fine-grained subset.
export function affectedCiLanes(changedPaths, options = {}) {
  const root = options.root ?? repoRoot;
  const base = affectedTasks(changedPaths);

  // Broad / shared / foundational change: run the complete gate unchanged.
  if (base.includes("ci")) return ["ci"];
  if (base.length === 0) return []; // docs-only / nothing code-affecting

  const familyDependents = options.familyDependents ?? buildCrateFamilyDependents(root);
  const lanes = new Set(base);

  // The foundational base gate (fmt/lint/typecheck/spec-dag/node-suites) runs for
  // any code change.
  lanes.add("check");

  // Repo-root fixtures/** bytes are byte-asserted by BOTH the rust tests AND the
  // apps/itotori vitest suite, neither of which runs under `just check`:
  //   * rust: kaifuu + utsushi read them via repo_fixture_path (e.g.
  //     fixtures/kaifuu/kirikiri/plain.xp3, the encrypted-matrix trees, the
  //     hello-game); those assertions run only under `cargo test` (fixtures-
  //     validate + `cargo check` never execute them).
  //   * ci-itotori: ~18 apps/itotori/test/*.test.ts files byte-assert repo-root
  //     fixtures/** via ../../../fixtures/ (cli, ingest-conformance, provider-
  //     proof, benchmark-harness, ...); those run only under `pnpm --filter
  //     @itotori/app test` (the ci-itotori lane), NOT under `just check`.
  // A fixture-byte change diverging from either expectation would ship UNCAUGHT,
  // so route repo-root fixtures to the rust gates (which drive the synthetic +
  // fixture byte assertions) AND ci-itotori.
  // (Package-local fixtures like apps/itotori/test/fixtures/** classify via
  // apps/itotori -> ci-itotori and never reach this branch.)
  if (changedPaths.some((rawPath) => rawPath.replaceAll("\\", "/").startsWith("fixtures/"))) {
    lanes.add("ci-kaifuu");
    lanes.add("ci-utsushi");
    lanes.add("ci-itotori");
  }

  // Dependency-graph expansion: a change to a crate family also runs the gates of
  // every family that depends on it.
  for (const [family, gate] of rustFamilyGate) {
    if (!lanes.has(gate)) continue;
    for (const dependent of familyDependents.get(family) ?? []) {
      const dependentGate = rustFamilyGate.get(dependent);
      if (dependentGate) lanes.add(dependentGate);
    }
  }

  // Any rust crate family in scope runs the synthetic differential guardrail.
  // mutation-differential is the source-level mutation kill matrix that certifies
  // the fast synthetic suites are AS STRONG AS the real-bytes lanes at catching
  // regressions (synthetic >= real), so per-gate CI can stay copyright-free and
  // needs no real corpora. It is deterministic (~90s) and replaces the old
  // ~30-45min per-gate real-bytes lane (now periodic-only via real-bytes-oracle).
  if (lanes.has("ci-kaifuu") || lanes.has("ci-utsushi")) lanes.add("mutation-differential");

  return laneOrder.filter((lane) => lanes.has(lane));
}

function main() {
  const changed = new Set([
    ...gitLines(["diff", "--name-only", "HEAD"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ]);
  const tasks = affectedTasks(changed);

  if (tasks.length === 0) {
    console.log("No affected task detected. Run `just ci` for a full check.");
  } else {
    console.log(tasks.map((task) => `just ${task}`).join("\n"));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
