// Native separate Worker requests and real TCP fetch, with no fetch mock.
import { describe, expect, inject, it, vi } from "vitest";

const worker = await (async () => {
  try {
    const module = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ module)) as { env: { AUTH_ADMISSION?: Fetcher } };
    return env.AUTH_ADMISSION;
  } catch {
    return undefined;
  }
})();
const origin = worker ? inject("authAdmissionServer") : "";
async function status(): Promise<{ calls: number; ids: string[] }> {
  return (await fetch(`${origin}/status`)).json();
}
async function release() {
  await (await fetch(`${origin}/release`)).text();
}
function start(id: string, signal?: AbortSignal) {
  return worker!.fetch("https://connecta.test/mcp", {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: { "Mcp-Method": "subscriptions/listen", "X-Auth-Upstream": `${origin}/${id}` },
  });
}
async function busy(id: string) {
  const response = await start(id);
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({ error: { code: "authentication_busy" } });
}

describe.skipIf(!worker)("native authentication admission", () => {
  it("INV-7: separate workerd requests cap auth, release after disconnect, and never share another request's I/O", async () => {
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const pending = controllers.map((controller, i) => start(`first-${i}`, controller.signal).catch(() => undefined));
    let replacement: ReturnType<typeof start> | undefined;
    let recovered: ReturnType<typeof start>[] = [];
    try {
      await vi.waitFor(async () => expect((await status()).ids).toHaveLength(16), { timeout: 10_000 });
      await busy("over");
      expect((await status()).calls).toBe(16);
      controllers[0]!.abort();
      await vi.waitFor(async () => expect((await status()).ids).not.toContain("/first-0"), { timeout: 10_000 });
      replacement = start("replacement");
      await vi.waitFor(async () => expect((await status()).ids).toContain("/replacement"), { timeout: 10_000 });
      expect((await status()).ids).toHaveLength(16);
      await busy("still-full");
      await release();
      for (const res of await Promise.all(pending)) await res?.text();
      await (await replacement).text();
      replacement = undefined;
      await vi.waitFor(async () => expect((await status()).ids).toHaveLength(0));
      recovered = Array.from({ length: 16 }, (_, i) => start(`recovered-${i}`));
      await vi.waitFor(async () => expect((await status()).ids).toHaveLength(16), { timeout: 10_000 });
      await busy("recovered-full");
      expect((await status()).calls).toBe(33);
    } finally {
      controllers.forEach((controller) => controller.abort());
      await release();
      for (const res of await Promise.all(recovered)) await res.text();
      await Promise.all(pending);
      if (replacement) await (await replacement).text();
    }
  }, 30_000);
});
