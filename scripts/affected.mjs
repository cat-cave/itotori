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
    } else if (path.startsWith("suite/scripts/localize-project/")) {
      add(tasks, "localize-project-test");
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
//     scripts/, .github/, root files) -> affectedTasks() collapses to the `ci`
//     sentinel, so affectedCiLanes() returns exactly ["ci"] (the FULL gate).
//   * apps/itotori-only / TS-only change -> ci-itotori (+ check); NO rust
//     build/test and NO ci-real-bytes lane.
//   * a crates/kaifuu-* or crates/utsushi-* change -> that family's rust gate
//     PLUS the (monolithic) ci-real-bytes lane, expanded dependency-graph-
//     correct: a change to a crate family that another family depends on also
//     runs the dependents' gate (utsushi depends on kaifuu, so a kaifuu change
//     runs ci-utsushi too).
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
  "ci-real-bytes",
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

  // Repo-root fixtures/** bytes are byte-asserted by rust tests (kaifuu + utsushi
  // read them via repo_fixture_path — e.g. fixtures/kaifuu/kirikiri/plain.xp3, the
  // encrypted-matrix trees, the hello-game). Those assertions only run under
  // `cargo test` (fixtures-validate + `cargo check` never execute them), so a
  // fixture-byte change that diverges from a rust expectation would ship UNCAUGHT.
  // Route repo-root fixtures to the rust gates + real-bytes. (Package-local
  // fixtures like apps/itotori/test/fixtures/** classify via apps/itotori ->
  // ci-itotori and never reach this branch — they are not read by rust.)
  if (changedPaths.some((rawPath) => rawPath.replaceAll("\\", "/").startsWith("fixtures/"))) {
    lanes.add("ci-kaifuu");
    lanes.add("ci-utsushi");
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

  // Any rust crate family in scope runs the monolithic real-bytes lane. ci-real-bytes
  // is a single recipe spanning every crate's real-bytes suite, so any crate change
  // that could touch it selects the whole lane (conservative, never partial).
  if (lanes.has("ci-kaifuu") || lanes.has("ci-utsushi")) lanes.add("ci-real-bytes");

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
