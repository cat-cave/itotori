import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

interface FailureExpectation {
  readonly probe: string;
  readonly failureClass: string;
  readonly nextAction: string;
}

interface ProofRecorder {
  expect(condition: boolean, code: string): void;
}

const EXPECTED_ARTIFACT: Readonly<Record<string, string>> = {
  "missing-input": "missing-input-output.json",
  "provider-unavailable": "provider-localization.json",
  "unsupported-profile": "profile-patch.html",
  "malformed-input": "malformed-extraction.json",
  "unsupported-operation": "playback-receipt.json",
  "stale-source": "patched-source.bin",
  "privacy-denial": "published-evidence.json",
  "permission-denial": "admin-action.json",
  deadline: "deadline-response.bin",
  cancelled: "cancellation-result.json",
  "budget-refusal": "budgeted-localization.json",
  "internal-failure": "persisted-operation.json",
  "missing-asset": "restored-runtime-asset.bin",
  "decryption-failure": "decrypted-runtime-asset.bin",
  "preparation-failure": "prepared-source.bin",
  "misleading-message": "localized-output.json",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function expectedScratch(selected: FailureExpectation): readonly (readonly [string, string])[] {
  switch (selected.probe) {
    case "provider-unavailable":
      return [
        [
          "provider-state.json",
          JSON.stringify({ state: "paused", nextAction: selected.nextAction }),
        ],
      ];
    case "unsupported-profile":
      return [
        [
          "profile-refusal.html",
          [
            '<main class="itotori-shell" data-state="asset-decisions-error"',
            ' data-failure-code="unsupported_source_profile">',
            "<h1>Asset decisions unavailable</h1>",
            "<p>Could not load asset decisions for patch-production.</p>",
            `<p role="alert">${selected.failureClass}: exact declared limitation; next action ${selected.nextAction}</p>`,
            `<p data-next-action="${selected.nextAction}">Next action: ${selected.nextAction}</p>`,
            "</main>",
          ].join(""),
        ],
      ];
    case "malformed-input":
      return [["owned-input.json", '{"units":[']];
    case "stale-source":
      return [["current-source.bin", "source revision two"]];
    case "cancelled":
      return [["cancelled-state.json", JSON.stringify({ state: "cancelled", transition: 1 })]];
    default:
      return [];
  }
}

function validateOperationEffects(
  selected: FailureExpectation,
  facts: Record<string, unknown>,
  proof: ProofRecorder,
): void {
  const observation = facts.operationEffects;
  proof.expect(isRecord(observation), "operation-effects-missing");
  if (!isRecord(observation)) throw new Error("operation-effects-missing");
  proof.expect(
    Object.keys(observation).toSorted().join("\0") ===
      ["artifactBytes", "artifactName", "artifactNodeKind", "artifactPresent", "successCalls"].join(
        "\0",
      ),
    "operation-effects-shape",
  );
  proof.expect(
    observation.artifactName === EXPECTED_ARTIFACT[selected.probe],
    "operation-effect-artifact",
  );
  proof.expect(observation.artifactPresent === false, "operation-effect-present");
  proof.expect(observation.artifactBytes === 0, "operation-effect-bytes");
  proof.expect(observation.artifactNodeKind === "absent", "operation-effect-node-kind");
  proof.expect(observation.successCalls === 0, "operation-success-call");
}

function validateScratch(
  selected: FailureExpectation,
  scratchRoot: string,
  proof: ProofRecorder,
): void {
  const rootStat = lstatSync(scratchRoot);
  proof.expect(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    "failure-scratch-root-invalid",
  );
  const expected = expectedScratch(selected);
  const names = readdirSync(scratchRoot).toSorted();
  proof.expect(
    names.join("\0") ===
      expected
        .map(([name]) => name)
        .toSorted()
        .join("\0"),
    "failure-scratch-inventory",
  );
  for (const [name, content] of expected) {
    const path = resolve(scratchRoot, name);
    const stat = lstatSync(path);
    proof.expect(stat.isFile() && !stat.isSymbolicLink(), `failure-scratch-node:${name}`);
    proof.expect(readFileSync(path).equals(Buffer.from(content)), `failure-scratch-bytes:${name}`);
  }
}

export function validateFailureState(
  selected: FailureExpectation,
  facts: Record<string, unknown>,
  scratchRoot: string,
  proof: ProofRecorder,
): void {
  validateOperationEffects(selected, facts, proof);
  validateScratch(selected, scratchRoot, proof);
}
