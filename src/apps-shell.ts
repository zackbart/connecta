/**
 * The one MCP Apps template connecta serves (`U5`, `U6`).
 *
 * A build-time string constant, not a file read at startup: the core is
 * Web-API-only so it runs unchanged on Workers, and the same bytes have to
 * serve everywhere. The shell is display-only — it renders whatever HTML a
 * program handed `connecta.ui` inside a nested `srcdoc` frame and forwards no
 * channel back from that frame to the host, so program-authored markup is
 * inert beyond its own pixels.
 *
 * The address carries a version segment because hosts are permitted to
 * prefetch and cache templates by URI: change these bytes, bump `v1`.
 */

/** The only `ui://` URI in the system. No program input reaches it. */
export const PROGRAM_UI_RESOURCE_URI = "ui://connecta/program-ui/v1";

/** The mimeType the Apps spec requires of an HTML template. */
export const PROGRAM_UI_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The result `_meta` key carrying the payload (`U3`). A plain single-label
 * prefix rather than the reverse-DNS form MCP's SHOULD prefers: connecta has
 * no domain to reverse, and fabricating one to satisfy a SHOULD is a worse
 * answer than the shape the key format's MUST already permits.
 */
export const PROGRAM_UI_META_KEY = "connecta/ui";

/** The one extension identifier connecta advertises (`U11`). */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

/**
 * The shell document. Dependency-free and deliberately small: it speaks the
 * Apps postMessage dialect (`ui/initialize`, `ui/notifications/initialized`,
 * `ui/notifications/tool-result`, `ui/notifications/size-changed`,
 * `ui/resource-teardown`), lifts `_meta["connecta/ui"].html` out of the
 * delivered tool result, and puts it in a frame. It declares no CSP domains,
 * so the host applies its restrictive default and the `srcdoc` frame inherits
 * `default-src 'none'` — the payload gets scripts and local interactivity,
 * and no network.
 */
export const PROGRAM_UI_SHELL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>connecta program view</title>
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        background: transparent;
      }
      #program-view {
        display: block;
        width: 100%;
        min-height: 480px;
        border: 0;
      }
    </style>
  </head>
  <body>
    <iframe
      id="program-view"
      title="Program-rendered view"
      sandbox="allow-scripts"
      srcdoc=""
    ></iframe>
    <script>
      (function () {
        "use strict";
        // The host frame is the only peer this shell speaks to, in either
        // direction. The payload frame below is sandboxed to scripts alone,
        // with no same-origin escape, and is never handed a reply path:
        // anything it posts fails the source check and is dropped. There is
        // no bridge from program HTML to the host, by construction rather
        // than by validation.
        var host = window.parent;
        var view = document.getElementById("program-view");
        var initializeId = "connecta-ui-initialize";
        var lastWidth = 0;
        var lastHeight = 0;

        function send(message) {
          if (!host || host === window) return;
          host.postMessage(message, "*");
        }

        function notify(method, params) {
          send({ jsonrpc: "2.0", method: method, params: params });
        }

        // Program views are fixed-height by construction. The shell has no
        // bridge to the payload frame — that is the security posture, not an
        // omission — so it can never learn the payload's content height, and
        // what it reports here is its own box: the min-height above, unless
        // the host has given it more. Taller content scrolls inside the inner
        // frame rather than growing the view. Raising the min-height is the
        // only lever; a content-height signal would cost the isolation.
        function reportSize() {
          var width = Math.ceil(document.documentElement.clientWidth);
          var height = Math.ceil(document.documentElement.scrollHeight);
          if (width === lastWidth && height === lastHeight) return;
          lastWidth = width;
          lastHeight = height;
          notify("ui/notifications/size-changed", {
            width: width,
            height: height
          });
        }

        function payloadHtml(result) {
          if (!result || typeof result !== "object") return null;
          var meta = result._meta;
          if (!meta || typeof meta !== "object") return null;
          var payload = meta["connecta/ui"];
          if (!payload || typeof payload !== "object") return null;
          var html = payload.html;
          return typeof html === "string" && html.length > 0 ? html : null;
        }

        function render(params) {
          var html =
            payloadHtml(params) ||
            payloadHtml(params && params.result) ||
            payloadHtml(params && params.toolResult);
          if (html === null) return;
          view.srcdoc = html;
          reportSize();
        }

        window.addEventListener("message", function (event) {
          if (event.source !== host) return;
          var message = event.data;
          if (!message || message.jsonrpc !== "2.0") return;
          if (message.method === "ui/notifications/tool-result") {
            render(message.params);
            return;
          }
          if (message.method === "ui/resource-teardown") {
            // A host->view request, not a notification: the host waits for
            // this reply before it tears the view down. There is nothing to
            // release, so answer immediately rather than make it time out.
            if (message.id !== undefined && message.id !== null) {
              send({ jsonrpc: "2.0", id: message.id, result: {} });
            }
            return;
          }
          // Only a completed handshake earns "initialized". A JSON-RPC error
          // response carries the same id, and announcing initialization on one
          // would assert a handshake that never happened.
          if (message.id === initializeId && message.result !== undefined) {
            notify("ui/notifications/initialized", {});
          }
        });

        window.addEventListener("resize", reportSize);
        view.addEventListener("load", reportSize);

        // Every field here is required by the Apps initialize schema, and a
        // conforming host rejects the request outright when one is missing —
        // which would strand the shell before any tool result arrives.
        send({
          jsonrpc: "2.0",
          id: initializeId,
          method: "ui/initialize",
          params: {
            appInfo: { name: "connecta program view", version: "1" },
            appCapabilities: {},
            protocolVersion: "2026-01-26"
          }
        });
        reportSize();
      })();
    </script>
  </body>
</html>
`;
