/**
 * The task format.
 *
 * A task is a world (which fakes, in which starting state, with which faults),
 * a conversation (a first prompt and follow-ups, each optionally preceded by an
 * operator action), an approval policy, and a grader over the fakes' final
 * state and call ledger. Later phases add tasks, not harness code:
 *
 * - P2 (artifacts) needs only new graders over state the deployment adapter
 *   exposes, and `deployment` options to switch the artifacts slot on.
 * - P3 (resumable writes) needs `approvals.deny` (a host that refuses
 *   `resume_execution`), `faults` (an unknown-outcome write), follow-ups that
 *   wait or act between turns (an expired token), and `deployment` options for
 *   any new config key. All four exist today.
 *
 * See `planned.ts` for those tasks written down ahead of time.
 */
import type { Deployment } from "../deploy/node.js";
import type { Fault } from "../fakes/service.js";
import type { ServiceId, World, WorldOptions } from "../fakes/world.js";
import type { AgentTrace, ToolUse } from "../agent/trace.js";

export interface Check {
  id: string;
  description: string;
  pass: boolean;
  detail?: string;
  /** Recorded and reported, but never decides pass/fail. */
  advisory?: boolean;
}

interface TurnContext {
  world: World;
  deployment: Deployment;
  /** Everything the agent did so far. */
  trace: AgentTrace;
  /** Leave a line in the transcript saying what the operator did. */
  note(text: string): void;
}

interface FollowUp {
  /**
   * The operator's move before this message is sent. Return `false` to end
   * the conversation here instead (the precondition for the follow-up was not
   * met, and sending it anyway would be a lie to the agent).
   */
  before?(ctx: TurnContext): Promise<boolean | void>;
  prompt: string;
}

interface GradeContext {
  world: World;
  trace: AgentTrace;
}

/** A scripted MCP caller standing in for the agent, for the self-test. */
export interface ReferenceContext {
  world: World;
  call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; structured: unknown }>;
  /** Run the next follow-up's operator step, as the runner would between turns. */
  nextTurn(): Promise<boolean>;
}

export interface ActiveTask {
  status: "active";
  id: string;
  title: string;
  introducedIn: "baseline" | "P2" | "P3";
  /** What behaviour the task isolates, in one sentence. */
  measures: string;
  world?: WorldOptions;
  faults?: { service: ServiceId; fault: Fault }[];
  /** Passed through to the deployment adapter untouched. */
  deployment?: Record<string, unknown>;
  prompt: string;
  followUps?: FollowUp[];
  /**
   * Which connecta tools the host pre-approves. `allow` defaults to every tool
   * the server lists; `deny` is refused without a prompt, like a human saying
   * no. Tools the server does not annotate read-only are recorded as approvals
   * exercised whenever the agent uses them.
   */
  approvals?: { allow?: string[]; deny?: string[] };
  limits?: { timeoutMs?: number; maxBudgetUsd?: number };
  grade(ctx: GradeContext): Check[];
  /** The ideal route, scripted; the self-test checks it passes the grader. */
  reference(ctx: ReferenceContext): Promise<void>;
}

/**
 * A task written down before the surface it needs exists. Documentation only:
 * the runner lists it in the report and never executes it.
 */
export interface PlannedTask {
  status: "planned";
  id: string;
  title: string;
  introducedIn: "P2" | "P3";
  measures: string;
  prompt: string;
  sketch: {
    world: string;
    turns?: string[];
    approvals?: string;
    faults?: string;
    grading: string[];
  };
}

export function uses(trace: AgentTrace, tool: string): ToolUse[] {
  return trace.toolUses.filter((use) => use.tool === tool);
}
