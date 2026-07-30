import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROADMAP_FILES = ["classification.jsonl", "spec-bundles.jsonl", "spec-instances.jsonl"];

export function lineCount(contents) {
  const count = contents.split("\n").length;
  return contents.endsWith("\n") ? count - 1 : count;
}

export function listFiles(directory, prefix = "") {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? join(prefix, entry.name) : entry.name;
    return entry.isDirectory() ? listFiles(join(directory, entry.name), name) : [name];
  });
}

export function computeContractHash(root, errors = []) {
  const roadmapDir = join(root, "docs", "roadmap");
  const files = [
    ...ROADMAP_FILES,
    ...listFiles(roadmapDir).filter((file) => file.endsWith(".md")),
  ].toSorted();
  const entries = [];
  for (const file of files) {
    const path = join(roadmapDir, file);
    if (!existsSync(path)) {
      errors.push(`docs/roadmap/${file}: missing contract input`);
      continue;
    }
    entries.push([file, readFileSync(path, "utf8")]);
  }
  if (entries.length !== files.length) return null;
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function validateEvidenceRegister(root, cells, engines, errors) {
  const relativePath = join("docs", "roadmap", "unverified.md");
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    errors.push(`${relativePath}: missing acceptance register`);
    return { entries: 0 };
  }
  const contents = readFileSync(path, "utf8");
  const starts = [...contents.matchAll(/^- \*\*/gmu)].map(({ index }) => index);
  const blocks = starts.map((start, index) =>
    contents.slice(start, starts[index + 1] ?? contents.length),
  );
  if (blocks.length !== 32) {
    errors.push(`${relativePath}: acceptance register has ${blocks.length}/32 entries`);
  }

  const validCells = new Set(cells);
  const productionSubjects = new Set(
    engines
      .filter(({ supportRole }) => supportRole === "production-target")
      .map(({ sourceCapability }) => sourceCapability),
  );
  for (const [index, block] of blocks.entries()) {
    const location = `${relativePath} entry ${index + 1}`;
    if (!/— owners?\s/u.test(block)) errors.push(`${location}: missing explicit owner`);
    const literalOwners = [...block.matchAll(/`(cell::[a-z0-9.-]+::[a-z0-9.-]+)`/gu)].map(
      (match) => match[1],
    );
    const expandedOwners = [
      ...block.matchAll(/`cells\(([a-z0-9.-]+), (canonical-engines|production-targets)\)`/gu),
    ];
    if (literalOwners.length === 0 && expandedOwners.length === 0) {
      errors.push(`${location}: owner does not name a cell or finite cell set`);
    }
    for (const cell of literalOwners) {
      if (!validCells.has(cell)) errors.push(`${location}: unknown owning cell ${cell}`);
    }
    for (const [, behavior, applicability] of expandedOwners) {
      const prefix = `cell::${behavior}::`;
      const selected = cells.filter((cell) => {
        if (!cell.startsWith(prefix)) return false;
        if (applicability === "canonical-engines") return true;
        return productionSubjects.has(cell.slice(prefix.length));
      });
      const expected = applicability === "canonical-engines" ? 47 : 39;
      if (selected.length !== expected) {
        errors.push(
          `${location}: ${applicability} owner expands to ${selected.length}/${expected} cells`,
        );
      }
    }
  }
  return { entries: blocks.length };
}
