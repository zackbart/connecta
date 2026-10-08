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
  return { version: 1, trace, world: {
    ci: world.ci, tracker: world.tracker, chat: world.chat, audit: world.audit,
    oauth: { connected: world.oauth.connected, starts: world.oauth.starts, visits: world.oauth.visits },
    programs: world.programs, calls: world.ledger.calls,
  } };
}

export function restoreGradeInputs(saved: SavedGradeInputs): { world: World; trace: AgentTrace } {
  if (saved.version !== 1) throw new Error("Unsupported saved grading inputs");
  // No servers, HTTP requests, CLI processes, or model calls are started.
  const world = new World();
  if (saved.world.ci) world.ci.splice(0, world.ci.length, ...saved.world.ci);
  Object.assign(world.tracker, saved.world.tracker);
  Object.assign(world.chat, saved.world.chat);
  Object.assign(world.audit, saved.world.audit);
  Object.assign(world.oauth, saved.world.oauth);
  world.programs = saved.world.programs;
  world.ledger.calls.push(...saved.world.calls);
  return { world, trace: saved.trace };
}
