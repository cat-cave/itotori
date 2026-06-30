import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  "hello",
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
  add(tasks, "fixtures-validate", "hello");
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
      add(tasks, "hello");
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
