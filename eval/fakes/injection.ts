/**
 * Opt-in latency and fault injection for one run. Every default is zero, so a
 * run without these settings is the run the harness has always measured.
 *
 * - `latencyMs` delays every downstream request a fake vendor answers, on the
 *   fake's side, so both deployment targets see the same delay.
 * - `hungConnector` adds connector `stalled`, whose server accepts every
 *   request and never answers.
 * - `unauthorizedConnector` adds connector `revoked`, whose saved credential
 *   its server answers with 401 on every request.
 * - `d1LatencyMs` delays each D1 round trip on the worker target.
 *
 * Injected connectors join every pool, so unscoped discovery reaches them.
 * Their requests never enter the world's ledger; graders see only the task's
 * own vendors.
 */
import { serveFetch, type Served } from "../support/serve.js";
import type { ConnectorSpec } from "./world.js";

export interface Injection {
  latencyMs: number;
  hungConnector: boolean;
  unauthorizedConnector: boolean;
  d1LatencyMs: number;
}

export const NO_INJECTION: Injection = Object.freeze({
  latencyMs: 0,
  hungConnector: false,
  unauthorizedConnector: false,
  d1LatencyMs: 0,
});

const HUNG_CONNECTOR = "stalled";
const UNAUTHORIZED_CONNECTOR = "revoked";
const REVOKED_CREDENTIAL = "eval_revoked_credential";

/** Results written before injection existed ran with none. */
export function injectionOf(recorded: Partial<Injection> | undefined): Injection {
  return { ...NO_INJECTION, ...recorded };
}

export function sameInjection(a: Partial<Injection> | undefined, b: Partial<Injection> | undefined): boolean {
  const x = injectionOf(a),
    y = injectionOf(b);
  return (Object.keys(NO_INJECTION) as (keyof Injection)[]).every((key) => x[key] === y[key]);
}

export function isInjected(injection: Partial<Injection> | undefined): boolean {
  return !sameInjection(injection, NO_INJECTION);
}

/** `--latency-ms`, `--hung-connector`, `--unauthorized-connector`, `--d1-latency-ms`. */
export function parseInjection(args: Map<string, string>): Injection {
  const ms = (flag: string) => {
    if (!args.has(flag)) return 0;
    const value = Number(args.get(flag));
    if (!Number.isInteger(value) || value < 0 || value > 60_000)
      throw new Error(`--${flag} must be an integer from 0 to 60000`);
    return value;
  };
  const toggle = (flag: string) => {
    if (!args.has(flag)) return false;
    const value = args.get(flag);
    if (value !== "true" && value !== "") throw new Error(`--${flag} takes no value`);
    return true;
  };
  return {
    latencyMs: ms("latency-ms"),
    hungConnector: toggle("hung-connector"),
    unauthorizedConnector: toggle("unauthorized-connector"),
    d1LatencyMs: ms("d1-latency-ms"),
  };
}

export function describeInjection(injection: Injection): string {
  if (!isInjected(injection)) return "no injection";
  return [
    injection.latencyMs ? `downstream latency ${injection.latencyMs} ms` : "",
    injection.hungConnector ? `hung connector ${HUNG_CONNECTOR}` : "",
    injection.unauthorizedConnector ? `401 connector ${UNAUTHORIZED_CONNECTOR}` : "",
    injection.d1LatencyMs ? `D1 latency ${injection.d1LatencyMs} ms` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** The injected connectors' servers, owned by one world. */
export class InjectedConnectors {
  private hung?: Served;
  private revoked?: Served;
  constructor(private readonly injection: Injection) {}

  async start(): Promise<void> {
    if (this.injection.hungConnector) this.hung = await serveFetch(() => new Promise<Response>(() => {}));
    if (this.injection.unauthorizedConnector)
      this.revoked = await serveFetch(async (request) => {
        await request.body?.cancel();
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
        });
      });
  }

  async stop(): Promise<void> {
    await Promise.all([this.hung?.close(), this.revoked?.close()]);
  }

  specs(): ConnectorSpec[] {
    return [
      ...(this.hung
        ? [
            {
              id: HUNG_CONNECTOR,
              title: "Stalled service",
              description: "A downstream that accepts requests and never answers",
              url: `${this.hung.url}/mcp`,
            },
          ]
        : []),
      ...(this.revoked
        ? [
            {
              id: UNAUTHORIZED_CONNECTOR,
              title: "Revoked service",
              description: "A downstream that rejects the saved credential",
              url: `${this.revoked.url}/mcp`,
              credential: { label: "API token", value: REVOKED_CREDENTIAL },
            },
          ]
        : []),
    ];
  }

  ids(): string[] {
    return this.specs().map((spec) => spec.id);
  }
}
