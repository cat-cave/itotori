import { execFileSync } from "node:child_process";

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

const changed = new Set([
  ...gitLines(["diff", "--name-only", "HEAD"]),
  ...gitLines(["ls-files", "--others", "--exclude-standard"]),
]);
const tasks = new Set();

const taskOrder = [
  "ci",
  "check",
  "schema",
  "ci-itotori",
  "ci-kaifuu",
  "ci-utsushi",
  "fixtures-validate",
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

function add(...names) {
  for (const name of names) {
    tasks.add(name);
  }
}

function addAllProjectGates() {
  add("schema", "ci-itotori", "ci-kaifuu", "ci-utsushi");
}

function addFixtureGates() {
  add("fixtures-validate", "hello");
}

function isDocsOnly(path) {
  return path === "README.md" || path.startsWith("docs/") || path.endsWith(".md");
}

function isRootPath(path) {
  return !path.includes("/");
}

for (const rawPath of changed) {
  const path = rawPath.replaceAll("\\", "/");

  if (
    broadRootFiles.has(path) ||
    (isRootPath(path) && !isDocsOnly(path)) ||
    path.startsWith(".github/") ||
    path.startsWith("scripts/")
  ) {
    add("ci");
  } else if (path.startsWith("roadmap/")) {
    add("roadmap-validate");
  } else if (path.startsWith("packages/localization-bridge-schema/")) {
    addAllProjectGates();
    add("hello");
  } else if (path.startsWith("fixtures/") || path.startsWith("packages/test-fixtures/")) {
    addFixtureGates();
  } else if (path.startsWith("apps/itotori/") || path.startsWith("packages/itotori-db/")) {
    add("ci-itotori");
  } else if (path.startsWith("apps/runtime-web-review/")) {
    add("ci-utsushi");
  } else if (path.startsWith("crates/kaifuu-")) {
    add("ci-kaifuu");
  } else if (path.startsWith("crates/utsushi-")) {
    add("ci-utsushi");
  } else if (!isDocsOnly(path)) {
    add("check");
  }
}

if (tasks.has("ci")) {
  tasks.delete("check");
  tasks.delete("schema");
  tasks.delete("ci-itotori");
  tasks.delete("ci-kaifuu");
  tasks.delete("ci-utsushi");
  tasks.delete("roadmap-validate");
}

if (tasks.has("check")) {
  tasks.delete("roadmap-validate");
}

if (tasks.size === 0) {
  console.log("No affected task detected. Run `just ci` for a full check.");
} else {
  console.log(
    taskOrder
      .filter((task) => tasks.has(task))
      .map((task) => `just ${task}`)
      .join("\n"),
  );
}
