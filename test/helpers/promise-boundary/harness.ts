import { expect, vi } from "vitest";
import { memoryStorage } from "../../../src/storage/memory.js";
import { deferred } from "../../fixtures/misc.js";
import { openRequest, viewLease } from "../../../src/runtime/call.js";
import type { ConnectorContext, KVStorage } from "../../../src/types.js";

export type Owner = "call" | "request";
export type Completion = "resolve" | "reject";
export type Seam =
  | "closed-entry"
  | "storage.get"
  | "storage.put"
  | "storage.CAS"
  | "crypto.digest"
  | "crypto.sign"
  | "fetch"
  | "body.cancel.redirect"
  | "body.cancel.size"
  | "request-token.resolve"
  | "handler"
  | "authenticate"
  | "mapper";

/** One held dependency, shared by every fixture; no timer releases its work. */
export class HeldSeam {
  readonly entered = deferred<void>();
  private readonly release = deferred<void>();
  readonly backing = memoryStorage();
  readonly effects: string[] = [];
  readonly signals: AbortSignal[] = [];
  armed = false;
  getKey: (key: string) => boolean = () => true;
  private held = false;
  constructor(readonly name: Seam) {}

  async at<A>(name: Seam, value: A): Promise<A> {
    if (this.armed && !this.held && name === this.name) {
      this.held = true;
      this.entered.resolve();
      await this.release.promise;
    }
    return value;
  }

  settle(completion: Completion): void {
    if (completion === "reject") this.release.reject(new Error("late boundary dependency rejection"));
    else this.release.resolve();
  }

  // A submitted write may complete after revocation. Apply it before holding
  // its acknowledgment; the assertion forbids subsequent writes, not rollback.
  readonly storage: KVStorage = {
    ...this.backing,
    get: async (key) => {
      const value = await this.backing.get(key);
      return this.getKey(key) ? this.at("storage.get", value) : value;
    },
    set: async (...args) => {
      this.effects.push(`put:${args[0]}`);
      await this.backing.set(...args);
      await this.at("storage.put", undefined);
    },
    compareAndSet: async (...args) => {
      this.effects.push(`CAS:${args[0]}`);
      return this.at("storage.CAS", await this.backing.compareAndSet(...args));
    },
    delete: async (key) => {
      this.effects.push(`delete:${key}`);
      await this.backing.delete(key);
    },
  };

  installCrypto(predicate: (data: BufferSource) => boolean = () => true): void {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (predicate(data)) await this.at("crypto.digest", undefined);
      return digest(algorithm, data);
    });
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (algorithm, key, data) => {
      await this.at("crypto.sign", undefined);
      return sign(algorithm, key, data);
    });
  }

  async response(init?: RequestInit): Promise<Response> {
    if (init?.signal) this.signals.push(init.signal);
    this.effects.push("fetch");
    if (this.name.startsWith("body.cancel.")) {
      const size = this.name === "body.cancel.size";
      return new Response(new ReadableStream({ cancel: () => this.at(this.name, undefined) }), {
        status: size ? 200 : 302,
        headers: size ? { "content-length": "2048" } : { location: "https://tickets.example/next" },
      });
    }
    return this.at("fetch", Response.json({ ok: true }));
  }

  async snapshot(): Promise<Array<[string, string | null]>> {
    return Promise.all((await this.backing.list("")).map(async (key) => [key, await this.backing.get(key)]));
  }
}

export interface Fixture {
  start(): Promise<unknown>;
  close(owner: Owner): void;
  cleanup(): Promise<void>;
  /** Request-owned entries survive closing a call; the request still revokes them. */
  requestOwned?: boolean;
  /** Independently tracked operator reset, whose owner is not this caller. */
  resetCompletion?: (completion: Completion) => Promise<void>;
}

export function ownerOf(ctx: ConnectorContext): Pick<Fixture, "close" | "cleanup"> {
  return {
    close: (owner) => {
      if (owner === "call") {
        const lease = viewLease(ctx);
        if (!lease) throw new Error("Matrix call fixture has no lease");
        lease.close();
      } else openRequest(ctx.requestScope ?? ctx).close();
    },
    cleanup: async () => openRequest(ctx.requestScope ?? ctx).close(),
  };
}

type Outcome = { value: unknown } | { error: unknown };
async function within<A>(pending: Promise<A>, ms = 250): Promise<A | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Listen to the runtime itself; adding a catch to the held dependency would mask the defect. */
function unhandledRejections() {
  const reasons: unknown[] = [];
  const web = typeof globalThis.addEventListener === "function";
  const onEvent = (event: Event) => reasons.push((event as Event & { reason: unknown }).reason);
  const onProcess = (reason: unknown) => reasons.push(reason);
  if (web) globalThis.addEventListener("unhandledrejection", onEvent);
  else process.on("unhandledRejection", onProcess);
  return {
    reasons,
    close() {
      if (web) globalThis.removeEventListener("unhandledrejection", onEvent);
      else process.off("unhandledRejection", onProcess);
    },
  };
}

export async function exercise(
  create: (held: HeldSeam, owner: Owner) => Promise<Fixture>,
  seam: Seam,
  owner: Owner,
  completion: Completion,
): Promise<void> {
  const held = new HeldSeam(seam);
  const fixture = await create(held, owner);
  const unhandled = unhandledRejections();
  held.armed = true;
  // Entries whose current contract performs no asynchronous I/O have no
  // reachable held seam. Check their entry refusal without inventing one.
  if (seam === "closed-entry") fixture.close(owner);
  const pending: Promise<Outcome> = fixture.start().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let released = false;
  try {
    if (seam !== "closed-entry")
      expect(await within(held.entered.promise, 1500), "the entry must reach its declared seam").not.toBe("pending");
    const before = await held.snapshot();
    const effects = [...held.effects];
    if (seam !== "closed-entry") fixture.close(owner);
    if (owner === "call" && fixture.requestOwned) {
      expect(await within(pending, 25), "request-owned work survives call closure").toBe("pending");
      fixture.close("request");
    }
    const observed = await within(pending);
    // Capture before releasing even when a baseline fails: no timeout or
    // dependency completion may masquerade as prompt boundary refusal.
    held.settle(completion);
    released = true;
    await pending;
    await fixture.resetCompletion?.(completion);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observed, "the published Promise refuses while its dependency remains held").not.toBe("pending");
    const refused =
      typeof observed === "object" &&
      observed !== null &&
      ("error" in observed ||
        ("value" in observed &&
          typeof observed.value === "object" &&
          observed.value !== null &&
          (("state" in observed.value && observed.value.state === "error") ||
            ("ok" in observed.value && observed.value.ok === false))));
    expect(refused, "rejection or the entry's existing bounded refusal result").toBe(true);
    expect(
      held.signals.every((signal) => signal.aborted),
      "physical I/O cancellation reaches held fetches",
    ).toBe(true);
    if (!fixture.resetCompletion) {
      expect(held.effects, "no subsequent state mutation or dispatch").toEqual(effects);
      expect(await held.snapshot(), "no late state update").toEqual(before);
    }
    expect(unhandled.reasons, "late dependency rejection is observed").toEqual([]);
  } finally {
    if (!released) held.settle("resolve");
    await fixture.cleanup();
    await pending;
    unhandled.close();
  }
}
