// artifacts(): the typed module a deployment passes as `ConnectaConfig.artifacts`.

import { resolveBranding, type ResolvedTheme } from "../branding.js";
import { assertKnownOptions, keys, optionsOf } from "../config-schema.js";
import type { ArtifactsModule } from "../module-contracts.js";
import { artifactsConnector, type ArtifactRenderCheck } from "./connector.js";
import { ArtifactOperations } from "./operations.js";
import { artifactRoutes } from "./routes.js";
import { ArtifactRefreshService, type ArtifactRefreshRuntime, type RefreshOutcome } from "./refresh.js";
import type { ArtifactAllowlist, ArtifactLimits, ArtifactStore } from "./types.js";
import { resolveAllowlist, resolveLimits } from "./validate.js";

export interface ArtifactsOptions {
  /**
   * Where artifacts live: `kvArtifactStore(storage)` over the deployment's
   * storage — `d1Storage` on Workers (optionally with R2 for bodies),
   * `sqliteStorage` on Node, `memoryStorage` in tests.
   */
  store: ArtifactStore;
  /**
   * Origins pages may load scripts, stylesheets, and fonts from, each an exact
   * `https:` origin. Every list defaults to empty; a deployment must opt in
   * to each origin it trusts with page data. The viewer's CSP names only these.
   */
  allowlist?: Partial<ArtifactAllowlist>;
  /** Tighten any limit below its default; none can be raised. */
  limits?: Partial<ArtifactLimits>;
  /**
   * A real render check, such as a headless browser, run on
   * `validate_artifact` and every write that changes what a page renders.
   * Without one, static validation is the floor.
   */
  renderCheck?: ArtifactRenderCheck;
}

const STORE_METHODS = [
  "head",
  "swapHead",
  "heads",
  "putBody",
  "body",
  "putVersion",
  "versions",
  "putRun",
  "runs",
  "refreshScanCursor",
  "setRefreshScanCursor",
] as const;

/** The closed options artifacts() accepts; see `assertKnownOptions`. */
const ARTIFACTS_OPTIONS = optionsOf<ArtifactsOptions>()({
  ...keys("store", "renderCheck"),
  allowlist: optionsOf<ArtifactAllowlist>()(keys("scripts", "styles", "fonts")),
  limits: optionsOf<ArtifactLimits>()(
    keys(
      "sourceBytes", "documentBytes", "documents", "totalDocumentBytes", "renderedBytes", "titleChars",
      "patchEdits", "findBytes", "programBytes", "runLogBytes", "jsonDepth",
    ),
  ),
});

/**
 * Team pages over stored data, reached by agents through the built-in
 * `artifacts` connector. Pass the result as `createConnecta({ artifacts })`.
 * Structural mistakes throw here, before a deployment boots.
 */
export interface RefreshableArtifacts extends ArtifactsModule {
  bindRefresh(runtime: ArtifactRefreshRuntime): void;
  refresh(id: string, by: import("./types.js").ArtifactActor): Promise<RefreshOutcome>;
  runDue(): ReturnType<ArtifactRefreshService["runDue"]>;
}

export function artifacts(options: ArtifactsOptions): RefreshableArtifacts {
  if (!options || typeof options !== "object") {
    throw new TypeError("artifacts() needs options with a store");
  }
  options = assertKnownOptions(options, "artifacts()", ARTIFACTS_OPTIONS);
  const store = options.store as Partial<ArtifactStore> | undefined;
  if (
    !store ||
    typeof store !== "object" ||
    STORE_METHODS.some((method) => typeof store[method] !== "function")
  ) {
    throw new TypeError(
      "artifacts(): store must be an ArtifactStore, e.g. kvArtifactStore(storage)",
    );
  }
  if (options.renderCheck !== undefined && typeof options.renderCheck !== "function") {
    throw new TypeError("artifacts(): renderCheck must be a function");
  }
  const allowlist = resolveAllowlist(options.allowlist);
  const limits = resolveLimits(options.limits);
  const operations = new ArtifactOperations({
    store: options.store,
    allowlist,
    limits,
  });
  const refresh = new ArtifactRefreshService(operations);
  let theme: ResolvedTheme | undefined;
  const connector = artifactsConnector({
    operations,
    refresh,
    allowlist,
    limits,
    theme: () => theme,
    ...(options.renderCheck ? { renderCheck: options.renderCheck } : {}),
  });
  const optionSources = Object.freeze(Object.fromEntries([
    ["renderCheck", options.renderCheck === undefined ? "default" : "config"],
    ...Object.keys(allowlist).map(key => [`allowlist.${key}`, options.allowlist?.[key as keyof ArtifactAllowlist] === undefined ? "default" : "config"]),
    ...Object.keys(limits).map(key => [`limits.${key}`, options.limits?.[key as keyof ArtifactLimits] === undefined ? "default" : "config"]),
  ] as Array<[string, "default" | "config"]>));
  return Object.freeze({
    connector,
    handle: artifactRoutes({ operations, allowlist }),
    bindRefresh: (runtime: ArtifactRefreshRuntime) => {
      refresh.bind(runtime);
      theme = resolveBranding(runtime.branding).theme;
    },
    refresh: (id: string, by: import("./types.js").ArtifactActor) => refresh.run(id, { manual: by }),
    runDue: () => refresh.runDue(),
    describe: () => ({
      optionSources,
      allowlist: {
        scripts: [...allowlist.scripts],
        styles: [...allowlist.styles],
        fonts: [...allowlist.fonts],
      },
      limits: Object.fromEntries(
        Object.entries(limits).filter(([, value]) => typeof value === "number"),
      ),
      renderCheck: options.renderCheck !== undefined,
    }),
  });
}
