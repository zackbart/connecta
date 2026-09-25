// @zackbart/connecta/artifacts — the optional artifacts module.
//
// Team pages over stored JSON, reached by agents through a built-in
// connector. Nothing here is reachable from the root entry: a deployment that
// never imports this subpath carries none of it and does none of its work.

export { kvArtifactStore, type KvArtifactStoreOptions } from "./artifacts/kv-store.js";
export {
  validateArtifact,
  type ValidateArtifactInput,
  type ValidateArtifactOptions,
} from "./artifacts/validate.js";
export {
  ARTIFACT_RUNS_RETAINED,
  DEFAULT_ARTIFACT_ALLOWLIST,
  DEFAULT_ARTIFACT_LIMITS,
  type ArtifactActor,
  type ArtifactAllowlist,
  type ArtifactBlobStore,
  type ArtifactHeadRecord,
  type ArtifactIssue,
  type ArtifactKind,
  type ArtifactLimits,
  type ArtifactRunRecord,
  type ArtifactStore,
  type ArtifactStream,
  type ArtifactValidation,
  type ArtifactVersionOp,
  type ArtifactVersionRecord,
} from "./artifacts/types.js";
