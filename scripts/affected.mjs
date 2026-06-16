import { execFileSync } from "node:child_process";

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const changed = git(["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
const tasks = new Set();

for (const path of changed) {
  if (path.startsWith("packages/localization-bridge-schema/")) {
    tasks.add("schema");
    tasks.add("ci-itotori");
    tasks.add("ci-kaifuu");
    tasks.add("ci-utsushi");
  } else if (path.startsWith("apps/itotori/")) {
    tasks.add("ci-itotori");
  } else if (path.startsWith("crates/kaifuu-")) {
    tasks.add("ci-kaifuu");
  } else if (path.startsWith("crates/utsushi-")) {
    tasks.add("ci-utsushi");
  } else if (path.startsWith("fixtures/") || path.startsWith("justfile")) {
    tasks.add("hello");
  }
}

if (tasks.size === 0) {
  console.log("No affected task detected. Run `just ci` for a full check.");
} else {
  console.log([...tasks].map((task) => `just ${task}`).join("\n"));
}
