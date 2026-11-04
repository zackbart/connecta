import { traceFor } from "../timing-trace.js";
// One owner per existing upstream request identity. Facts survive revocation;
// retaining them never reconstitutes a call capability or a live operation.
import { Context, Effect, Exit, Scope } from "effect";
import type { AuthorizationHandoff } from "../errors.js";
import type { SentSecrets } from "../sent-secrets.js";
import type { ToolDef } from "../types.js";
import type { CallLease } from "./call.js";
import { RequestReads } from "./request-reads.js";
import { detach } from "./run.js";

export interface RequestInvocations {
  entered: Array<{ address: string; classification: "read" | "write"; fresh: boolean; definition: ToolDef }>;
  authFailures: Map<string, boolean>;
  retryReads: Map<string, string>;
}
export interface RequestHandoffs {
  create: (connector: string) => Promise<AuthorizationHandoff>;
  enabled: boolean;
  handoffs: Map<string, Effect.Effect<AuthorizationHandoff, unknown>>;
}
/** Work that can still add to a secret set. A sealing run waits until none is left. */
export class PendingWork {
  private active = 0;
  private readonly waiting = new Set<() => void>();
  get pending(): boolean {
    return this.active > 0;
  }
  /** Returns the function that ends this piece of work; calling it twice counts once. */
  begin(): () => void {
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.active > 0) return;
      for (const wake of this.waiting) wake();
      this.waiting.clear();
    };
  }
  /** Succeeds when nothing is pending. Interrupting it drops the wait. */
  readonly idle: Effect.Effect<void> = Effect.callback<void>((resume) => {
    if (this.active === 0) return resume(Effect.void);
    const wake = () => resume(Effect.void);
    this.waiting.add(wake);
    return Effect.sync(() => {
      this.waiting.delete(wake);
    });
  });
}
export class RequestOwner {
  open = true;
  admitted = false;
  readonly controller = new AbortController();
  readonly finalizers: Array<() => void> = [];
  readonly entries = new Set<object>();
  readonly calls = new Set<CallLease>();
  readonly signals = new WeakMap<AbortSignal, { readonly signal: AbortSignal; readonly refresh: () => void }>();
  readonly scope = Scope.makeUnsafe();
  /** Credential reads whose values have yet to join this request's secret set. */
  readonly credentialReads = new PendingWork();
  // Initialize secrets only when data is sent. Metadata-only UI imports must
  // not retain the payload matcher merely to revoke a request.
  readonly retained = {
    secrets: undefined as SentSecrets | undefined,
    invocations: { entered: [], authFailures: new Map(), retryReads: new Map() } as RequestInvocations,
    handoffs: undefined as RequestHandoffs | undefined,
    reads: undefined as RequestReads | undefined,
  };
  constructor(readonly identity: object) {}
  own(finalizer: () => void): void {
    if (this.open) this.finalizers.push(finalizer);
    else finalizer();
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    const failures: unknown[] = [];
    const attempt = (step: () => void) => {
      try {
        step();
      } catch (failure) {
        failures.push(failure);
      }
    };
    for (const call of this.calls) {
      try {
        call.close();
      } catch (failure) {
        failures.push(...(failure instanceof AggregateError ? failure.errors : [failure]));
      }
    }
    this.calls.clear();
    this.entries.clear();
    this.retained.reads?.close();
    attempt(() => this.controller.abort(new Error("The request ended.")));
    for (const finalizer of this.finalizers.splice(0).reverse()) attempt(finalizer);
    // A synchronous published close revokes first. The runtime scope contains
    // only native children and their cleanup; it cannot renew live authority.
    void detach(Scope.close(this.scope, Exit.void));
    if (failures.length)
      throw new AggregateError(failures, `Closing the request: ${failures.length} cleanup step(s) failed.`);
  }
}
/** This request's read memo; a closed request's memo answers nothing. */
export function requestReads(identity: object): RequestReads {
  return ownerReads(requestOwner(identity));
}
export function ownerReads(owner: RequestOwner): RequestReads {
  const retained = owner.retained;
  if (!retained.reads) {
    retained.reads = new RequestReads(traceFor(owner.identity));
    if (!owner.open) retained.reads.close();
  }
  return retained.reads;
}
export class RequestScope extends Context.Service<RequestScope, RequestOwner>()("connecta/request/Scope") {}
const requests = new WeakMap<object, RequestOwner>();
export function requestOwner(identity: object): RequestOwner {
  let owner = requests.get(identity);
  if (!owner) requests.set(identity, (owner = new RequestOwner(identity)));
  return owner;
}
