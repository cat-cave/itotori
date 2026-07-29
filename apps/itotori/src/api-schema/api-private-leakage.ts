export const benchmarkSeedPrivateLeakagePatterns = [
  /(?:^|[ "'=])file:/iu,
  /(?:^|[ "'=])\/(?:home|tmp|var|scratch|private)(?:\/|$)/iu,
  /[A-Z]:\\/u,
  /\.(?:zip|7z|rar|tar|gz|ks)(?:$|[\\/!?#:])/iu,
  /private[-_ ](?:title|path|corpus)/iu,
  /(?:rawPayloadSecret|local-scan-entry-secret|private-story-title|private_path_hash|path_hash)/iu,
] as const;
