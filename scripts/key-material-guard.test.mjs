import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { inspectIndex, sensitivePathReason } from "./key-material-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "key-material-guard.mjs");
const pemHeader = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

function git(root, ...args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "key-material-guard-"));
  git(root, "init", "-q");
  return root;
}

function runCli(root) {
  return spawnSync("node", [scriptPath, "--root", root], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("recognizes guarded extensions case-insensitively", () => {
  for (const path of [
    "app.pem",
    "nested/app.KEY",
    "token.P8",
    "identity.p12",
    "archive.PfX",
    "key.pkcs8",
    "key.PKCS12",
  ]) {
    assert.match(sensitivePathReason(path), /private-key extension/u, path);
  }
  assert.equal(sensitivePathReason("cert.crt"), null);
});

test("recognizes conventional private-key basenames but permits public keys", () => {
  for (const path of [
    "id_rsa",
    "keys/id_dsa",
    "keys/id_ecdsa",
    "keys/id_ed25519",
    "private-key",
    "private_key",
    "privateKey",
  ]) {
    assert.match(sensitivePathReason(path), /private-key basename/u, path);
  }
  assert.equal(sensitivePathReason("id_ed25519.pub"), null);
});

test("CLI rejects a staged PEM header under an innocuous filename", () => {
  const root = repository();
  writeFileSync(join(root, "notes.txt"), `${pemHeader}\nsynthetic-test-payload\n`);
  git(root, "add", "--", "notes.txt");

  const result = runCli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /key-material guard: FAILED/u);
  assert.match(result.stderr, /notes\.txt  PEM private-key header/u);
  assert.doesNotMatch(result.stderr, /synthetic-test-payload/u);
});

test("content scanning uses the staged blob instead of an unstaged replacement", () => {
  const root = repository();
  writeFileSync(join(root, "notes.txt"), `${pemHeader}\nindexed-only\n`);
  git(root, "add", "--", "notes.txt");
  writeFileSync(join(root, "notes.txt"), "benign working-tree replacement\n");

  assert.deepEqual(inspectIndex(root).violations, [
    { path: "notes.txt", reason: "PEM private-key header" },
  ]);
});

test("force-added guarded filenames fail even when their content is benign", () => {
  const root = repository();
  writeFileSync(join(root, ".gitignore"), "*.[pP][eE][mM]\n");
  writeFileSync(join(root, "app.pem"), "benign test content\n");
  git(root, "add", "--", ".gitignore");
  git(root, "add", "-f", "--", "app.pem");

  const result = runCli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /app\.pem  private-key extension \.pem/u);
});

test("CLI passes a clean index and states its detection limit", () => {
  const root = repository();
  writeFileSync(join(root, "notes.txt"), "benign staged text\n");
  git(root, "add", "--", "notes.txt");

  const result = runCli(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 indexed path\(s\) scanned; 0 violations/u);
  assert.match(result.stdout, /untracked\/ignored files are outside its view/u);
  assert.match(result.stdout, /binary, encoded, split, or obfuscated key material/u);
});

test("the meta gate runs the guard test before the guard", () => {
  const command = readFileSync(join(here, "developer-command.mjs"), "utf8");
  const testInvocation = "node --test scripts/key-material-guard.test.mjs";
  const guardInvocation = "node scripts/key-material-guard.mjs";
  assert.ok(command.includes(testInvocation));
  assert.ok(command.includes(guardInvocation));
  assert.ok(command.indexOf(testInvocation) < command.indexOf(guardInvocation));
});
