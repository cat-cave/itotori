// @itotori-meta-check
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRendererContract, fontsConfigLeak } from "./assert-renderer-contract.mjs";

// Every case below supplies a runnable browser unless it is testing runnability,
// so the assertions are about the CONTRACT and not about this machine's disk.
const HERMETIC_CONF = `<fontconfig>
  <dir>/nix/store/aaaa-noto-fonts</dir>
  <dir>/nix/store/bbbb-hack-font</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>`;

// Shape emitted by pkgs.makeFontsConf: a /nix/store path that is nonetheless
// wide open to the host. This is the config CI actually ran with.
const LEAKY_CONF = `<fontconfig>
  <include ignore_missing="yes">/etc/fonts/conf.d</include>
  <dir>/nix/store/aaaa-noto-fonts</dir>
  <dir>/usr/share/fonts</dir>
</fontconfig>`;

const runnable = { isExecutable: () => true, readFonts: () => HERMETIC_CONF };

const NIX_CHROMIUM = "/nix/store/aaaa-chromium-149.0.0/bin/chromium";
const NIX_FONTS = "/nix/store/bbbb-fonts.conf";

test("both halves nix-pinned satisfies the contract", () => {
  const result = evaluateRendererContract(
    {
      PLAYWRIGHT_CHROMIUM_BIN: NIX_CHROMIUM,
      FONTCONFIG_FILE: NIX_FONTS,
    },
    runnable,
  );
  assert.equal(result.ok, true);
  assert.equal(result.bin, NIX_CHROMIUM);
});

test("UTSUSHI_BROWSER_BIN is an accepted alias for the renderer", () => {
  const result = evaluateRendererContract(
    {
      UTSUSHI_BROWSER_BIN: NIX_CHROMIUM,
      FONTCONFIG_FILE: NIX_FONTS,
    },
    runnable,
  );
  assert.equal(result.ok, true);
});

// The exact CI situation this guard exists for: a perfectly runnable Chromium
// that is simply not the one the baselines were captured under. It used to be
// reported as a capability miss and PASS the lane.
test("a runnable non-nix Chromium is a failure, not a skip", () => {
  const result = evaluateRendererContract(
    {
      PLAYWRIGHT_CHROMIUM_BIN: "/home/runner/.cache/ms-playwright/chromium-1200/chrome",
      FONTCONFIG_FILE: NIX_FONTS,
    },
    runnable,
  );
  assert.equal(result.ok, false);
  assert.equal(result.subject, "Chromium");
});

// Pinning the binary alone is NOT enough: the same Chromium rasterizes text
// through whatever faces the host resolves, and every DS family falls through
// to a generic.
test("nix Chromium with unpinned fonts is still a failure", () => {
  const result = evaluateRendererContract(
    {
      PLAYWRIGHT_CHROMIUM_BIN: NIX_CHROMIUM,
      FONTCONFIG_FILE: "",
    },
    runnable,
  );
  assert.equal(result.ok, false);
  assert.equal(result.subject, "fonts");
});

test("an absent renderer fails on runnability", () => {
  const result = evaluateRendererContract({}, runnable);
  assert.equal(result.ok, false);
  assert.equal(result.subject, "runnable");
});

// A configured-but-unreachable binary is an operator misconfiguration, and it
// stays red even under the strict override.
test("a non-executable binary fails even with the strict override set", () => {
  const result = evaluateRendererContract(
    { PLAYWRIGHT_CHROMIUM_BIN: "/nowhere/chromium", ITOTORI_DS_VISUAL_STRICT: "1" },
    { isExecutable: () => false },
  );
  assert.equal(result.ok, false);
  assert.equal(result.subject, "runnable");
});

test("ITOTORI_DS_VISUAL_STRICT=1 is the one deliberate opt-out", () => {
  const result = evaluateRendererContract(
    {
      PLAYWRIGHT_CHROMIUM_BIN: "/usr/bin/chromium",
      ITOTORI_DS_VISUAL_STRICT: "1",
    },
    runnable,
  );
  assert.equal(result.ok, true);
  assert.equal(result.override, true);
});

test("only the exact value 1 opts out", () => {
  const result = evaluateRendererContract(
    {
      PLAYWRIGHT_CHROMIUM_BIN: "/usr/bin/chromium",
      ITOTORI_DS_VISUAL_STRICT: "true",
    },
    runnable,
  );
  assert.equal(result.ok, false);
});

// --- the config CONTENT check -------------------------------------------------
// A nix-store path proved nothing: the file CI ran with lived in the store and
// still inherited the host's rendering rules and font dirs.

test("a hermetic fontconfig file reports no leak", () => {
  assert.equal(fontsConfigLeak(HERMETIC_CONF), undefined);
});

test("an <include> is a leak — it re-admits host rendering rules", () => {
  const leak = fontsConfigLeak(LEAKY_CONF);
  assert.ok(leak);
  assert.match(leak.detail, /<include>/);
});

test("a non-store font directory is a leak", () => {
  const leak = fontsConfigLeak(`<fontconfig>
  <dir>/nix/store/aaaa-noto-fonts</dir>
  <dir>/usr/share/fonts</dir>
</fontconfig>`);
  assert.ok(leak);
  assert.match(leak.detail, /\/usr\/share\/fonts/);
});

test("a store-path-but-leaky config FAILS the whole contract", () => {
  const result = evaluateRendererContract(
    { PLAYWRIGHT_CHROMIUM_BIN: NIX_CHROMIUM, FONTCONFIG_FILE: NIX_FONTS },
    { isExecutable: () => true, readFonts: () => LEAKY_CONF },
  );
  assert.equal(result.ok, false);
  assert.equal(result.subject, "fonts");
});

// The hermetic config documents its own absence of an <include>; a scan that
// does not strip comments flags that prose and rejects a correct config.
test("prose mentioning <include> inside a comment is not a leak", () => {
  assert.equal(
    fontsConfigLeak(`<fontconfig>
  <!-- The ENTIRE font universe. No <include>, so no host conf.d rule applies. -->
  <dir>/nix/store/aaaa-noto-fonts</dir>
</fontconfig>`),
    undefined,
  );
});

test("a commented-out <dir> outside the store is not a leak either", () => {
  assert.equal(
    fontsConfigLeak(`<fontconfig>
  <!-- <dir>/usr/share/fonts</dir> deliberately omitted -->
  <dir>/nix/store/aaaa-noto-fonts</dir>
</fontconfig>`),
    undefined,
  );
});
