import { vi } from "vitest";
import { memoryStorage } from "../../src/storage/memory.js";
import type {
  ConnectorContext,
  Executor,
  ExecutorProvider,
  KVStorage,
  Logger,
} from "../../src/types.js";
import { silentLogger } from "../helpers.js";

const TEST_BASE_URL = "https://connecta.test";

export function connectorContext(
  storage: KVStorage = memoryStorage(),
): ConnectorContext {
  return { storage, logger: silentLogger, baseUrl: TEST_BASE_URL };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function spyLogger(): {
  logger: Logger;
  warn: ReturnType<typeof vi.fn>;
  warnings: () => string[];
} {
  const warn = vi.fn();
  return {
    logger: { ...silentLogger, warn },
    warn,
    warnings: () => warn.mock.calls.map((args) => args.map(String).join(" ")),
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function scriptedExecutor(
  run: (
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
  ) => Promise<unknown>,
): Executor {
  return {
    async execute(_code, providers: ExecutorProvider[]) {
      const connecta = providers.find((provider) => provider.name === "connecta");
      if (!connecta) throw new Error("no connecta provider");
      try {
        return { result: await run(connecta.fns) };
      } catch (err) {
        return {
          result: undefined,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export function fakeExecutor(outcome: {
  result?: unknown;
  error?: string;
  logs?: string[];
}): Executor {
  return {
    async execute() {
      return {
        result: outcome.result,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.logs !== undefined ? { logs: outcome.logs } : {}),
      };
    },
  };
}
