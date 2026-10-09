/** Complete fake-only grading inputs, separate from the clipped display trace. */
import { World } from "../fakes/world.js";
import type { TrackerState } from "../fakes/tracker.js";
import type { ChatState, AuditState } from "../fakes/services.js";
import type { CallRecord } from "../fakes/service.js";
import type { ProgramObservation } from "../deploy/observed-executor.js";
import type { AgentTrace } from "./trace.js";

export interface SavedGradeInputs {
  version: 1;
  trace: AgentTrace;
  world: {
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
  world.ci.splice(0, world.ci.length, ...state.ci!);
  Object.assign(world.tracker, saved.world.tracker);
  Object.assign(world.chat, saved.world.chat);
  Object.assign(world.audit, saved.world.audit);
  Object.assign(world.oauth, saved.world.oauth);
  world.programs = saved.world.programs;
  world.ledger.calls.push(...saved.world.calls);
  return { world, trace: saved.trace };
}
