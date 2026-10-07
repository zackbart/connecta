import { executorName, isAdmittingExecutor } from "./executor-admission.js";
import type { AdmittingExecutor, Executor } from "./types.js";

// Symbol.for and a data descriptor survive duplicate packages and minification.
// This is a construction contract, not a security boundary against host config.
const EXECUTOR_BRAND = Symbol.for("connecta.executor");
type ExecutorLifecycle = "leased" | "self-managed";

export function brandExecutor<T extends Executor>(executor: T, lifecycle: ExecutorLifecycle): T {
  Object.defineProperty(executor, EXECUTOR_BRAND, {
    value: Object.freeze({ version: 1, lifecycle }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return executor;
}

export function assertExecutor(executor: Executor): void {
  const descriptor = Object.getOwnPropertyDescriptor(executor, EXECUTOR_BRAND);
  const brand = descriptor?.value;
  if (typeof executor.execute === "function" && descriptor?.enumerable === false &&
      brand?.version === 1 && (brand.lifecycle === "leased" || brand.lifecycle === "self-managed")) return;
  throw new Error(
    "ConnectaConfig.executor must declare its lifecycle. Unbranded executors, including " +
      "upstream DynamicWorkerExecutor, are unsupported because request-owned resources " +
      "must be released when a run ends. Use one of these options: " +
      'import { workerExecutor } from "@zackbart/connecta/worker"; ' +
      "executor: workerExecutor({ loader: env.LOADER }); " +
      'import { quickJsExecutor } from "@zackbart/connecta/quickjs"; executor: quickJsExecutor(); ' +
      'or import { customExecutor } from "@zackbart/connecta"; ' +
      'executor: customExecutor(myExecutor, { lifecycle: "self-managed" }).',
  );
}

/** Explicitly accept responsibility for a custom sandbox's run resources. */
export interface CustomExecutorOptions {
  /**
   * The custom executor owns guest termination and resource cleanup, including
   * budget exhaustion, cancellation, and deadlines. Connecta cannot add these
   * guarantees to an executor that exposes only execute().
   */
  lifecycle: "self-managed";
}

/**
 * Opt a custom sandbox into createConnecta without changing the original object.
 * Delegated methods retain their original receiver, including private fields.
 */
export function customExecutor(executor: AdmittingExecutor, options: CustomExecutorOptions): AdmittingExecutor;
export function customExecutor(executor: Executor, options: CustomExecutorOptions): Executor;
export function customExecutor(executor: Executor, options: CustomExecutorOptions): Executor {
  if (options?.lifecycle !== "self-managed" || typeof executor?.execute !== "function") {
    throw new Error('customExecutor requires an executor and { lifecycle: "self-managed" }.');
  }
  const name = executorName(executor);
  const wrapper = {
    ...(name ? { name } : {}),
    execute: executor.execute.bind(executor),
    ...(executor.close ? { close: executor.close.bind(executor) } : {}),
    ...(isAdmittingExecutor(executor) ? {
      acquire: executor.acquire.bind(executor),
      ...(executor.admissionSnapshot ? { admissionSnapshot: executor.admissionSnapshot.bind(executor) } : {}),
    } : {}),
  };
  return brandExecutor(wrapper, "self-managed");
}
