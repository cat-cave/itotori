import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// KAIFUU-208: pin the supply-chain strictness of deny.toml so a future edit
// cannot silently relax `bans.multiple-versions` back to "warn" or reopen
// `bans.wildcards`, and so every accepted duplicate-version `[[bans.skip]]`
// stays documented with a `# reason:` line. See docs/dependency-policy.md.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const denyPath = resolve(root, "deny.toml");
const lines = readFileSync(denyPath, "utf8").split(/\r?\n/);

const failures = [];

const hasStrictSetting = (key) =>
  lines.some((line) => new RegExp(`^${key} = "deny"\\s*(?:#.*)?$`).test(line));

if (!hasStrictSetting("multiple-versions")) {
  failures.push('deny.toml: [bans] multiple-versions must be "deny"');
}
if (!hasStrictSetting("wildcards")) {
  failures.push('deny.toml: [bans] wildcards must be "deny"');
}

// Every `[[bans.skip]]` entry must be documented: the line immediately above
// the array-of-tables header must be a `# reason:` comment.
const isReasonComment = (line) => /^#\s*reason:\s*\S/i.test((line ?? "").trim());

let skipCount = 0;
lines.forEach((line, index) => {
  if (line.trim() !== "[[bans.skip]]") {
    return;
  }
  skipCount += 1;

  // Capture the crate name for a clearer error message.
  const nameLine = lines
    .slice(index + 1, index + 5)
    .find((candidate) => candidate.trim().startsWith("name ="));
  const nameMatch = nameLine?.match(/name\s*=\s*"([^"]+)"/);
  const label = nameMatch ? `skip '${nameMatch[1]}'` : `skip at line ${index + 1}`;

  if (!isReasonComment(lines[index - 1])) {
    failures.push(
      `deny.toml: ${label} must have a "# reason:" comment on the line immediately above its [[bans.skip]] entry`,
    );
  }
});

if (skipCount === 0) {
  // Not a failure — the workspace may legitimately have no accepted duplicates
  // — but note it so a silently-emptied skip list is visible in the log.
  console.log("verify-deny-strict: no [[bans.skip]] entries present");
}

if (failures.length > 0) {
  console.error("deny.toml strictness verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `deny.toml strictness verified (multiple-versions="deny", wildcards="deny", ${skipCount} documented skip(s))`,
);
