import type { Connector, ConnectorContext, ToolDef } from "./types.js";
import { vettedSchemaDigest } from "./catalog-drift.js";

// Only built-in factories register local credential checks. This hook is not
// part of Connector, and a replacement callTool cannot inherit its proof.
const checks = new WeakMap<
  Connector,
  {
    callTool: Connector["callTool"];
    check: (ctx: ConnectorContext) => Promise<void>;
  }
>();

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
interface EnteredCall {
  address: string;
  classification: "read" | "write";
  fresh: boolean;
  definition: ToolDef;
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
  try {
    const schema = await vettedSchemaDigest(definition);
    const annotations = Object.entries(definition.annotations ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const bytes = new TextEncoder().encode(
      JSON.stringify({ classification: definition.classification, annotations, schema }),
    );
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    // A digest refusal blocks recovery, not an ordinary call.
    return "";
  }
}

/** Called by the host immediately before callTool, using its private scope. */
export function recordCallEntry(scope: object, call: Omit<EnteredCall, "definition">, definition: ToolDef): void {
  // Snapshot synchronously. Recovery hashes this private copy only when it
  // needs a replay binding, without changing ordinary admission or completion.
  requestFor(scope).entered.push({ ...call, definition: structuredClone(definition) });
}

export function bindReplayReads(scope: object, reads: ReplayRead[]): void {
  requestFor(scope).retryReads = new Map(reads.map((read) => [read.address, read.digest]));
}

export function replayClassificationDigest(scope: object, address: string): string | undefined {
  return requestFor(scope).retryReads.get(address);
}

/** Eligibility comes from invocation control flow, never error fields. */
export function recordAuthFailure(scope: object, connector: string, eligible: boolean): void {
  const failures = requestFor(scope).authFailures;
  failures.set(connector, eligible && failures.get(connector) !== false);
}

export async function authRecoveryFacts(
  scope: object,
  connector: string,
): Promise<{
  writeEntered: boolean;
  unsafeEntered: boolean;
  eligible: boolean;
  reads: ReplayRead[];
}> {
  const facts = requestFor(scope);
  const writeEntered = facts.entered.some((call) => call.classification === "write");
  const reads = new Map<string, string>();
  let unsafeEntered = writeEntered;
  for (const call of facts.entered) {
    const digest = await classificationDigest(call.definition);
    unsafeEntered ||= !call.fresh || !digest || (reads.has(call.address) && reads.get(call.address) !== digest);
    reads.set(call.address, digest);
  }
  return {
    writeEntered,
    unsafeEntered,
    eligible: !unsafeEntered && facts.authFailures.get(connector) === true,
    reads: [...reads].map(([address, digest]) => ({ address, digest })),
  };
}
