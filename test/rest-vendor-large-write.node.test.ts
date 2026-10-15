// Node-only: exercises raised maxBodyBytes over TCP with Cloudflare KV's large base64 values.
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { Connecta } from "../src/index.js";
import { listen } from "../src/node.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import { connectorContext } from "./fixtures/misc.js";

afterEach(() => vi.restoreAllMocks());

it("INV-5: admits KV base64 values through a raised host body cap up to 25 MiB and refuses end placeholders before dispatch", async () => {
  const connector = cloudflare("test", { purpose: "Large KV admission regression", auth: { type: "apiToken" } });
  const ctx = {
    ...connectorContext(),
    credential: { get: async () => "test-token", getAll: async () => ({ value: "test-token" }) },
  };
  const dispatch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ success: true, result: {} }));
  // Exercise the real inbound adapter and provider admission, with the vendor
  // response mocked. The forwarding fixture isolates request-size behavior
  // from MCP result handling and needs no downstream credentials or network.
  const connecta = {
    async fetch(request: Request) {
      try {
        await connector.callTool("cloudflare_api_write", await request.json(), ctx);
        return Response.json({ ok: true });
      } catch (error) {
        const failure = error as { code: string; message: string };
        return Response.json({ code: failure.code, message: failure.message }, { status: 400 });
      }
    },
  } as unknown as Connecta;
  const server = listen(connecta, {
    port: 0,
    host: "127.0.0.1",
    maxBodyBytes: 40 * 1024 * 1024,
    gracefulShutdown: false,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address.");

  const send = (value: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port: address.port, method: "POST", headers: { "Content-Type": "application/json" } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => resolve({ status: response.statusCode!, body }));
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end(
        JSON.stringify({
          method: "PUT",
          path: `/accounts/${"a".repeat(32)}/storage/kv/namespaces/ns/bulk`,
          body: [{ key: "review", value, base64: true }],
        }),
      );
    });

  try {
    for (const size of [8 * 1024 * 1024 + 1, 24 * 1024 * 1024, 25 * 1024 * 1024]) {
      const value = Buffer.alloc(size, 0x61).toString("base64");
      dispatch.mockClear();
      expect(await send(value)).toEqual({ status: 200, body: '{"ok":true}' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(String(dispatch.mock.calls[0]![1]!.body));
      expect(sent[0].value).toBe(value);
    }
    for (const marker of ["https://f.test/?[redacted]", "https://f.test/?%5Bredacted%5D"]) {
      const bytes = Buffer.alloc(25 * 1024 * 1024, 0x61);
      bytes.write(` ${marker}`, bytes.length - marker.length - 1);
      dispatch.mockClear();
      const result = await send(bytes.toString("base64"));
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("withheld"),
      });
      expect(dispatch).not.toHaveBeenCalled();
    }
    dispatch.mockClear();
    const result = await send(Buffer.alloc(25 * 1024 * 1024 + 1, 0x61).toString("base64"));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("26214400 bytes"),
    });
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}, 30_000);
