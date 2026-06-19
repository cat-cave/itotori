#!/usr/bin/env node
// CLI for the spec-dag dashboard generator.
//
//   spec-dag-dashboard            regenerate then open in the browser
//   spec-dag-dashboard --no-open  regenerate only (CI / smoke)
//   spec-dag-dashboard --watch    watch roadmap/spec-dag.json, regenerate on
//                                 change (debounced), open once
//
// Opening is best-effort and WSL2-aware; a failed open must never fail
// generation.

import { execFile, execFileSync } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { resolve } from "node:path";

import { generateDashboard, printSummary, repoRoot } from "./generate.js";

function isWsl(): boolean {
  if (process.env["WSL_DISTRO_NAME"]) return true;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Open a file in the default browser. Fire-and-forget; never throws. */
function openInBrowser(filePath: string): void {
  try {
    if (isWsl()) {
      let winPath = filePath;
      try {
        winPath = execFileSync("wslpath", ["-w", filePath], { encoding: "utf8" }).trim();
      } catch {
        // fall back to the posix path; cmd.exe may still resolve it
      }
      execFile("cmd.exe", ["/c", "start", "", winPath], () => {});
      return;
    }
    if (process.platform === "darwin") {
      execFile("open", [filePath], () => {});
      return;
    }
    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", filePath], () => {});
      return;
    }
    execFile("xdg-open", [filePath], () => {});
  } catch {
    // opening must never fail generation
  }
}

async function regenerate(): Promise<string> {
  const result = await generateDashboard();
  printSummary(result);
  return result.outPath;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noOpen = args.includes("--no-open");
  const watchMode = args.includes("--watch");

  if (watchMode) {
    const root = repoRoot();
    const watchTarget = resolve(root, "roadmap/spec-dag.json");
    const outPath = await regenerate();
    if (!noOpen) openInBrowser(outPath);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    process.stdout.write(`watching ${watchTarget} (ctrl-c to stop)\n`);
    watch(watchTarget, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (running) return;
        running = true;
        regenerate()
          .catch((err: unknown) => {
            process.stderr.write(`dashboard regeneration failed: ${String(err)}\n`);
          })
          .finally(() => {
            running = false;
          });
      }, 150);
    });
    return;
  }

  const outPath = await regenerate();
  if (!noOpen) openInBrowser(outPath);
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
