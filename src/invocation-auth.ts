import type { Connector, ConnectorContext, ToolDef } from "./types.js";
import { vettedSchemaDigest } from "./catalog-drift.js";

// Only built-in factories register local credential checks. This hook is not
// part of Connector, and a replacement callTool cannot inherit its proof.
const checks = new WeakMap<Connector, {
  callTool: Connector["callTool"];
  check: (ctx: ConnectorContext) => Promise<void>;
}>();

export function registerInvocationAuth(connector: Connector, check: (ctx: ConnectorContext) => Promise<void>): void {
  checks.set(connector, { callTool: connector.callTool, check });
}

/** Local credential resolution only, before entering any connector call. */
export async function resolveInvocationAuth(connector: Connector, ctx: ConnectorContext): Promise<void> {
  const entry = checks.get(connector);
  if (entry?.callTool === connector.callTool) await entry.check(ctx);
}

interface RequestInvocations {
  entered: EnteredCall[];
  authFailures: Map<string, boolean>;
  retryReads: Map<string, string>;
}
export interface ReplayRead {
  address: string;
  digest: string;
}
interface EnteredCall extends ReplayRead {
  classification: "read" | "write";
  fresh: boolean;
}
const requests = new WeakMap<object, RequestInvocations>();

function requestFor(scope: object): RequestInvocations {
  let facts = requests.get(scope);
  if (!facts) {
    facts = { entered: [], authFailures: new Map(), retryReads: new Map() };
    requests.set(scope, facts);
  }
  return facts;
}

/** Bind the verdict, annotation facts and schemas used for this call. */
export async function classificationDigest(definition: ToolDef): Promise<string> {
  let schema: string;
  try { schema = await vettedSchemaDigest(definition); }
  catch { return ""; } // A digest refusal blocks recovery, not an ordinary call.
  const annotations = Object.entries(definition.annotations ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const bytes = new TextEncoder().encode(JSON.stringify({ classification: definition.classification, annotations, schema }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Called by the host immediately before callTool, using its private scope. */
export function recordCallEntry(scope: object, call: EnteredCall): void {
  requestFor(scope).entered.push({ ...call });
}

export function bindReplayReads(scope: object, reads: ReplayRead[]): void {
  requestFor(scope).retryReads = new Map(reads.map(read => [read.address, read.digest]));
}

export function replayClassificationMatches(scope: object, address: string, digest: string, fresh: boolean): boolean {
  const expected = requestFor(scope).retryReads.get(address);
  return expected === undefined || (fresh && expected === digest);
}

/** Eligibility comes from invocation control flow, never error fields. */
export function recordAuthFailure(scope: object, connector: string, eligible: boolean): void {
  const failures = requestFor(scope).authFailures;
  failures.set(connector, eligible && failures.get(connector) !== false);
}

export function authRecoveryFacts(scope: object, connector: string): {
  writeEntered: boolean; unsafeEntered: boolean; eligible: boolean; reads: ReplayRead[];
} {
  const facts = requestFor(scope);
  const writeEntered = facts.entered.some(call => call.classification === "write");
  const reads = new Map<string, string>();
  let unsafeEntered = writeEntered;
  for (const call of facts.entered) {
    unsafeEntered ||= !call.fresh || !call.digest || (reads.has(call.address) && reads.get(call.address) !== call.digest);
    reads.set(call.address, call.digest);
  }
  return { writeEntered, unsafeEntered, eligible: !unsafeEntered && facts.authFailures.get(connector) === true,
    reads: [...reads].map(([address, digest]) => ({ address, digest })) };
}
