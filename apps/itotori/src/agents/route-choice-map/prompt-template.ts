import { createHash } from "node:crypto";
import { ROUTE_CHOICE_KINDS, type RouteChoiceMapInput } from "./shapes.js";

export const PROMPT_TEMPLATE_VERSION_V1 = "itotori-route-choice-map-v1";

export type RenderedPrompt = {
  systemText: string;
  userText: string;
};

const SYSTEM_INSTRUCTIONS = [
  "You are a localization context assistant.",
  "Read the supplied units and return a JSON object naming the routes (story branches)",
  "and choices (player-facing decisions) that the source code exposes.",
  "Use the SAME LANGUAGE as the source units for route titles, summaries, choice prompts, and option labels.",
  "Every route MUST cite the unit ids that establish its boundary in citedUnitIds.",
  "Every choice MUST cite the unit ids that surface the prompt in citedUnitIds.",
  "Every RouteBranch / SceneSelector option MUST cite the target unit ids in targetUnitIds.",
  "Do not invent routeKeys or choiceKeys not justified by the supplied units.",
  `Choice.kind MUST be one of the closed values: ${ROUTE_CHOICE_KINDS.join(", ")}.`,
  "Output JSON only, conforming to the schema at the bottom of the user message.",
].join("\n");

export function buildPrompt(input: RouteChoiceMapInput): RenderedPrompt {
  const lines: string[] = [];
  lines.push(`Project source locale: ${input.sourceLocale}`);

  const curated = [...input.curatedRoutes].sort((a, b) => a.routeKey.localeCompare(b.routeKey));
  lines.push("");
  if (curated.length > 0) {
    lines.push("Curator-declared routes (preserve these keys; do not invent aliases):");
    for (const ref of curated) {
      const display = ref.routeTitle ? ` (${ref.routeTitle})` : "";
      lines.push(`- ${ref.routeKey}${display}`);
    }
  } else {
    lines.push("Curator-declared routes: (none)");
  }

  if (input.priorMap) {
    lines.push("");
    lines.push("Prior map (extend, do not contradict):");
    lines.push(
      JSON.stringify({
        routes: [...input.priorMap.routes].sort((a, b) => a.routeKey.localeCompare(b.routeKey)),
        choices: [...input.priorMap.choices].sort((a, b) => a.choiceKey.localeCompare(b.choiceKey)),
        promptTemplateVersion: input.priorMap.promptTemplateVersion,
      }),
    );
  }

  lines.push("");
  lines.push("Units (canonical order):");
  const units = canonicalizeUnits(input);
  let index = 1;
  for (const unit of units) {
    const speaker = unit.speaker && unit.speaker.trim().length > 0 ? unit.speaker : "narration";
    const routeKey = unit.routeKey ?? "-";
    const sceneKey = unit.sceneKey ?? "-";
    const choiceKey = unit.choiceContext?.choiceKey ?? "-";
    const optionIndex =
      unit.choiceContext?.optionIndex !== undefined ? String(unit.choiceContext.optionIndex) : "-";
    lines.push(
      `[#${index}] (unitId=${unit.bridgeUnitId}, speaker=${speaker}, routeKey=${routeKey}, sceneKey=${sceneKey}, choiceKey=${choiceKey}, optionIndex=${optionIndex}) ${unit.sourceText}`,
    );
    index += 1;
  }

  lines.push("");
  lines.push("Schema (JSON):");
  lines.push(
    JSON.stringify({
      routes: [
        {
          routeKey: "string",
          routeTitle: "string (in source locale)",
          routeSummary: "string (in source locale)",
          citedUnitIds: ["bridgeUnitId"],
        },
      ],
      choices: [
        {
          choiceKey: "string",
          kind: ROUTE_CHOICE_KINDS.join("|"),
          fromRouteKey: "string?",
          promptSummary: "string (in source locale)",
          citedUnitIds: ["bridgeUnitId"],
          options: [
            {
              optionIndex: 0,
              optionLabel: "string (in source locale)",
              targetRouteKey: "string?",
              targetUnitIds: ["bridgeUnitId"],
            },
          ],
        },
      ],
    }),
  );

  return { systemText: SYSTEM_INSTRUCTIONS, userText: lines.join("\n") };
}

export function promptHash(prompt: RenderedPrompt): string {
  const canonical = `${prompt.systemText}\n␞\n${prompt.userText}`;
  return createHash("sha256").update(canonical).digest("hex");
}

export function canonicalizeUnits(
  input: RouteChoiceMapInput,
): ReadonlyArray<RouteChoiceMapInput["units"][number]> {
  return [...input.units].sort((a, b) => {
    const keyDelta = a.sourceUnitKey.localeCompare(b.sourceUnitKey);
    if (keyDelta !== 0) {
      return keyDelta;
    }
    return a.bridgeUnitId.localeCompare(b.bridgeUnitId);
  });
}
