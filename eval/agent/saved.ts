/** Complete fake-only grading inputs, separate from the clipped display trace. */
import { World, type ArtifactSnapshot } from "../fakes/world.js";
import type { TrackerState } from "../fakes/tracker.js";
import type { ChatState, AuditState } from "../fakes/services.js";
import type { CallRecord } from "../fakes/service.js";
import type { ProgramObservation } from "../deploy/observed-executor.js";
import type { AgentTrace } from "./trace.js";

export interface SavedGradeInputs {
  version: 1;
  trace: AgentTrace;
  world: {
    tracker: TrackerState;
    chat: ChatState;
    audit: AuditState;
    oauth: { connected: boolean; starts: number; visits: number };
    artifacts?: ArtifactSnapshot;
    programs: ProgramObservation[];
    calls: CallRecord[];
  };
}

export function saveGradeInputs(world: World, trace: AgentTrace): SavedGradeInputs {
  return { version: 1, trace, world: {
    tracker: world.tracker, chat: world.chat, audit: world.audit,
    oauth: { connected: world.oauth.connected, starts: world.oauth.starts, visits: world.oauth.visits },
    ...(world.artifacts ? { artifacts: world.artifacts } : {}),
    programs: world.programs, calls: world.ledger.calls,
  } };
}

export function restoreGradeInputs(saved: SavedGradeInputs): { world: World; trace: AgentTrace } {
  if (saved.version !== 1) throw new Error("Unsupported saved grading inputs");
  // No servers, HTTP requests, CLI processes, or model calls are started.
  const world = new World();
  Object.assign(world.tracker, saved.world.tracker);
  Object.assign(world.chat, saved.world.chat);
  Object.assign(world.audit, saved.world.audit);
  Object.assign(world.oauth, saved.world.oauth);
  if (saved.world.artifacts) world.artifacts = saved.world.artifacts;
  world.programs = saved.world.programs;
  world.ledger.calls.push(...saved.world.calls);
  return { world, trace: saved.trace };
}
