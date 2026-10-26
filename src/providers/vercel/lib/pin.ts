// Deployment confinement, separate from Vercel's optional routing default.
import { Effect } from "effect";
import { ConnectorCallError } from "../../../errors.js";
import { Refusal, type HttpFailure } from "../../../http/errors.js";
import { Budget, type CallServices } from "../../../http/services.js";
import type { Connection } from "../../../http/vendor.js";
import type { Operation, OperationIndex } from "../../_shared/rest/operation-index.js";
import type { RestCall } from "../../_shared/rest/tools.js";
import { checked } from "../../_shared/rest/kit.js";
import type { VercelTokenOptions, VercelTeamPin } from "../index.js";
export type { VercelTeamPin } from "../index.js";

export const MAX_PIN_LOOKUPS = 8;
export const PIN_WRITE_STEPS = Object.freeze({
  write: "once",
  lookup1: "once",
  lookup2: "once",
  lookup3: "once",
  lookup4: "once",
  lookup5: "once",
  lookup6: "once",
  lookup7: "once",
  lookup8: "once",
} as const);
const settings = new WeakMap<object, Readonly<VercelTokenOptions>>();
/** Snapshot deployment configuration once; no caller can mutate the guard or its MAC scope. */
export function pinOptions(options: Readonly<VercelTokenOptions>): Readonly<VercelTokenOptions> {
  const saved = settings.get(options);
  if (saved) return saved;
  validatePin(options);
  const snapshot = Object.freeze({
    ...options,
    ...(options.pin ? { pin: Object.freeze({ teamId: options.pin.teamId }) } : {}),
  });
  settings.set(options, snapshot);
  return snapshot;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const fail = (reason: string): never => {
  throw new ConnectorCallError(
    "provider_permission_denied",
    `Vercel team pin: ${reason} Not sent to the requested resource.`,
    { retryable: false },
  );
};

export function validatePin(options: Readonly<VercelTokenOptions>): void {
  if (options.pin === undefined) return;
  const id = options.pin?.teamId;
  if (typeof id !== "string" || !/^team_[A-Za-z0-9_-]+$/.test(id))
    throw new Error("pin.teamId must be a canonical Vercel team id (team_…).");
  if (options.teamId !== undefined && options.teamId.trim() !== id)
    throw new Error("teamId routing default must match pin.teamId when pinned.");
}

/** No unscoped/account read exceptions. Transfers and cross-team grants remain unprovable. */
export function pinRoute(index: OperationIndex, op: Operation): "query-team" | "path-team" | "denied" {
  if (
    op.server ||
    /\/transfer-request(?:\/|$)|\/organizations(?:\/|$)/.test(op.path) ||
    (/\/vcr\/repository\/\{idOrName\}\/permissions(?:\/|$)/.test(op.path) && op.method !== "GET")
  )
    return "denied";
  if (op.path.includes("{teamId}")) return "path-team";
  return index.contract(op).parameters.some((p) => p.in === "query" && p.name === "teamId") ? "query-team" : "denied";
}

const SELECTORS = new Set(["teamid", "slug", "ownerid", "newdefaultteamid"]);
function selectorName(key: string): string {
  let decoded = key;
  try {
    for (let i = 0; i < 3 && decoded.includes("%"); i++) decoded = decodeURIComponent(decoded);
  } catch {
    fail("Malformed selector spelling.");
  }
  return decoded.toLowerCase().replace(/[[\]_.-]/g, "");
}

/** Reviewed Vercel references only; data.projectId is a Photon id, gitSource.projectId a git-provider id. */
const BODY_PROJECTS: Readonly<Record<string, readonly string[]>> = {
  "POST /v1/access-groups/{idOrName}": ["projects[].projectId"],
  "POST /v1/access-groups": ["projects[].projectId"],
  "POST /v1/access-groups/{accessGroupIdOrName}/projects": ["projectId"],
  "PUT /ai-gateway/budgets": ["projectId"],
  "PUT /v1/bulk-redirects": ["projectId"],
  "POST /v1/networking/privatelink/endpoints": ["projectId"],
  "POST /v1/connect/connectors": ["projectId", "triggerDestination.projectId"],
  "PATCH /v1/connect/connectors/{connector}/trigger-destinations": ["destinations[].projectId"],
  "POST /v13/deployments": ["project"],
  "POST /v1/log-drains": ["projectIds[]"],
  "POST /v1/drains": ["projectIds[]"],
  "PATCH /v1/drains/{id}": ["projectIds[]"],
  "POST /v1/env": ["projectId[]"],
  "POST /v1/integrations/installations/{integrationConfigurationId}/resources/{resourceId}/connections": ["projectId"],
  "POST /v2/integrations/log-drains": ["projectIds[]"],
  "POST /v1/kms/issuers": ["policy.projectId"],
  "POST /v1/kms/issuers/{issuerId}/policies": ["projectId"],
  "POST /v1/microfrontends/group": ["defaultApp.projectId", "otherApplications[].projectId"],
  "POST /v1/projects/traces/session": ["projectId"],
  "POST /v1/projects/{idOrName}/domains/{domain}/move": ["projectId"],
  "POST /v2/sandboxes": ["projectId"],
  "POST /v3/sandboxes": ["projectId"],
  "POST /v4/sandboxes": ["projectId"],
  "POST /v2/sandboxes/drives/{name}": ["projectId"],
  "POST /v1/security/attack-mode": ["projectId"],
  "POST /v2/teams/{teamId}/members": ["[].projects[].projectId"],
  "PATCH /v1/teams/{teamId}/members/{uid}": ["projects[].projectId"],
  "POST /v1/vcr/repository": ["projectId"],
  "POST /v1/webhooks": ["projectIds[]"],
};

function at(value: unknown, path: string): unknown[] {
  if (!path) return [value];
  const [head = "", ...tail] = path.split(".");
  const array = head.endsWith("[]"),
    key = array ? head.slice(0, -2) : head;
  const next = key ? object(value)[key] : value;
  if (next === undefined) return [];
  if (array) {
    if (!Array.isArray(next)) fail("A resource reference list is malformed.");
    return (next as unknown[]).flatMap((item) => at(item, tail.join(".")));
  }
  return at(next, tail.join("."));
}

function scalar(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[%/\\?#\s,]/.test(value))
    fail("A resource or team selector is not a canonical scalar.");
  return value as string;
}

/** Synchronous selectors run before any ownership IO and before routing drops teamId:null. */
export function pinQuery(index: OperationIndex, call: RestCall, pin: VercelTeamPin): Readonly<Record<string, unknown>> {
  const route = pinRoute(index, call.op);
  if (route === "denied") fail("This operation has no reviewed team confinement.");
  if (call.path.includes("%")) fail("Encoded path spellings are unavailable on pinned connections.");
  for (const [key, value] of Object.entries(call.query)) {
    if (key.includes("%")) fail("Encoded query parameter names are unavailable on pinned connections.");
    const canonical = selectorName(key);
    if (!SELECTORS.has(canonical)) continue;
    if (!["teamId", "slug", "ownerId", "newDefaultTeamId"].includes(key)) fail("Ambiguous or duplicate team selector.");
    if (value === undefined) continue;
    if (key === "newDefaultTeamId") fail("Secondary-team operations are unavailable.");
    if (key === "slug") scalar(value);
    else if (scalar(value) !== pin.teamId) fail("The selected team is outside the deployment pin.");
  }
  const pathTeam = call.params["teamId"];
  if (pathTeam !== undefined && scalar(pathTeam) !== pin.teamId) fail("The path team is outside the deployment pin.");
  // The two documented body team selectors affect Vercel scope/grants. Ordinary
  // resource .slug and third-party connector metadata are not team selectors.
  const bodySelectors =
    call.op.path === "/v1/bulk-redirects" ? ["teamId"] : call.op.path === "/v1/kms/issuers" ? ["policy.teamId"] : [];
  for (const path of bodySelectors)
    for (const value of at(call.body, path))
      if (scalar(value) !== pin.teamId) fail("A body team selector is outside the deployment pin.");
  for (const key of Object.keys(object(call.body)))
    if (selectorName(key) === "teamid" && key !== "teamId") fail("Ambiguous body team selector.");
  return route === "query-team" ? { ...call.query, teamId: pin.teamId } : call.query;
}

export function pinAdmission(
  connection: Connection,
  index: OperationIndex,
  call: RestCall,
  pin?: VercelTeamPin,
): Effect.Effect<void, HttpFailure, CallServices> {
  if (!pin) return Effect.void;
  return Effect.gen(function* () {
    const refs = yield* checked(() => {
      pinQuery(index, call, pin);
      const projects = new Set<string>(),
        deployments = new Set<string>();
      const add = (set: Set<string>, value: unknown) => {
        set.add(scalar(value));
      };
      const template = call.op.path.split("/");
      template.forEach((part, i) => {
        if (!part.startsWith("{")) return;
        const name = part.slice(1, -1),
          value = call.params[name];
        if (value === undefined) return;
        if (template[i - 1] === "projects" || /^projectId(?:OrName)?$/.test(name)) add(projects, value);
        if (template[i - 1] === "deployments" || name === "deploymentId") add(deployments, value);
      });
      const declared = new Set(
        index
          .contract(call.op)
          .parameters.filter((p) => p.in === "query")
          .map((p) => p.name),
      );
      for (const [key, value] of Object.entries(call.query)) {
        if (!declared.has(key) || value === undefined) continue;
        const target = [
          "projectId",
          "projectIdOrName",
          "projectIds",
          "project",
          "excludeProject",
          "eligibleMembersForProjectId",
        ].includes(key)
          ? projects
          : key === "rollbackDeploymentId"
            ? deployments
            : undefined;
        if (target)
          for (const entry of Array.isArray(value) ? value : [value])
            for (const id of typeof entry === "string" && key === "projectIds" ? entry.split(",") : [entry])
              add(target, id);
      }
      for (const path of BODY_PROJECTS[`${call.method} ${call.op.path}`] ?? [])
        for (const value of at(call.body, path)) add(projects, value);
      const deploymentPath =
        call.op.path === "/v13/deployments"
          ? "deploymentId"
          : /\/rolling-release\/(?:start|approve-stage|complete)$/.test(call.op.path)
            ? "canaryDeploymentId"
            : undefined;
      if (deploymentPath) for (const value of at(call.body, deploymentPath)) add(deployments, value);
      if (projects.size + deployments.size + (call.query["slug"] === undefined ? 0 : 1) > MAX_PIN_LOOKUPS)
        fail(`At most ${MAX_PIN_LOOKUPS} ownership reads are allowed per call.`);
      return { projects, deployments };
    });
    let lookups = 0;
    const lookup = (path: string, template: string) =>
      Effect.gen(function* () {
        const step = `lookup${++lookups}`;
        yield* (yield* Budget).charge.pipe(
          Effect.catch((error) =>
            error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
          ),
        );
        return yield* connection.sendPath(
          {
            method: "GET",
            path,
            template,
            ...(template.includes("projects") || template.includes("deployments")
              ? { query: [["teamId", pin.teamId]] as const }
              : {}),
          },
          { effect: "read", step, flags: { ownership: true } },
        );
      });
    if (call.query["slug"] !== undefined) {
      const answer = yield* lookup(`/v2/teams/${pin.teamId}`, "/v2/teams/{teamId}");
      yield* checked(() => {
        const data = object(answer.data);
        if (data["id"] !== pin.teamId || data["slug"] !== call.query["slug"])
          fail("The team slug does not belong to the pinned team.");
      });
    }
    for (const project of refs.projects) {
      const answer = yield* lookup(`/v9/projects/${encodeURIComponent(project)}`, "/v9/projects/{idOrName}");
      yield* checked(() => {
        const data = object(answer.data);
        if (typeof data["id"] !== "string" || !data["id"] || data["accountId"] !== pin.teamId)
          fail("Project ownership is foreign, missing, or malformed.");
      });
    }
    for (const deployment of refs.deployments) {
      const answer = yield* lookup(`/v13/deployments/${encodeURIComponent(deployment)}`, "/v13/deployments/{idOrUrl}");
      yield* checked(() => {
        const data = object(answer.data);
        if (
          typeof data["id"] !== "string" ||
          !data["id"] ||
          data["ownerId"] !== pin.teamId ||
          (data["teamId"] !== undefined && data["teamId"] !== pin.teamId) ||
          (object(data["team"])["id"] !== undefined && object(data["team"])["id"] !== pin.teamId)
        )
          fail("Deployment ownership is foreign, missing, or malformed.");
      });
    }
  });
}

export function readPinnedTeam(connection: Connection, pin: VercelTeamPin) {
  return connection.sendPath({ method: "GET", path: `/v2/teams/${pin.teamId}`, template: "/v2/teams/{teamId}" }).pipe(
    Effect.flatMap((answer) =>
      checked(() => {
        const data = object(answer.data);
        if (data["id"] !== pin.teamId || typeof data["slug"] !== "string" || !data["slug"])
          fail("The pinned team's identity is missing or malformed.");
        return data;
      }),
    ),
  );
}
