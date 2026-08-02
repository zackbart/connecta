import { expect, test, type Page } from "@playwright/test";
import {
  PROGRAM_UI_META_KEY,
  PROGRAM_UI_SHELL_HTML,
} from "../../src/apps-shell.js";

interface ReadBinding {
  address: string;
  fixedArgs: Record<string, unknown>;
  viewArgs: string[];
}

async function mountProgramView(
  page: Page,
  html: string,
  reads?: Record<string, ReadBinding>,
) {
  await page.setContent("<!doctype html><body></body>");
  await page.evaluate(
    ({ shell, key, payload }) => {
      const browser = globalThis as unknown as {
        document: {
          body: { append(node: unknown): void };
          createElement(name: "iframe"): {
            contentWindow: { postMessage(message: unknown, target: string): void } | null;
            setAttribute(name: string, value: string): void;
            srcdoc: string;
          };
        };
        calls: unknown[];
        addEventListener(
          name: "message",
          listener: (event: { source: unknown; data: unknown }) => void,
        ): void;
      };
      const outer = browser.document.createElement("iframe");
      outer.setAttribute("sandbox", "allow-scripts");
      outer.srcdoc = shell;
      browser.document.body.append(outer);
      browser.calls = [];

      browser.addEventListener("message", (event) => {
        if (event.source !== outer.contentWindow) return;
        const message = event.data as {
          id?: string;
          method?: string;
          params?: {
            name?: string;
            arguments?: { address?: string; args?: Record<string, unknown> };
          };
        };
        if (message.method === "ui/initialize") {
          outer.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: { hostCapabilities: { serverTools: {} } },
            },
            "*",
          );
          return;
        }
        if (message.method === "ui/notifications/initialized") {
          outer.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: { _meta: { [key]: payload } },
            },
            "*",
          );
          return;
        }
        if (message.method !== "tools/call") return;
        browser.calls.push(message.params);
        const args = message.params?.arguments?.args ?? {};
        if (args.b === 99) {
          outer.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "host refused this read" },
            },
            "*",
          );
          return;
        }
        const a = Number(args.a ?? 0);
        const b = Number(args.b ?? 0);
        // Different delays prove correlation rather than response ordering.
        setTimeout(() => {
          outer.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ sum: a + b }) }],
                structuredContent: { ok: true, data: { sum: a + b } },
              },
            },
            "*",
          );
        }, b === 2 ? 20 : 0);
      });
    },
    {
      shell: PROGRAM_UI_SHELL_HTML,
      key: PROGRAM_UI_META_KEY,
      payload: { html, ...(reads ? { reads } : {}) },
    },
  );
}

test("a bound view merges fixed and declared arguments and correlates concurrent reads", async ({
  page,
}) => {
  const html = `<!doctype html><html><head><title>bound payload</title></head><body>
    <script>
      (async function () {
        var concurrent = await Promise.all([
          connecta.read("refresh", { b: 2 }),
          connecta.read("refresh", { b: 3 })
        ]);
        var unknown;
        var undeclared;
        var hostError;
        try { await connecta.read("invented", {}); } catch (error) { unknown = error.message; }
        try { await connecta.read("refresh", { c: 4 }); } catch (error) { undeclared = error.message; }
        try { await connecta.read("failure", {}); } catch (error) { hostError = error.message; }
        document.body.textContent = JSON.stringify({ concurrent, unknown, undeclared, hostError });
      })();
    </script>
  </body></html>`;
  await mountProgramView(page, html, {
    refresh: {
      address: "calc.add",
      fixedArgs: { a: 1 },
      viewArgs: ["b"],
    },
    failure: {
      address: "calc.add",
      fixedArgs: { a: 1, b: 99 },
      viewArgs: [],
    },
  });

  const body = page.frameLocator("iframe").frameLocator("iframe").locator("body");
  await expect(body).toContainText('"sum":3');
  const outcome = JSON.parse(await body.textContent() ?? "{}") as {
    concurrent: unknown[];
    unknown: string;
    undeclared: string;
    hostError: string;
  };
  expect(outcome.concurrent).toEqual([{ sum: 3 }, { sum: 4 }]);
  expect(outcome.unknown).toBe("Unknown read binding");
  expect(outcome.undeclared).toBe('Undeclared read argument "c"');
  expect(outcome.hostError).toBe("host refused this read");

  const calls = await page.evaluate(
    () => (globalThis as unknown as { calls: unknown[] }).calls,
  ) as Array<{
    name: string;
    arguments: { address: string; args: Record<string, unknown>; resultMode: string };
  }>;
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.name === "call_tool")).toBe(true);
  expect(calls.map((call) => call.arguments)).toEqual([
    { address: "calc.add", args: { a: 1, b: 2 }, resultMode: "value" },
    { address: "calc.add", args: { a: 1, b: 3 }, resultMode: "value" },
    { address: "calc.add", args: { a: 1, b: 99 }, resultMode: "value" },
  ]);
});

test("the one-string payload receives no read bridge", async ({ page }) => {
  await mountProgramView(
    page,
    '<!doctype html><body><script>document.body.textContent = typeof connecta;</script></body>',
  );
  const body = page.frameLocator("iframe").frameLocator("iframe").locator("body");
  await expect(body).toHaveText("undefined");
  expect(await page.evaluate(
    () => (globalThis as unknown as { calls: unknown[] }).calls,
  )).toEqual([]);
});
