import { isRecord, justfilePath, viteConfigPath } from "./spec-dag-shared.mjs";
import { readFileSync } from "node:fs";

export function validateAlphaCommandReferences(nodes) {
  const errors = [];
  const justRecipes = loadJustRecipeNames();
  const vpTasks = loadVpTaskNames();

  for (const node of nodes) {
    if (node.target !== "alpha") {
      continue;
    }
    const verification = Array.isArray(node.verification) ? node.verification : [];
    for (const [index, entry] of verification.entries()) {
      if (!isRecord(entry) || entry.type !== "command" || typeof entry.value !== "string") {
        continue;
      }
      const command = entry.value;
      if (isRetiredLegacyCommand(command)) {
        continue;
      }
      for (const recipe of referencedJustRecipes(command)) {
        if (!justRecipes.has(recipe)) {
          errors.push(
            `${node.id} verification[${index}] references missing just recipe ${recipe}: ${command}`,
          );
        }
      }
      for (const task of referencedVpTasks(command)) {
        if (!vpTasks.has(task)) {
          errors.push(
            `${node.id} verification[${index}] references missing vp task ${task}: ${command}`,
          );
        }
      }
      if (
        commandIncludesFlag(command, "--include-ignored") &&
        !isExplicitIgnoredCargoTest(command)
      ) {
        errors.push(
          `${node.id} verification[${index}] include-ignored command must name an exact cargo integration test target and test filter: ${command}`,
        );
      }
      if (
        ["P0", "P1"].includes(node.priority) &&
        isPnpmItotoriAppPackageTestWithPassthrough(command)
      ) {
        errors.push(
          `${node.id} verification[${index}] must use "pnpm --filter @itotori/app exec vitest run" instead of package "test --" passthrough: ${command}`,
        );
      }
      for (const path of rootRelativeItotoriAppTestPaths(command)) {
        errors.push(
          `${node.id} verification[${index}] @itotori/app test path must be package-relative, not root-relative ${path}: ${command}`,
        );
      }
    }
  }

  return errors;
}

export function isRetiredLegacyCommand(command) {
  return (
    /\bjust\s+localize-project(?:-test)?\b/u.test(command) ||
    /\bitotori:agentic-loop-smoke\b/u.test(command)
  );
}

export function loadJustRecipeNames() {
  let text;
  try {
    text = readFileSync(justfilePath, "utf8");
  } catch {
    return new Set();
  }

  const recipes = new Set();
  for (const match of text.matchAll(/^([A-Za-z0-9_-]+)(?:\s+[^:\n]+)?\s*:/gmu)) {
    recipes.add(match[1]);
  }
  return recipes;
}

export function loadVpTaskNames() {
  let text;
  try {
    text = readFileSync(viteConfigPath, "utf8");
  } catch {
    return new Set();
  }

  const tasksBlock = extractObjectBlock(text, "tasks");
  if (tasksBlock === undefined) {
    return new Set();
  }

  const tasks = new Set();
  for (const match of tasksBlock.matchAll(
    /(?:^|[\s,])(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*\{/gmu,
  )) {
    tasks.add(match[1] ?? match[2] ?? match[3]);
  }
  return tasks;
}

export function extractObjectBlock(text, propertyName) {
  const propertyPattern = new RegExp(String.raw`\b${propertyName}\s*:\s*\{`, "u");
  const match = propertyPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const start = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start + 1, index);
      }
    }
  }
  return undefined;
}

export function referencedJustRecipes(command) {
  const recipes = [];
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    let index = skipEnvAssignments(tokens, 0);
    if (tokens[index] === "direnv" && tokens[index + 1] === "exec") {
      index += 3;
      index = skipEnvAssignments(tokens, index);
    }
    if (tokens[index] === "just" && typeof tokens[index + 1] === "string") {
      recipes.push(tokens[index + 1]);
    }
  }
  return recipes;
}

export function referencedVpTasks(command) {
  const tasks = [];
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    let index = skipEnvAssignments(tokens, 0);
    if (tokens[index] === "pnpm" && tokens[index + 1] === "exec" && tokens[index + 2] === "vp") {
      index += 3;
    } else if (tokens[index] === "vp") {
      index += 1;
    } else {
      continue;
    }
    if (tokens[index] !== "run") {
      continue;
    }
    index += 1;
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
    if (typeof tokens[index] === "string") {
      tasks.push(tokens[index]);
    }
  }
  return tasks;
}

export function isExplicitIgnoredCargoTest(command) {
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    let index = skipEnvAssignments(tokens, 0);
    if (tokens[index] === "direnv" && tokens[index + 1] === "exec") {
      index += 3;
      index = skipEnvAssignments(tokens, index);
    }
    const cargoIndex = tokens.indexOf("cargo", index);
    if (cargoIndex === -1 || tokens[cargoIndex + 1] !== "test") {
      continue;
    }
    const separatorIndex = tokens.indexOf("--", cargoIndex + 2);
    if (separatorIndex === -1 || !tokens.slice(separatorIndex + 1).includes("--include-ignored")) {
      continue;
    }
    const testTargetIndex = tokens.indexOf("--test", cargoIndex + 2);
    if (testTargetIndex === -1 || testTargetIndex > separatorIndex - 2) {
      return false;
    }
    const testTarget = tokens[testTargetIndex + 1];
    const testFilter = tokens[testTargetIndex + 2];
    return isRustIdentifier(testTarget) && isRustTestFilter(testFilter);
  }
  return false;
}

export function isPnpmItotoriAppPackageTestWithPassthrough(command) {
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    const index = skipEnvAssignments(tokens, 0);
    if (isPnpmItotoriAppTestCommand(tokens, index) && tokens.includes("--")) {
      return true;
    }
  }
  return false;
}

export function rootRelativeItotoriAppTestPaths(command) {
  const paths = [];
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    const index = skipEnvAssignments(tokens, 0);
    const pathStart = itotoriAppTestPathStart(tokens, index);
    if (pathStart === undefined) {
      continue;
    }
    for (const token of tokens.slice(pathStart)) {
      if (token.startsWith("apps/itotori/test/")) {
        paths.push(token);
      }
    }
  }
  return paths;
}

export function itotoriAppTestPathStart(tokens, index) {
  if (isPnpmItotoriAppTestCommand(tokens, index)) {
    const passthroughIndex = tokens.indexOf("--", index);
    return passthroughIndex === -1 ? undefined : passthroughIndex + 1;
  }
  const execVitestRun = pnpmItotoriAppExecVitestRunAt(tokens, index);
  return execVitestRun?.nextIndex;
}

export function isPnpmItotoriAppTestCommand(tokens, start) {
  if (tokens[start] !== "pnpm") {
    return false;
  }

  const filter = itotoriAppFilterAt(tokens, start + 1);
  return filter !== undefined && tokens[filter.nextIndex] === "test";
}

export function pnpmItotoriAppExecVitestRunAt(tokens, start) {
  if (tokens[start] !== "pnpm") {
    return undefined;
  }

  const filter = itotoriAppFilterAt(tokens, start + 1);
  if (filter === undefined) {
    return undefined;
  }

  const index = filter.nextIndex;
  if (tokens[index] === "exec" && tokens[index + 1] === "vitest" && tokens[index + 2] === "run") {
    return { nextIndex: index + 3 };
  }
  return undefined;
}

export function itotoriAppFilterAt(tokens, index) {
  if (tokens[index] === "--filter" && isItotoriAppFilterValue(tokens[index + 1])) {
    return { nextIndex: index + 2 };
  }
  if (tokens[index] === "-F" && isItotoriAppFilterValue(tokens[index + 1])) {
    return { nextIndex: index + 2 };
  }
  const filterValue = tokens[index]?.match(/^--filter=(.+)$/u)?.[1];
  if (filterValue !== undefined && isItotoriAppFilterValue(filterValue)) {
    return { nextIndex: index + 1 };
  }
  const shortFilterValue = tokens[index]?.match(/^-F(.+)$/u)?.[1];
  if (shortFilterValue !== undefined && isItotoriAppFilterValue(shortFilterValue)) {
    return { nextIndex: index + 1 };
  }
  return undefined;
}

export function isItotoriAppFilterValue(value) {
  return value === "@itotori/app" || value === "itotori";
}

export function commandIncludesFlag(command, flag) {
  return shellWords(command).includes(flag);
}

export function commandSegments(command) {
  return command
    .split(/\s+(?:&&|\|\||;)\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function shellWords(value) {
  return [...value.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

export function skipEnvAssignments(tokens, start) {
  let index = start;
  while (/^[A-Z_][A-Z0-9_]*=/u.test(tokens[index] ?? "")) {
    index += 1;
  }
  return index;
}

export function isRustIdentifier(value) {
  return typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value);
}

export function isRustTestFilter(value) {
  return typeof value === "string" && /^[a-z_][a-z0-9_:]*$/u.test(value);
}
