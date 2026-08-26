import { expect, test, type Page } from "@playwright/test";
import {
  PROGRAM_UI_META_KEY,
  PROGRAM_UI_SHELL_HTML,
} from "../../src/apps-shell.js";

async function mountProgramView(page: Page, html: string) {
  await page.setContent("<!doctype html><body></body>");
  await page.evaluate(
    ({ shell, key, payload }) => {
      const browser = globalThis as unknown as {
        document: {
          body: { append(node: unknown): void };
          createElement(name: "iframe"): {
            contentWindow: {
              postMessage(message: unknown, target: string): void;
            } | null;
            setAttribute(name: string, value: string): void;
            srcdoc: string;
          };
        };
        hostToolCalls: unknown[];
        addEventListener(
          name: "message",
          listener: (event: { source: unknown; data: unknown }) => void,
        ): void;
      };
      const outer = browser.document.createElement("iframe");
      outer.setAttribute("sandbox", "allow-scripts");
      outer.srcdoc = shell;
      browser.document.body.append(outer);
      browser.hostToolCalls = [];

      browser.addEventListener("message", (event) => {
        if (event.source !== outer.contentWindow) return;
        const message = event.data as { id?: string; method?: string };
        if (message.method === "ui/initialize") {
          outer.contentWindow?.postMessage(
            { jsonrpc: "2.0", id: message.id, result: {} },
            "*",
          );
          return;
        }
        if (message.method === "ui/notifications/initialized") {
          outer.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: { _meta: { [key]: { html: payload } } },
            },
            "*",
          );
          return;
        }
        if (message.method === "tools/call") {
          browser.hostToolCalls.push(message);
        }
      });
    },
    {
      shell: PROGRAM_UI_SHELL_HTML,
      key: PROGRAM_UI_META_KEY,
      payload: html,
    },
  );
}

test("the display-only shell runs local code and forwards no host calls", async ({
  page,
}) => {
  const html = `<!doctype html><body><script>
    document.body.textContent = JSON.stringify({
      connecta: typeof connecta,
      localResult: [3, 1, 2].sort().join("")
    });
    window.parent.postMessage({
      jsonrpc: "2.0",
      id: "forged-call",
      method: "tools/call",
      params: { name: "call_tool", arguments: {} }
    }, "*");
    window.parent.postMessage({
      type: "connecta/read",
      id: "forged-read",
      name: "anything",
      args: {}
    }, "*");
  </script></body>`;
  await mountProgramView(page, html);

  const body = page.frameLocator("iframe").frameLocator("iframe").locator("body");
  await expect(body).toContainText('"connecta":"undefined"');
  await expect(body).toContainText('"localResult":"123"');
  expect(await page.evaluate(
    () => (globalThis as unknown as { hostToolCalls: unknown[] }).hostToolCalls,
  )).toEqual([]);
});
