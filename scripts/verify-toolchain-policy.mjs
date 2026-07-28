import { readFileSync } from "node:fs";

const failures = [];
const missingRecipes = new Set();

const read = (path) => readFileSync(path, "utf8");
const has = (path, pattern, message) => {
  if (!pattern.test(read(path))) {
    failures.push(`${path}: ${message}`);
  }
};

const hasNot = (path, pattern, message) => {
  if (pattern.test(read(path))) {
    failures.push(`${path}: ${message}`);
  }
};

const stripInlineComment = (value) => value.replace(/\s+#.*$/, "");

const parseJustRecipeHeader = (line) => {
  const match = line.match(/^@?([A-Za-z0-9_-]+)(.*)$/);
  if (!match) {
    return undefined;
  }

  const [, name, rest] = match;
  const colonIndex = rest.indexOf(":");
  if (colonIndex === -1 || rest[colonIndex + 1] === "=") {
    return undefined;
  }

  const beforeColon = rest.slice(0, colonIndex);
  if (beforeColon !== "" && !/^\s/.test(beforeColon)) {
    return undefined;
  }

  const dependencyText = stripInlineComment(rest.slice(colonIndex + 1)).trim();
  return {
    dependencies: dependencyText === "" ? [] : dependencyText.split(/\s+/),
    name,
  };
};

const parseJustRecipes = (source) => {
  const recipes = new Map();
  let currentRecipe;

  source.split(/\r?\n/).forEach((rawLine, index) => {
    if (/^\s/.test(rawLine)) {
      if (currentRecipe) {
        const command = rawLine.trim();
        if (command !== "" && !command.startsWith("#")) {
          currentRecipe.commands.push(command.replace(/^[@+-]+/, "").trim());
        }
      }
      return;
    }

    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("[")) {
      return;
    }

    const recipe = parseJustRecipeHeader(line);
    if (!recipe) {
      currentRecipe = undefined;
      return;
    }

    currentRecipe = {
      ...recipe,
      commands: [],
      line: index + 1,
    };
    recipes.set(recipe.name, currentRecipe);
  });

  return recipes;
};

const packageJson = JSON.parse(read("package.json"));
const nodeVersion = read(".node-version").trim();
const justRecipes = parseJustRecipes(read("justfile"));

const recipe = (recipeName) => {
  const value = justRecipes.get(recipeName);
  if (!value && !missingRecipes.has(recipeName)) {
    failures.push(`justfile: missing ${recipeName} recipe`);
    missingRecipes.add(recipeName);
  }
  return value;
};

const hasRecipeCommand = (recipeName, expectedCommand, message) => {
  const value = recipe(recipeName);
  if (value && !value.commands.includes(expectedCommand)) {
    failures.push(`justfile ${recipeName}: ${message}`);
  }
};

const hasExactRecipeCommands = (recipeName, expectedCommands, message) => {
  const value = recipe(recipeName);
  if (!value) {
    return;
  }

  const hasExpectedBody =
    value.commands.length === expectedCommands.length &&
    expectedCommands.every((command, index) => value.commands[index] === command);

  if (!hasExpectedBody) {
    failures.push(`justfile ${recipeName}: ${message}; expected ${expectedCommands.join(" -> ")}`);
  }
};

const hasRecipeDependency = (recipeName, expectedDependency, message) => {
  const value = recipe(recipeName);
  if (value && !value.dependencies.includes(expectedDependency)) {
    failures.push(`justfile ${recipeName}: ${message}`);
  }
};

const parsePnpmPackageManagerVersion = (value) => {
  const match = /^pnpm@(?<version>\d+\.\d+\.\d+)(?:\+sha512\.[0-9a-f]+)?$/iu.exec(value ?? "");
  return match?.groups?.version;
};

if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
  failures.push(".node-version: must pin an exact Node version");
}

const pnpmVersion = parsePnpmPackageManagerVersion(packageJson.packageManager);
if (!pnpmVersion) {
  failures.push(
    "package.json: packageManager must pin an exact pnpm version with optional Corepack integrity metadata",
  );
} else if (packageJson.engines?.pnpm !== `>=${pnpmVersion}`) {
  failures.push("package.json: engines.pnpm must match packageManager minimum");
}

if (packageJson.engines?.node !== `>=${nodeVersion}`) {
  failures.push("package.json: engines.node must match .node-version minimum");
}

// The Rust channel is PINNED to an exact release (not a floating `stable`) so
// the runner and local shells resolve the identical clippy/rustc — a floating
// channel is the documented source of local-green/runner-red `-D warnings`
// drift. The CI action's `toolchain:` input must match this pin (asserted below).
const rustChannel = read("rust-toolchain.toml").match(/channel\s*=\s*"(?<channel>[^"]+)"/u)?.groups
  ?.channel;
if (rustChannel === undefined) {
  failures.push("rust-toolchain.toml: channel must be set");
} else if (rustChannel === "stable" || !/^\d+\.\d+\.\d+$/u.test(rustChannel)) {
  failures.push(
    `rust-toolchain.toml: channel must pin an exact stable release (got "${rustChannel}"); floating "stable" causes clippy version drift`,
  );
}
has("rust-toolchain.toml", /"rustfmt"/, "rustfmt component must be installed");
has("rust-toolchain.toml", /"clippy"/, "clippy component must be installed");

// Toolchain pinning lives in the shared composite action. The workflows use the
// parameterized CI delegate; DATABASE_URL for DB-backed suites is wired on
// `_tier1.yml`'s `db` job.
const setupAction = ".github/actions/setup-itotori/action.yml";
has(setupAction, /node-version-file:\s*\.node-version/, "CI must use .node-version");
has(setupAction, /pnpm install --frozen-lockfile/, "CI must use frozen pnpm installs");
has(
  setupAction,
  /dtolnay\/rust-toolchain@e97e2d8cc328f1b50210efc529dca0028893a2d9\s+# v1/,
  "CI must install the Rust toolchain via the immutable dtolnay/rust-toolchain v1 commit",
);
// The composite action's `toolchain:` input must match the exact
// rust-toolchain.toml pin, so the runner never resolves a different compiler
// than the pin claims.
if (rustChannel !== undefined && /^\d+\.\d+\.\d+$/u.test(rustChannel)) {
  has(
    setupAction,
    new RegExp(`toolchain:\\s*"?${rustChannel.replace(/\./g, "\\.")}"?`),
    `CI dtolnay toolchain input must match the rust-toolchain.toml pin (${rustChannel})`,
  );
}
has(
  ".github/workflows/_tier0.yml",
  /just ci tier0-\$\{\{\s*matrix\.lane\s*\}\}/,
  "Tier 0 must call the parameterized CI delegate",
);
has(
  ".github/workflows/_tier1.yml",
  /just ci tier1-/,
  "Tier 1 must call the parameterized CI delegate",
);
has(
  ".github/workflows/_tier1.yml",
  /DATABASE_URL:\s*postgres:\/\/itotori:itotori@127\.0\.0\.1:5432\/itotori/,
  "Tier 1 db job must wire DATABASE_URL to the Postgres service",
);

// THE RENDERER CONTRACT of the Tier-1 browser lane. Its DS visual baselines are
// pixel-exact and only reproduce under the flake.lock-pinned Chromium AND font
// set. That gate previously existed but was unreachable: CI provisioned
// Playwright's own Chromium, so the pixel assertions green-skipped on every PR
// for the whole life of the lane while stale baselines sat red on `main`. These
// four assertions are what stop it silently rotting back — CI must ENTER the
// pinned shell, the shell must pin BOTH halves, and the recipe must FAIL rather
// than skip when either half is missing.
has(
  ".github/workflows/_tier1.yml",
  /nix develop \.#browser --command bash -c/,
  "Tier 1 browser job must run the lane inside the pinned nix renderer dev shell",
);
has(
  "flake.nix",
  /pkgs\.just/,
  "the browser dev shell must provide the flake.lock-pinned just derivation",
);
has(
  ".github/workflows/_tier1.yml",
  /case "\$just_bin" in \/nix\/store\/\*/,
  "the browser job must refuse a just executable outside the Nix store",
);
has(
  "flake.nix",
  /browser = pkgs\.mkShell/,
  "flake.nix must expose the minimal .#browser dev shell the Tier 1 browser job enters",
);
has(
  "flake.nix",
  /FONTCONFIG_FILE = browserFontsConf;/,
  "the renderer contract must pin fonts, not only the browser binary",
);
// makeFontsConf emits a /nix/store path that still <include>s the host's
// /etc/fonts/conf.d and lists /usr/share/fonts, so it LOOKS pinned while
// inheriting the host's rendering rules and font universe. That is how 32 of 35
// stories differed on CI with every path under /nix/store.
hasNot(
  "flake.nix",
  /makeFontsConf/,
  "the fonts pin must be hermetic; makeFontsConf re-admits /etc/fonts/conf.d and /usr/share/fonts",
);
has(
  "packages/itotori-ds/scripts/visual-regression.mjs",
  /--disable-lcd-text/,
  "the visual oracle must pin its rasterization path, not inherit it from the machine",
);
has(
  "scripts/developer-command.mjs",
  /node scripts\/ci\/assert-renderer-contract\.mjs/,
  "the browser CI selector must assert the renderer contract before it runs the suite",
);
has(
  "scripts/ci/assert-renderer-contract.mjs",
  /process\.exit\(1\)/,
  "an unmet renderer contract must FAIL, never green-skip the pixel assertions",
);

const commandSurface = read("scripts/developer-command.mjs");
for (const [command, message] of [
  ["pnpm exec vp check", "check all must run Vite+ checks"],
  ["node scripts/verify-toolchain-policy.mjs", "check all must run the toolchain verifier"],
  ["cargo fmt --check", "check all must run cargo fmt"],
  ["cargo check --workspace", "check all must run cargo check"],
  [
    "cargo clippy --workspace --all-targets --all-features -- -D warnings",
    "check all must run strict clippy",
  ],
  ["cargo deny check", "check all must run cargo deny"],
  [
    "node scripts/update-node-version.mjs",
    "dev upgrade must run the canonical toolchain upgrade sequence",
  ],
]) {
  if (!commandSurface.includes(command)) failures.push(`developer command surface: ${message}`);
}

has("pnpm-lock.yaml", /lockfileVersion:/, "pnpm lockfile must be committed");
has("Cargo.lock", /\[\[package\]\]/, "Cargo lockfile must be committed");

if (failures.length > 0) {
  console.error("toolchain policy verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("toolchain policy verified");
