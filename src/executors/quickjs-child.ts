import { prepareExecuteResultForTransport } from "../executor-result.js";
import type { ExecutorProvider } from "../types.js";
import {
  MAX_QUICKJS_IPC_BYTES,
  MAX_QUICKJS_HOST_RPC_BYTES,
  type ChildToParentMessage,
  type ExecutionPayload,
  type HostCallPayload,
  type HostResultPayload,
  type ParentToChildMessage,
  type RunPayload,
  serializedBytes,
  stringifyBounded,
} from "./quickjs-protocol.js";
import { executeQuickJs, prepareQuickJs } from "./quickjs-runtime.js";

let activeJobId: number | undefined;
let nextCallId = 1;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function send(message: ChildToParentMessage): void {
  if (!process.send) throw new Error("QuickJS child IPC channel is unavailable.");
  // Bound the actual process.send envelope, not only its nested payloadJson.
  // Guest-controlled strings must be rejected while they are still isolated
  // in this disposable process, before Node materializes them in the parent.
  stringifyBounded(message, "QuickJS child IPC envelope");
  process.send(message);
}

function provider(name: string, jobId: number): ExecutorProvider {
  const functions = new Proxy(
    Object.create(null) as ExecutorProvider["fns"],
    {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        return async (...args: unknown[]): Promise<unknown> => {
          const callId = nextCallId++;
          const payloadJson = stringifyBounded(
            {
              namespace: name,
              functionName: key,
              args,
            } satisfies HostCallPayload,
            "Host call payload",
            MAX_QUICKJS_HOST_RPC_BYTES,
          );
          const result = new Promise<unknown>((resolve, reject) => {
            pending.set(callId, { resolve, reject });
          });
          send({
            type: "host-call",
            jobId,
            callId,
            payloadJson,
          });
          return result;
        };
      },
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === "string"
          ? { configurable: true, enumerable: false }
          : undefined,
    },
  );
  return { name, fns: functions };
}

function fixedTransportFailure(message: string): ExecutionPayload {
  return {
    outcome: {
      result: undefined,
      error: message.slice(0, 4_000),
    },
  };
}

async function run(payload: RunPayload): Promise<void> {
  if (activeJobId !== undefined) {
    throw new Error("QuickJS child received overlapping executions.");
  }
  activeJobId = payload.id;
  try {
    const providers = payload.providerNames.map((name) =>
      provider(name, payload.id),
    );
    const raw = await executeQuickJs(
      payload.code,
      providers,
      payload.options,
    );
    const prepared: ExecutionPayload = {
      outcome: prepareExecuteResultForTransport(raw),
    };
    let payloadJson: string;
    try {
      payloadJson = stringifyBounded(prepared, "QuickJS execution result");
    } catch (err) {
      payloadJson = JSON.stringify(
        fixedTransportFailure(
          `QuickJS execution result exceeded the ${MAX_QUICKJS_IPC_BYTES}-byte IPC limit: ${msg(err)}`,
        ),
      );
    }
    send({ type: "result", jobId: payload.id, payloadJson });
  } finally {
    activeJobId = undefined;
    for (const request of pending.values()) {
      request.reject(new Error("Execution ended before the host call settled."));
    }
    pending.clear();
  }
}

process.on("message", (message: ParentToChildMessage) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "host-result") {
    if (message.jobId !== activeJobId) return;
    const request = pending.get(message.callId);
    if (!request) return;
    pending.delete(message.callId);
    if (
      serializedBytes(message.payloadJson) > MAX_QUICKJS_HOST_RPC_BYTES
    ) {
      request.reject(new Error("Host result exceeded the IPC limit."));
      return;
    }
    try {
      const result = JSON.parse(message.payloadJson) as HostResultPayload;
      if (result.ok) request.resolve(result.value);
      else request.reject(new Error(result.error));
    } catch (err) {
      request.reject(new Error(`Invalid host result: ${msg(err)}`));
    }
    return;
  }
  if (message.type !== "run") return;
  if (serializedBytes(message.payloadJson) > MAX_QUICKJS_IPC_BYTES) {
    throw new Error("Run payload exceeded the IPC limit.");
  }
  const payload = JSON.parse(message.payloadJson) as RunPayload;
  void run(payload).catch((err) => {
    const payloadJson = JSON.stringify(
      fixedTransportFailure(`QuickJS child failed: ${msg(err)}`),
    );
    send({ type: "result", jobId: payload.id, payloadJson });
    activeJobId = undefined;
  });
});

process.on("disconnect", () => process.exit(0));

// The parent does not start an execution's wall budget until the trusted WASM
// module is loaded. This keeps cold-start latency from being misclassified as
// guest CPU/wall failure while the parent's startup timeout still bounds a
// child that never becomes ready.
await prepareQuickJs();
send({ type: "ready" });
