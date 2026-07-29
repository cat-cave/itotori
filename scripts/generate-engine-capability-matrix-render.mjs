const STATUS_GLYPH = {
  supported: "yes",
  partial: "partial",
  unsupported: "no",
  not_applicable: "n/a",
  unknown: "?",
};

export function renderKnownLimitations(matrix) {
  const lines = ["## Known limitations", ""];
  for (const limitation of matrix.knownLimitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderMatrixMarkdown(matrix) {
  const lines = [];
  lines.push("# Engine capability matrix (generated)");
  lines.push("");
  lines.push(`> ${matrix.doNotEdit}`);
  lines.push("");
  lines.push(`- Schema: \`${matrix.schemaVersion}\``);
  lines.push(`- Generator: \`${matrix.generatedBy}\``);
  lines.push(`- Capability levels: ${matrix.capabilityLevels.join(", ")}`);
  lines.push(`- Input categories covered: ${matrix.inputCategoriesCovered.join(", ")}`);
  lines.push(`- Input kinds covered: ${(matrix.inputKindsCovered ?? []).join(", ")}`);
  lines.push("");
  lines.push("## Capability rows");
  lines.push("");
  const header = ["Row", "Engine family", "Posture", ...matrix.capabilityLevels];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of matrix.rows) {
    const cells = matrix.capabilityLevels.map((level) => STATUS_GLYPH[row.levels[level].status]);
    lines.push(
      `| ${row.rowId} | ${row.engineFamily} | ${row.evidencePosture} | ${cells.join(" | ")} |`,
    );
  }
  lines.push("");
  lines.push("## Posture legend");
  lines.push("");
  lines.push(
    "- `positive_adapter`: a real adapter that extracts and/or patches, evidenced by an adapter-registry / claimed-support tuple.",
  );
  lines.push(
    "- `readiness_only`: detector/profile/readiness/validation evidence; identification and (sometimes) inventory only — no extract/patch adapter is claimed.",
  );
  lines.push("");
  lines.push("## Inputs");
  lines.push("");
  for (const input of matrix.inputs) {
    lines.push(`- \`${input.sourceId}\` (${input.category}/${input.kind}) — ${input.path}`);
  }
  lines.push("");
  lines.push("## Exclusions");
  lines.push("");
  for (const exclusion of matrix.exclusions) {
    lines.push(`- \`${exclusion.engineFamily}\`: ${exclusion.reason}`);
  }
  lines.push("");
  lines.push(renderKnownLimitations(matrix));
  return `${lines.join("\n").trimEnd()}\n`;
}
