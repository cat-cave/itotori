import { spawnSync } from "node:child_process";

export function runCargoTest({ crates, ignored, cwd, env }) {
  const pflags = crates.map((crateName) => `-p ${crateName}`).join(" ");
  const ignoredFlag = ignored ? " -- --ignored" : "";
  const cmd = `cargo test ${pflags} --quiet${ignoredFlag}`;
  const started = Date.now();
  const result = spawnSync(cmd, {
    shell: true,
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return { status: result.status, output, elapsedMs: Date.now() - started, cmd };
}
