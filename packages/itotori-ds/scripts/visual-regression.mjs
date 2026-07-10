#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const storybookDir = path.join(packageRoot, ".tmp", "visual-regression", "storybook-static");
const workDir = path.join(packageRoot, ".tmp", "visual-regression");
const actualDir = path.join(workDir, "actual");
const diffDir = path.join(workDir, "diff");
const baselineDir = path.join(packageRoot, "test", "visual-baselines");
const manifestPath = path.join(baselineDir, "manifest.json");
const viewport = { width: 1280, height: 800 };
const update = process.argv.includes("--update");
const maxDiffPixels = 0;

const deterministicCss = `
*,
*::before,
*::after {
  animation-delay: -1ms !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
}

html,
body {
  min-width: ${viewport.width}px !important;
  min-height: ${viewport.height}px !important;
  overflow: hidden !important;
}
`;

function typedBlocker({ type, reason, needed, evidence }) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        blocker: {
          type,
          reason,
          owner: "environment",
          needed,
          evidence,
        },
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return `sha256:${hash.digest("hex")}`;
}

// Visible SKIP (exit 0) when the genuine resource — a pinned Chromium — is not
// provisioned. DS visual regression is a BROWSER oracle: it belongs in the
// browser lane, not the portable PR lane. The Nix dev-shell exports
// PLAYWRIGHT_CHROMIUM_BIN/UTSUSHI_BROWSER_BIN, so it RUNS locally; a generic
// hosted runner sets neither, so it self-skips rather than false-red `just ci`.
// A binary that IS configured but unreachable stays a hard blocker (an operator
// opted in with a bad path — a real misconfiguration, not an absent resource).
function skipNoBrowser() {
  console.log(
    JSON.stringify(
      {
        ok: true,
        skipped: true,
        reason:
          "DS visual regression skipped: no Chromium provisioned (set PLAYWRIGHT_CHROMIUM_BIN or UTSUSHI_BROWSER_BIN to run it).",
        lane: "browser-oracle (not the portable PR lane)",
        evidence: "docs/native-deps-provisioning.md documents the browser env contract.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

function browserExecutable() {
  const candidate = process.env.PLAYWRIGHT_CHROMIUM_BIN ?? process.env.UTSUSHI_BROWSER_BIN;
  if (!candidate) {
    skipNoBrowser();
  }
  return candidate;
}

async function assertRunnableBrowser(executablePath) {
  try {
    const entry = await stat(executablePath);
    if (!entry.isFile()) throw new Error("not a file");
  } catch (error) {
    typedBlocker({
      type: "environment",
      reason: `Configured Chromium binary is not reachable: ${executablePath}`,
      needed: "Point PLAYWRIGHT_CHROMIUM_BIN or UTSUSHI_BROWSER_BIN at a runnable Chromium binary.",
      evidence: String(error),
    });
  }
}

async function readStoryIndex() {
  const index = JSON.parse(await readFile(path.join(storybookDir, "index.json"), "utf8"));
  return Object.values(index.entries)
    .filter((entry) => entry.type === "story")
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      name: entry.name,
      importPath: entry.importPath,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

async function startStaticServer(root) {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const unsafePath = decodeURIComponent(requestUrl.pathname);
    const relativePath = unsafePath === "/" ? "index.html" : unsafePath.replace(/^\/+/, "");
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(root)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const entry = await stat(filePath);
      const resolvedPath = entry.isDirectory() ? path.join(filePath, "index.html") : filePath;
      response.writeHead(200, { "content-type": contentType(resolvedPath) });
      createReadStream(resolvedPath).pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind static server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function captureStories(stories, baseUrl, executablePath) {
  const browser = await chromium.launch({
    executablePath,
    args: ["--font-render-hinting=none"],
  });
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC",
    });
    await context.route("**/*", async (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host === "127.0.0.1" || host === "localhost") {
        await route.continue();
        return;
      }
      await route.abort();
    });
    const page = await context.newPage();
    const screenshots = [];
    for (const story of stories) {
      try {
        const url = `${baseUrl}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
        await page.goto(url, { waitUntil: "networkidle" });
        await page.addStyleTag({ content: deterministicCss });
        await page.waitForFunction(() => {
          return document.body.classList.contains("sb-show-main");
        });
        await page.evaluate(async () => {
          if ("fonts" in document) await document.fonts.ready;
        });
        const screenshot = await page.screenshot({
          animations: "disabled",
          caret: "hide",
          scale: "css",
          fullPage: false,
        });
        const actualPath = path.join(actualDir, `${story.id}.png`);
        await writeFile(actualPath, screenshot);
        screenshots.push({ ...story, actualPath });
      } catch (error) {
        throw new Error(
          `failed to capture Storybook story ${story.id} (${story.title} / ${story.name})`,
          {
            cause: error,
          },
        );
      }
    }
    await context.close();
    return screenshots;
  } finally {
    await browser.close();
  }
}

async function readPng(filePath) {
  return PNG.sync.read(await readFile(filePath));
}

async function compareImages(expectedPath, actualPath, diffPath) {
  const expected = await readPng(expectedPath);
  const actual = await readPng(actualPath);
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      diffPixels: Number.POSITIVE_INFINITY,
      reason: `dimension mismatch: expected ${expected.width}x${expected.height}, actual ${actual.width}x${actual.height}`,
    };
  }
  const diff = new PNG({ width: expected.width, height: expected.height });
  const diffPixels = pixelmatch(
    expected.data,
    actual.data,
    diff.data,
    expected.width,
    expected.height,
    {
      threshold: 0.05,
    },
  );
  if (diffPixels > 0) {
    await writeFile(diffPath, PNG.sync.write(diff));
  }
  return { diffPixels };
}

async function loadManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`missing visual baseline manifest: ${manifestPath}`);
  }
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function writeBaselines(screenshots, stories, executablePath) {
  await mkdir(baselineDir, { recursive: true });
  const manifestStories = [];
  for (const screenshot of screenshots) {
    const baselinePath = path.join(baselineDir, `${screenshot.id}.png`);
    await writeFile(baselinePath, await readFile(screenshot.actualPath));
    manifestStories.push({
      id: screenshot.id,
      title: screenshot.title,
      name: screenshot.name,
      importPath: screenshot.importPath,
      baseline: `${screenshot.id}.png`,
      sha256: await sha256(baselinePath),
    });
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        generatedBy: "packages/itotori-ds/scripts/visual-regression.mjs --update",
        storybook: "10.4.1",
        browserContract: "PLAYWRIGHT_CHROMIUM_BIN or UTSUSHI_BROWSER_BIN",
        browserExecutable: path.basename(executablePath),
        viewport,
        deviceScaleFactor: 1,
        colorScheme: "dark",
        reducedMotion: "reduce",
        maxDiffPixels,
        storyCount: stories.length,
        stories: manifestStories,
      },
      null,
      2,
    )}\n`,
  );
}

function assertSameStorySet(stories, manifest) {
  const actual = stories.map((story) => story.id);
  const expected = manifest.stories.map((story) => story.id);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Storybook story set differs from visual baselines.\nexpected=${JSON.stringify(
        expected,
      )}\nactual=${JSON.stringify(actual)}`,
    );
  }
}

async function proveDiffFailure(screenshot) {
  const baselinePath = path.join(baselineDir, `${screenshot.id}.png`);
  const mutated = await readPng(screenshot.actualPath);
  mutated.data[0] = 255 - mutated.data[0];
  mutated.data[1] = 255 - mutated.data[1];
  mutated.data[2] = 255 - mutated.data[2];
  const mutatedPath = path.join(workDir, "diff-failure-proof.png");
  await writeFile(mutatedPath, PNG.sync.write(mutated));
  const proof = await compareImages(
    baselinePath,
    mutatedPath,
    path.join(diffDir, "diff-failure-proof.diff.png"),
  );
  if (proof.diffPixels <= maxDiffPixels) {
    throw new Error("visual diff failure proof did not fail after a real PNG pixel change");
  }
  return proof.diffPixels;
}

async function verifyBaselines(screenshots, stories) {
  const manifest = await loadManifest();
  assertSameStorySet(stories, manifest);
  const failures = [];
  for (const screenshot of screenshots) {
    const baselinePath = path.join(baselineDir, `${screenshot.id}.png`);
    if (!existsSync(baselinePath)) {
      failures.push({ id: screenshot.id, reason: "missing baseline PNG" });
      continue;
    }
    const comparison = await compareImages(
      baselinePath,
      screenshot.actualPath,
      path.join(diffDir, `${screenshot.id}.diff.png`),
    );
    if (comparison.diffPixels > maxDiffPixels) {
      failures.push({ id: screenshot.id, ...comparison });
    }
  }
  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, failures, diffDir }, null, 2));
    process.exit(1);
  }
  const proofDiffPixels = await proveDiffFailure(screenshots[0]);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "verify",
        storyCount: stories.length,
        viewport,
        maxDiffPixels,
        diffFailureProof: { storyId: screenshots[0].id, diffPixels: proofDiffPixels },
      },
      null,
      2,
    ),
  );
}

async function main() {
  const executablePath = browserExecutable();
  await assertRunnableBrowser(executablePath);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(actualDir, { recursive: true });
  await mkdir(diffDir, { recursive: true });
  run("pnpm", [
    "exec",
    "storybook",
    "build",
    "--output-dir",
    storybookDir,
    "--disable-telemetry",
    "--test",
    "--quiet",
  ]);
  const stories = await readStoryIndex();
  if (stories.length === 0) throw new Error("Storybook index contains zero stories");
  const server = await startStaticServer(storybookDir);
  try {
    const screenshots = await captureStories(stories, server.baseUrl, executablePath);
    if (update) {
      await writeBaselines(screenshots, stories, executablePath);
      console.log(
        JSON.stringify(
          { ok: true, mode: "update", storyCount: stories.length, baselineDir },
          null,
          2,
        ),
      );
      return;
    }
    await verifyBaselines(screenshots, stories);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
