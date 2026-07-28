// THE RENDERER CONTRACT for the pixel-exact browser oracles.
//
// The DS visual baselines are compared at maxDiffPixels=0, and a screenshot is
// a function of THREE host inputs: the browser binary, the faces fontconfig
// resolves for it, and the rasterization path Chromium picks from the machine.
// The DS type stacks are art direction rather than repo-shipped font files, so
// every family falls through to a generic (`system-ui`, `sans-serif`,
// `monospace`) that an unpinned host answers with whatever it has installed.
// `flake.nix` pins the first two and exports them (this asserts them); the
// third is pinned by `rasterizationArgs` in the visual runner.
//
// WHY IT IS A HARD FAILURE. This check previously lived at the BOTTOM of
// `just ci tier1-browser` and green-SKIPPED when the contract was unmet — and
// CI provisioned Playwright's own downloaded Chromium, so it was unmet on every
// run. The pixel assertions therefore never executed on a single PR, and three
// stale baselines sat red on `main` behind an all-green check. A lane that
// cannot assert must be LOUD, not quiet, so an unmet contract is now red.
//
// ITOTORI_DS_VISUAL_STRICT=1 is the single opt-out, for an operator who
// deliberately rebased the baselines onto another renderer.

import { accessSync, constants, readFileSync } from "node:fs";

const NIX_STORE = "/nix/store/";

const realReadFonts = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const realIsExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function evaluateRendererContract(
  env,
  { isExecutable = realIsExecutable, readFonts = realReadFonts } = {},
) {
  const bin = env.PLAYWRIGHT_CHROMIUM_BIN || env.UTSUSHI_BROWSER_BIN || "";
  const fonts = env.FONTCONFIG_FILE || "";
  const override = env.ITOTORI_DS_VISUAL_STRICT === "1";

  // Runnability is checked even under the override: a strict operator still
  // needs a browser, and "no Chromium at all" must never reach the e2e as a
  // green run with the browser unexercised.
  if (bin === "" || !isExecutable(bin)) {
    return {
      ok: false,
      bin,
      fonts,
      override,
      subject: "runnable",
      detail: `no runnable Chromium — PLAYWRIGHT_CHROMIUM_BIN / UTSUSHI_BROWSER_BIN is unset or not executable ("${bin}")`,
      why: "Refusing to pass with the browser e2e unexercised (strict lane, no green-on-skip).",
    };
  }
  if (override) {
    return { ok: true, bin, fonts, override };
  }
  if (!bin.startsWith(NIX_STORE)) {
    return {
      ok: false,
      bin,
      fonts,
      override,
      subject: "Chromium",
      detail: `Chromium is not nix-store ("${bin}")`,
      why: "Baselines are captured under the flake.nix Chromium; another renderer cannot assert them.",
    };
  }
  if (!fonts.startsWith(NIX_STORE)) {
    return {
      ok: false,
      bin,
      fonts,
      override,
      subject: "fonts",
      detail: `FONTCONFIG_FILE is not nix-pinned ("${fonts}")`,
      why: "The DS type stacks fall through to system-ui / sans-serif / monospace, which an unpinned host answers with its own faces.",
    };
  }
  const leak = fontsConfigLeak(readFonts(fonts));
  if (leak) {
    return {
      ok: false,
      bin,
      fonts,
      override,
      subject: "fonts",
      detail: leak.detail,
      why: leak.why,
    };
  }
  return { ok: true, bin, fonts, override };
}

// A nix-store PATH is not the same thing as a hermetic CONFIG. `makeFontsConf`
// emits a store path that still pulls in `<include>/etc/fonts/conf.d` and
// `<dir>/usr/share/fonts`, so the pinned-looking file happily inherits the
// host's rendering rules and font universe. That is precisely how 32 of 35
// stories differed on CI while every path looked pinned, so the contract checks
// the file's CONTENT, not just where it lives.
export function fontsConfigLeak(raw) {
  if (raw === undefined) return undefined; // unreadable is handled by the caller
  // Comments first: the hermetic config EXPLAINS why it has no <include>, and a
  // naive scan flags that prose as the very leak it is describing.
  const text = raw.replace(/<!--[\s\S]*?-->/g, "");
  if (/<include\b/.test(text)) {
    return {
      detail: "the pinned fontconfig file still has an <include> directive",
      why: "An <include> re-admits the host's /etc/fonts/conf.d rendering rules (hinting, subpixel), which change every glyph.",
    };
  }
  const dirs = [...text.matchAll(/<dir\b[^>]*>([^<]*)<\/dir>/g)].map((m) => m[1].trim());
  const outside = dirs.filter((d) => !d.startsWith(NIX_STORE));
  if (outside.length > 0) {
    return {
      detail: `the pinned fontconfig file lists non-store font directories: ${outside.join(", ")}`,
      why: "A host font directory puts faces in the universe that only exist on one machine, so the same CSS resolves differently elsewhere.",
    };
  }
  return undefined;
}

function main() {
  const result = evaluateRendererContract(process.env);
  if (result.ok) {
    const fonts = result.override ? "<strict-override>" : result.fonts;
    console.log(`renderer contract ok (chromium=${result.bin} fonts=${fonts})`);
    return;
  }
  console.error(`renderer contract UNMET — ${result.detail}.`);
  console.error(`  ${result.why}`);
  console.error(
    "  Run the lane inside the dev shell (`nix develop --command just ci tier1-browser`, or",
  );
  console.error("  `nix develop .#browser --command …` in CI), or set ITOTORI_DS_VISUAL_STRICT=1");
  console.error("  if you intentionally rebased the baselines for this renderer.");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
