/** Observe real guest bridge calls while retaining QuickJS's branded lifecycle. */
import { quickJsExecutor } from "@zackbart/connecta/quickjs";
import { codeError, codeSkill, codeValue } from "./code-surface.js";
import type { Surface } from "../agent/surface.js";
import type { ExecutorProvider } from "@zackbart/connecta";

interface GuestCallObservation {
  name: string;
  args: unknown[];
  outcome: "pending" | "ok" | "error";
  result?: unknown;
  errorCode?: string;
}

export interface ProgramObservation {
  code: string;
  calls: GuestCallObservation[];
  peakCalls: number;
  succeeded: boolean;
}

export function observedExecutor(surface: Surface = "six") {
  const executor = quickJsExecutor();
  const programs: ProgramObservation[] = [];
  const acquire = executor.acquire.bind(executor);
  executor.acquire = async (options) => {
    const lease = await acquire(options);
    const execute = lease.execute.bind(lease);
    lease.execute = async (code, providers) => {
      const program: ProgramObservation = { code, calls: [], peakCalls: 0, succeeded: false };
      programs.push(program);
      let pendingCalls = 0;
      const observed: ExecutorProvider[] = providers.map((provider) => ({
        ...provider,
        fns: Object.fromEntries(
          Object.entries(provider.fns).map(([name, fn]) => [
            name,
            async (...args: unknown[]) => {
              const call: GuestCallObservation = { name: `${provider.name}.${name}`, args, outcome: "pending" };
              program.calls.push(call);
              if (call.name === "connecta.call") program.peakCalls = Math.max(program.peakCalls, ++pendingCalls);
              try {
                const original = await fn(...args);
                const result =
                  surface === "six"
                    ? original
                    : call.name === "connecta.skill"
                      ? codeSkill(args[0], original)
                      : codeValue(original);
                call.outcome = "ok";
                call.result = result;
                return result;
              } catch (original) {
                const error = surface === "six" ? original : codeError(original);
                call.outcome = "error";
                if (error && typeof error === "object" && "code" in error) call.errorCode = String(error.code);
                throw error;
              } finally {
                if (call.name === "connecta.call") pendingCalls -= 1;
              }
            },
          ]),
        ),
      }));
      const result = await execute(code, observed);
      program.succeeded = !result.error;
      return result;
    };
    return lease;
  };
  return { executor, programs };
}
