/**
 * The agent-eval deployment on workerd: `eval/deploy/worker-agent.ts` under
 * `wrangler dev`, one process per trial, plus the Node-side vendor gateway
 * that workerd's non-loopback requests reach the fake vendors through.
 *
 * The gateway dispatches through `globalThis.fetch` with the fake transport
 * held installed, so the Worker gets exactly the Node deployment's
 * credential routing and fail-closed refusals, and never the real network.
 * It forwards with `redirect: "manual"`; the Worker sends every followed hop
 * back through the gateway.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { ALICE } from "../fakes/google.js";
import { ACCOUNT_A, SHOP_ZONE } from "../fakes/rest.js";
import { holdFakeRouting } from "../fakes/transport.js";
import type { ConnectorSpec } from "../fakes/world.js";
import { ROOT } from "../support/meta.js";
import { serveFetch } from "../support/serve.js";
import { wranglerDev } from "../support/workerd.js";
import { evalMcpPath, type EvalComposition } from "./compose.js";
import { GATEWAY_ERROR_HEADER, GATEWAY_TOKEN_HEADER, VENDOR_URL_HEADER } from "./gateway-fetch.js";
import type { Deployment } from "./node.js";
import type { ProgramObservation } from "./observe.js";

const HOP_BY_HOP = ["host", "connection", "content-length", "transfer-encoding", "keep-alive"];
const LOOPBACK =
  /^(localhost|\[::1?\]|\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|127(\.\d{1,3}){3})\]|127(\.\d{1,3}){3}|0\.0\.0\.0)$/i;

/**
 * The Node side of the vendor gateway. Only the trial's own Worker holds
 * `token`; any other local process is refused before dispatch. The token and
 * gateway headers are stripped before forwarding. Loopback and non-HTTP(S)
 * targets are refused: the Worker fetches loopback fakes directly, so the
 * gateway is never a path to a local service.
 */
export async function startVendorGateway(token = randomBytes(32).toString("base64url")) {
  const release = holdFakeRouting();
  const expected = Buffer.from(token);
  const refuse = (status: number, message: string) =>
    new Response(message, { status, headers: { [GATEWAY_ERROR_HEADER]: "1" } });
  try {
    const served = await serveFetch(async (request) => {
      const presented = Buffer.from(request.headers.get(GATEWAY_TOKEN_HEADER) ?? "");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        await request.body?.cancel();
        return refuse(403, "Eval vendor gateway refused a request without this trial's credential.");
      }
      const target = request.headers.get(VENDOR_URL_HEADER);
      let url: URL;
      try {
        url = new URL(target ?? "");
      } catch {
        return refuse(400, "Eval vendor gateway needs an absolute vendor URL.");
      }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || LOOPBACK.test(url.hostname))
        return refuse(403, `Eval vendor gateway refused ${url.protocol}//${url.hostname}: not a vendor origin.`);
      const headers = new Headers(request.headers);
      for (const name of [...HOP_BY_HOP, GATEWAY_TOKEN_HEADER, VENDOR_URL_HEADER]) headers.delete(name);
      try {
        const response = await globalThis.fetch(url, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
          redirect: "manual",
        });
        const out = new Headers(response.headers);
        // Node's fetch already decoded the body.
        for (const name of ["content-encoding", "content-length", "transfer-encoding"]) out.delete(name);
        const empty = request.method === "HEAD" || [101, 204, 205, 304].includes(response.status);
        return new Response(empty ? null : await response.arrayBuffer(), {
          status: response.status,
          statusText: response.statusText,
          headers: out,
        });
      } catch (error) {
        return refuse(502, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
    });
    return {
      url: served.url,
      token,
      close: async () => {
        try {
          await served.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

export async function startWorkerDeployment(
  connectors: ConnectorSpec[],
  extra: Record<string, unknown> = {},
  everyPool: string[] = [],
): Promise<Deployment> {
  const gateway = await startVendorGateway();
  let dev: Awaited<ReturnType<typeof wranglerDev>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await dev?.close();
    } finally {
      await gateway.close();
    }
  };
  try {
    const composition: EvalComposition = {
      connectors,
      extra,
      fixtures: { alice: ALICE, accountA: ACCOUNT_A, shopZone: SHOP_ZONE },
      readOnly: false,
      everyPool,
    };
    dev = await wranglerDev({
      name: "connecta-eval-agent",
      main: join(ROOT, "eval", "deploy", "worker-agent.ts"),
      vars: {
        CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        EVAL_COMPOSITION: JSON.stringify(composition),
        EVAL_GATEWAY: gateway.url,
        EVAL_GATEWAY_TOKEN: gateway.token,
      },
      publicUrlVar: true,
    });
    const origin = dev.origin;
    const control = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${origin}/__eval/${path}`, init);
      if (!response.ok) throw new Error(`Eval worker ${path} failed: HTTP ${response.status} ${await response.text()}`);
      return response;
    };
    const { token } = (await (await control("token")).json()) as { token: string };
    let programs: ProgramObservation[] = [];
    return {
      kind: "worker-agent",
      origin,
      mcpUrl: `${origin}${evalMcpPath(extra, false)}`,
      token,
      get programs() {
        return programs;
      },
      observe: async () => (programs = (await (await control("programs")).json()) as ProgramObservation[]),
      openConnect: async () => {
        throw new Error("The worker target has no fake OAuth connection page.");
      },
      setCredential: async (connector, value) => {
        await control("credential", { method: "POST", body: JSON.stringify({ connector, value }) });
      },
      restart: async (readOnly?: boolean) => {
        await control(`restart${readOnly === undefined ? "" : `?readOnly=${readOnly}`}`, { method: "POST" });
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
