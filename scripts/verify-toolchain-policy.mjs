import { readFileSync } from "node:fs";

const failures = [];
const missingRecipes = new Set();

const read = (path) => readFileSync(path, "utf8");
const has = (path, pattern, message) => {
  if (!pattern.test(read(path))) {
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

has("rust-toolchain.toml", /channel\s*=\s*"stable"/, "Rust channel must be stable");
has("rust-toolchain.toml", /"rustfmt"/, "rustfmt component must be installed");
has("rust-toolchain.toml", /"clippy"/, "clippy component must be installed");

has(".github/workflows/ci.yml", /node-version-file:\s*\.node-version/, "CI must use .node-version");
has(
  ".github/workflows/ci.yml",
  /pnpm install --frozen-lockfile/,
  "CI must use frozen pnpm installs",
);
has(
  ".github/workflows/ci.yml",
  /dtolnay\/rust-toolchain@stable/,
  "CI must install the Rust stable toolchain",
);
has(".github/workflows/ci.yml", /just ci/, "CI must call the root just ci recipe");

hasRecipeCommand("check", "pnpm exec vp check", "must run Vite+ checks");
hasRecipeCommand(
  "check",
  "node scripts/verify-toolchain-policy.mjs",
  "must run the toolchain verifier",
);
hasRecipeCommand("check", "cargo fmt --check", "must run cargo fmt");
hasRecipeCommand("check", "cargo check --workspace", "must run cargo check");
hasRecipeDependency("ci", "check", "must depend on check");
hasRecipeDependency("ci", "build", "must depend on build");
hasRecipeDependency("ci", "db-migrate", "must depend on db-migrate");
hasRecipeDependency("ci", "test", "must depend on test");
hasRecipeCommand(
  "ci",
  "cargo clippy --workspace --all-targets --all-features -- -D warnings",
  "must run cargo clippy strictly",
);
hasRecipeCommand("ci", "cargo deny check", "must run cargo deny");
hasExactRecipeCommands(
  "upgrade",
  [
    "corepack enable",
    "node scripts/update-node-version.mjs",
    "corepack use pnpm@latest",
    "node scripts/sync-pnpm-engine.mjs",
    "pnpm update --latest --recursive",
    "rustup update stable",
    "cargo update",
    "node scripts/verify-toolchain-policy.mjs",
  ],
  "must run the canonical toolchain upgrade sequence",
);

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
