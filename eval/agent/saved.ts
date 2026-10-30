/** Complete fake-only grading inputs, separate from the clipped display trace. */
import { World, type ProviderFakeName, type ProviderFakeOf } from "../fakes/world.js";
import { PROVIDER_FAKES } from "../fakes/providers.generated.js";
import type { TrackerState } from "../fakes/tracker.js";
import type { ChatState, AuditState } from "../fakes/services.js";
import type { CallRecord } from "../fakes/service.js";
import type { ProgramObservation } from "../deploy/observed-executor.js";
import type { AgentTrace } from "./trace.js";

export interface SavedGradeInputs {
  version: 1;
  trace: AgentTrace;
  /** Each enabled provider-local fake's state sits under its provider name. */
  world: { [Name in ProviderFakeName]?: ProviderFakeOf<Name>["state"] } & {
    quickbooks?: World["quickbooks"]["state"];
    google?: World["google"]["state"];
    rest?: World["rest"];
    github?: World["github"];
    breeze?: World["breeze"];
    ccb?: World["ccb"];
    pco?: World["pco"];
    overflow?: World["overflow"];
    tithely?: World["tithely"];
    ci?: World["ci"];
    tracker: TrackerState;
    chat: ChatState;
    audit: AuditState;
    oauth: { connected: boolean; starts: number; visits: number };
    programs: ProgramObservation[];
    calls: CallRecord[];
  };
}

export function saveGradeInputs(world: World, trace: AgentTrace): SavedGradeInputs {
  return {
    version: 1,
    trace,
    world: {
      ...Object.fromEntries(world.providerFakes().map(({ name, fake }) => [name, fake.state])),
      ...(world.options.quickbooks ? { quickbooks: world.quickbooks.state } : {}),
      ...(world.options.google ? { google: world.google.state } : {}),
      rest: world.rest,
      ...(world.options.github ? { github: world.github } : {}),
      ...(world.options.tithely ? { tithely: world.tithely } : {}),
      ...(world.options.breeze ? { breeze: world.breeze } : {}),
      ...(world.options.ccb ? { ccb: world.ccb } : {}),
      ...(world.options.planningCenter ? { pco: world.pco } : {}),
      ...(world.options.overflow ? { overflow: world.overflow } : {}),
      ci: world.ci,
      tracker: world.tracker,
      chat: world.chat,
      audit: world.audit,
      oauth: { connected: world.oauth.connected, starts: world.oauth.starts, visits: world.oauth.visits },
      programs: world.programs,
      calls: world.ledger.calls,
    },
  };
}

export function restoreGradeInputs(saved: SavedGradeInputs): { world: World; trace: AgentTrace } {
  if (saved.version !== 1) throw new Error("Unsupported saved grading inputs");
  // No servers, HTTP requests, CLI processes, or model calls are started.
  const world = new World();
  const state = saved.world;
  const requireEvidence = (condition: unknown, field: string) => {
    if (!condition) throw new Error(`Incomplete saved grading evidence: ${field}`);
  };
  requireEvidence(state && saved.trace, "world/trace");
  for (const [field, value] of [
    ["tracker.issues", state.tracker?.issues],
    ["chat.channels", state.chat?.channels],
    ["chat.messages", state.chat?.messages],
    ["audit.exports", state.audit?.exports],
    ["programs", state.programs],
    ["calls", state.calls],
    ["trace.toolUses", saved.trace.toolUses],
    ["trace.transcript", saved.trace.transcript],
    ["trace.resultSubtypes", saved.trace.resultSubtypes],
    ["trace.permissionDenials", saved.trace.permissionDenials],
  ] as const)
    requireEvidence(Array.isArray(value), field);
  // Every seeded issue/channel must be present; a partial snapshot must never
  // inherit fresh seed state and falsely prove that a refused write changed nothing.
  for (const issue of world.tracker.issues)
    requireEvidence(state.tracker.issues.filter((i) => i.id === issue.id).length === 1, `tracker.${issue.id}`);
  for (const issue of state.tracker.issues)
    requireEvidence(
      (issue.status === "open" || issue.status === "closed") &&
        typeof issue.title === "string" &&
        typeof issue.updatedAt === "string" &&
        Array.isArray(issue.labels) &&
        Array.isArray(issue.comments),
      `tracker.${issue.id}.state`,
    );
  for (const channel of world.chat.channels)
    requireEvidence(
      state.chat.channels.some((c) => c.id === channel.id && c.name === channel.name),
      `chat.${channel.id}`,
    );
  requireEvidence(
    state.chat.messages.every(
      (m) => typeof m.byAgent === "boolean" && typeof m.channel === "string" && typeof m.text === "string",
    ),
    "chat.messages.state",
  );
  requireEvidence(
    state.oauth &&
      typeof state.oauth.connected === "boolean" &&
      Number.isInteger(state.oauth.starts) &&
      Number.isInteger(state.oauth.visits),
    "oauth",
  );
  // CI is immutable in the fakes. Its complete universe is also needed to
  // reject contradictory or invented answer facts, even about another run.
  requireEvidence(Array.isArray(state.ci) && state.ci.length === world.ci.length, "ci");
  for (const run of world.ci)
    requireEvidence(
      state.ci?.filter(
        (r) =>
          r.runId === run.runId &&
          r.branch === run.branch &&
          r.status === run.status &&
          r.commit === run.commit &&
          typeof r.startedAt === "string",
      ).length === 1,
      `ci.${run.runId}`,
    );
  for (const name of Object.keys(PROVIDER_FAKES) as ProviderFakeName[]) {
    const saved = state[name];
    if (saved) {
      requireEvidence(PROVIDER_FAKES[name].saved(saved), name);
      Object.assign(world.fakes[name].state, structuredClone(saved));
    } else if (state.calls.some((c) => c.service === name))
      throw new Error(`Incomplete saved grading evidence: ${name}`);
  }
  if (state.quickbooks) {
    requireEvidence(state.quickbooks.companies && Array.isArray(state.quickbooks.grants), "quickbooks");
    Object.assign(world.quickbooks.state, structuredClone(state.quickbooks));
  } else if (state.calls.some((c) => c.service === "quickbooks"))
    throw new Error("Incomplete saved grading evidence: quickbooks");
  if (state.google) {
    requireEvidence(state.google.accounts && Array.isArray(state.google.mints), "google");
    for (const subject of ["alice@example.com", "bob@example.com"]) {
      const account = state.google.accounts[subject as keyof typeof state.google.accounts];
      requireEvidence(
        account &&
          (
            ["files", "permissions", "messages", "drafts", "responses", "created", "mutations", "values"] as const
          ).every((key) => Array.isArray(account[key])),
        `google.${subject}`,
      );
      requireEvidence(
        account?.document && account?.spreadsheet && account?.presentation && account?.form,
        `google.${subject}.resources`,
      );
    }
    Object.assign(world.google.state, structuredClone(state.google));
  } else if (state.calls.some((c) => ["gmail", "drive", "docs", "sheets", "slides", "forms"].includes(c.service)))
    throw new Error("Incomplete saved grading evidence: google");
  if (state.rest) {
    for (const key of ["refunds", "dns", "purges", "envs"] as const)
      requireEvidence(Array.isArray(state.rest[key]), `rest.${key}`);
    for (const [family, seeded] of [
      ["dns", world.rest.dns],
      ["envs", world.rest.envs],
    ] as const)
      for (const record of seeded)
        requireEvidence(
          state.rest[family].filter((r) => r.id === record.id).length === 1,
          `rest.${family}.${record.id}`,
        );
    requireEvidence(state.rest.refundKeys && typeof state.rest.refundFaulted === "boolean", "rest.refund-recovery");
    Object.assign(world.rest, structuredClone(state.rest));
  } else if (
    state.calls.some((c) => /^(stripe_sandbox|cloudflare_prod|cloudflare_legacy|vercel_rest)$/.test(c.service))
  )
    throw new Error("Incomplete saved grading evidence: rest");
  if (state.tithely) {
    for (const key of ["organizations", "accounts", "methods", "charges", "recurring", "refunds", "cancelled"] as const)
      requireEvidence(Array.isArray(state.tithely[key]), `tithely.${key}`);
    Object.assign(world.tithely, structuredClone(state.tithely));
  } else if (state.calls.some((c) => c.service === "tithely"))
    throw new Error("Incomplete saved grading evidence: tithely");
  if (state.overflow) {
    for (const key of [
      "donors",
      "campaigns",
      "locations",
      "contributions",
      "subscriptions",
      "refunds",
      "chargebacks",
      "deposits",
      "refunded",
      "updated",
    ] as const)
      requireEvidence(Array.isArray(state.overflow[key]), `overflow.${key}`);
    Object.assign(world.overflow, structuredClone(state.overflow));
  } else if (state.calls.some((c) => c.service === "overflow"))
    throw new Error("Incomplete saved grading evidence: overflow");
  if (state.github) {
    for (const key of ["repositories", "releases", "merges"] as const)
      requireEvidence(Array.isArray(state.github[key]), `github.${key}`);
    Object.assign(world.github, structuredClone(state.github));
  } else if (state.calls.some((c) => c.service === "github"))
    throw new Error("Incomplete saved grading evidence: github");
  if (state.breeze) {
    for (const key of ["people", "created", "updated"] as const)
      requireEvidence(Array.isArray(state.breeze[key]), `breeze.${key}`);
    Object.assign(world.breeze, structuredClone(state.breeze));
  } else if (state.calls.some((c) => c.service === "breeze"))
    throw new Error("Incomplete saved grading evidence: breeze");
  if (state.ccb) {
    for (const key of ["people", "updated"] as const) requireEvidence(Array.isArray(state.ccb[key]), `ccb.${key}`);
    Object.assign(world.ccb, structuredClone(state.ccb));
  } else if (state.calls.some((c) => c.service === "ccb")) throw new Error("Incomplete saved grading evidence: ccb");
  if (state.pco) {
    for (const key of ["people", "notes", "updated"] as const)
      requireEvidence(Array.isArray(state.pco[key]), `pco.${key}`);
    for (const person of world.pco.people)
      requireEvidence(state.pco.people.filter((p) => p.id === person.id).length === 1, `pco.${person.id}`);
    Object.assign(world.pco, structuredClone(state.pco));
  } else if (state.calls.some((c) => c.service === "pco")) throw new Error("Incomplete saved grading evidence: pco");
  world.ci.splice(0, world.ci.length, ...state.ci!);
  Object.assign(world.tracker, saved.world.tracker);
  Object.assign(world.chat, saved.world.chat);
  Object.assign(world.audit, saved.world.audit);
  Object.assign(world.oauth, saved.world.oauth);
  world.programs = saved.world.programs;
  world.ledger.calls.push(...saved.world.calls);
  return { world, trace: saved.trace };
}
