const SCHEMA = "itotori.restricted-evidence-public-projection.v1";
const CONCLUSION = "local-candidate-contract-executed";
const REASON = "protected-attestation-absent";
const ENTRY_KEYS = [
  "caseId",
  "privacyClass",
  "conclusion",
  "reason",
  "trustRole",
  "protectedAttestationPresent",
  "verifierRandomizedCommitment",
];
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).toSorted(lexical);
  const sorted = [...expected].toSorted(lexical);
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label}-keys-mismatch`);
  }
}

export function restrictedProjectionEntry(selected, receipt) {
  if (
    selected.values.privacy_class !== "restricted" ||
    receipt.privacyClass !== "restricted" ||
    receipt.trustRole !== "local-candidate-contract" ||
    receipt.protectedAttestationPresent !== false ||
    !/^[a-f0-9]{64}$/u.test(receipt.verifierRandomizedCommitment)
  ) {
    throw new Error(`restricted-projection-source-invalid:${selected.id}`);
  }
  return {
    caseId: selected.id,
    privacyClass: "restricted",
    conclusion: CONCLUSION,
    reason: REASON,
    trustRole: "local-candidate-contract",
    protectedAttestationPresent: false,
    verifierRandomizedCommitment: receipt.verifierRandomizedCommitment,
  };
}

export function projectionDocument(entries) {
  return {
    schema: SCHEMA,
    cases: entries.toSorted((left, right) => lexical(left.caseId, right.caseId)),
  };
}

export function validateProjection(document, selectedCases, caseResults) {
  const parsed = record(document, "restricted-projection");
  exactKeys(parsed, ["schema", "cases"], "restricted-projection");
  if (parsed.schema !== SCHEMA || !Array.isArray(parsed.cases)) {
    throw new Error("restricted-projection-invalid");
  }
  const expected = selectedCases
    .filter(({ values }) => values.privacy_class === "restricted")
    .toSorted((left, right) => lexical(left.id, right.id));
  if (parsed.cases.length !== expected.length) {
    throw new Error("restricted-projection-case-count-mismatch");
  }
  const results = new Map(caseResults.map((result) => [result.caseId, result]));
  const commitments = new Set();
  const entries = parsed.cases.map((value, index) => {
    const entry = record(value, `restricted-projection-${index}`);
    exactKeys(entry, ENTRY_KEYS, `restricted-projection-${index}`);
    const selected = expected[index];
    const result = results.get(selected.id);
    if (
      entry.caseId !== selected.id ||
      entry.privacyClass !== "restricted" ||
      entry.conclusion !== CONCLUSION ||
      entry.reason !== REASON ||
      entry.trustRole !== "local-candidate-contract" ||
      entry.protectedAttestationPresent !== false ||
      !/^[a-f0-9]{64}$/u.test(entry.verifierRandomizedCommitment) ||
      result?.status !== "pass" ||
      result.observationCount !== 1
    ) {
      throw new Error(`restricted-projection-binding-invalid:${selected.id}`);
    }
    commitments.add(entry.verifierRandomizedCommitment);
    return entry;
  });
  if (commitments.size !== entries.length) {
    throw new Error("restricted-projection-commitment-collision");
  }
  return entries;
}
