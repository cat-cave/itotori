import {
  assetLocalizationDecisionAssetKindValues,
  assetLocalizationDecisionPolicyValues,
  type AssetDecisionRecord,
  type AssetLocalizationDecisionAssetKind,
  type AssetLocalizationDecisionAssetRef,
  type AssetLocalizationDecisionPolicy,
} from "@itotori/db";

const fixtureDecidedAt = new Date("2026-06-24T00:00:00Z");
const fixtureCreatedAt = new Date("2026-06-24T00:00:00Z");

export function assetDecisionFixtureRef(
  ref = "asset.json#fixture",
): AssetLocalizationDecisionAssetRef {
  return { kind: "bridgeAssetRef", ref };
}

export type AssetDecisionFixtureOverrides = Partial<Omit<AssetDecisionRecord, "assetRef">> & {
  assetRef?: AssetLocalizationDecisionAssetRef;
};

function baseFixture(
  policy: AssetLocalizationDecisionPolicy,
  assetKind: AssetLocalizationDecisionAssetKind,
  overrides: AssetDecisionFixtureOverrides = {},
): AssetDecisionRecord {
  return {
    decisionId: `asset-decision-fixture-${policy}`,
    projectId: "project-asset-fixture",
    localeBranchId: "locale-asset-fixture",
    assetRef: overrides.assetRef ?? assetDecisionFixtureRef(),
    assetKind,
    decisionPolicy: policy,
    decisionRationale: "fixture rationale",
    decidedByUserId: "user-fixture",
    decidedAt: fixtureDecidedAt,
    supersededAt: null,
    supersededByDecisionId: null,
    createdAt: fixtureCreatedAt,
    ...overrides,
  };
}

export function keepOriginalFixture(
  overrides: AssetDecisionFixtureOverrides = {},
): AssetDecisionRecord {
  return baseFixture(
    assetLocalizationDecisionPolicyValues.keepOriginal,
    assetLocalizationDecisionAssetKindValues.doNotTranslate,
    overrides,
  );
}

export function translateTextFixture(
  overrides: AssetDecisionFixtureOverrides = {},
): AssetDecisionRecord {
  return baseFixture(
    assetLocalizationDecisionPolicyValues.translateText,
    assetLocalizationDecisionAssetKindValues.imageWithText,
    overrides,
  );
}

export function swapWithReplacementFixture(
  overrides: AssetDecisionFixtureOverrides = {},
): AssetDecisionRecord {
  return baseFixture(
    assetLocalizationDecisionPolicyValues.swapWithReplacement,
    assetLocalizationDecisionAssetKindValues.font,
    overrides,
  );
}

export function romanizeFixture(
  overrides: AssetDecisionFixtureOverrides = {},
): AssetDecisionRecord {
  return baseFixture(
    assetLocalizationDecisionPolicyValues.romanize,
    assetLocalizationDecisionAssetKindValues.romanization,
    overrides,
  );
}

export function fullLocalizeFixture(
  overrides: AssetDecisionFixtureOverrides = {},
): AssetDecisionRecord {
  return baseFixture(
    assetLocalizationDecisionPolicyValues.fullLocalize,
    assetLocalizationDecisionAssetKindValues.fullLocalization,
    overrides,
  );
}

export function skipFixture(overrides: AssetDecisionFixtureOverrides = {}): AssetDecisionRecord {
  return baseFixture(
    assetLocalizationDecisionPolicyValues.skip,
    assetLocalizationDecisionAssetKindValues.video,
    overrides,
  );
}

export const assetDecisionPolicyFixtures = {
  keepOriginal: keepOriginalFixture,
  translateText: translateTextFixture,
  swapWithReplacement: swapWithReplacementFixture,
  romanize: romanizeFixture,
  fullLocalize: fullLocalizeFixture,
  skip: skipFixture,
} as const;
