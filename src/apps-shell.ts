/**
 * The one MCP Apps template connecta serves (`U5`, `U6`).
 *
 * A build-time string constant, not a file read at startup: the core is
 * Web-API-only so it runs unchanged on Workers, and the same bytes have to
 * serve everywhere. It renders whatever HTML a program handed `connecta.ui`
 * inside a nested `srcdoc` frame. The one-argument form forwards no channel;
 * an explicitly bound view gets only named read calls through the trusted
 * shell, never a raw host channel.
 *
 * The address carries a version segment because hosts are permitted to
 * prefetch and cache templates by URI: change these bytes, bump the version.
 */

/** The only `ui://` URI in the system. No program input reaches it. */
export const PROGRAM_UI_RESOURCE_URI = "ui://connecta/program-ui/v2";

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
 * delivered tool result, and puts it in a frame. An optional read manifest
 * installs one narrow `connecta.read(name, args)` bridge in that inner frame;
 * the outer shell maps declared names to the existing `call_tool` meta-tool.
 * It declares no CSP domains, so the host applies its restrictive default and
 * the `srcdoc` frame inherits `default-src 'none'` — program markup still gets
 * no direct network.
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
        // The outer shell is the only host peer. The payload frame is
        // sandboxed to scripts alone, with no same-origin escape. Its one
        // optional message dialect is handled below and translated into
        // bounded call_tool requests; raw JSON-RPC is never forwarded.
        var host = window.parent;
        var view = document.getElementById("program-view");
        var initializeId = "connecta-ui-initialize";
        var lastWidth = 0;
        var lastHeight = 0;
        var reads = null;
        var hostCanCallTools = false;
        var nextHostRequestId = 0;
        var pendingHostReads = Object.create(null);
        var activeHostReads = 0;
        var maxActiveHostReads = 8;

        function send(message) {
          if (!host || host === window) return;
          host.postMessage(message, "*");
        }

        function notify(method, params) {
          send({ jsonrpc: "2.0", method: method, params: params });
        }

        // Program views are fixed-height by construction. The shell has no
        // content-height bridge to the payload frame, so it can never learn
        // the payload's content height, and
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

        function payload(result) {
          if (!result || typeof result !== "object") return null;
          var meta = result._meta;
          if (!meta || typeof meta !== "object") return null;
          var value = meta["connecta/ui"];
          if (!value || typeof value !== "object") return null;
          return typeof value.html === "string" && value.html.length > 0
            ? value
            : null;
        }

        // This function is serialized into the opaque-origin payload frame.
        // It knows no addresses and has no host channel of its own: one named
        // read request goes to the trusted outer shell and one correlated
        // result comes back.
        function payloadReadBridge() {
          "use strict";
          var pending = Object.create(null);
          var nextId = 0;

          function read(name, args) {
            return new Promise(function (resolve, reject) {
              var id = String(++nextId);
              pending[id] = { resolve: resolve, reject: reject };
              try {
                window.parent.postMessage({
                  type: "connecta/read",
                  id: id,
                  name: name,
                  args: args === undefined ? {} : args
                }, "*");
              } catch (error) {
                delete pending[id];
                reject(error);
              }
            });
          }

          Object.defineProperty(globalThis, "connecta", {
            value: Object.freeze({ read: read }),
            configurable: false,
            enumerable: true,
            writable: false
          });

          window.addEventListener("message", function (event) {
            if (event.source !== window.parent) return;
            var message = event.data;
            if (!message || message.type !== "connecta/read-result") return;
            var waiter = pending[message.id];
            if (!waiter) return;
            delete pending[message.id];
            if (message.ok) waiter.resolve(message.value);
            else waiter.reject(new Error(message.error || "Read failed"));
          });
        }

        function htmlWithReadBridge(html) {
          var script =
            "<scr" + "ipt>(" + payloadReadBridge.toString() + ")();</scr" + "ipt>";
          var head = /<head(?:\\s[^>]*)?>/i.exec(html);
          if (head) {
            var at = (head.index || 0) + head[0].length;
            return html.slice(0, at) + script + html.slice(at);
          }
          var document = /<html(?:\\s[^>]*)?>/i.exec(html);
          if (document) {
            var afterHtml = (document.index || 0) + document[0].length;
            return html.slice(0, afterHtml) + "<head>" + script + "</head>" + html.slice(afterHtml);
          }
          return script + html;
        }

        function render(params) {
          var value =
            payload(params) ||
            payload(params && params.result) ||
            payload(params && params.toolResult);
          if (value === null) return;
          reads = value.reads && typeof value.reads === "object"
            ? value.reads
            : null;
          view.srcdoc = reads
            ? htmlWithReadBridge(value.html)
            : value.html;
          reportSize();
        }

        function readError(message, fallback) {
          if (message && typeof message.message === "string") return message.message;
          if (message && message.data && typeof message.data.message === "string") {
            return message.data.message;
          }
          return fallback;
        }

        function finishInnerRead(innerId, ok, value) {
          if (!view.contentWindow) return;
          view.contentWindow.postMessage(ok
            ? { type: "connecta/read-result", id: innerId, ok: true, value: value }
            : { type: "connecta/read-result", id: innerId, ok: false, error: value }, "*");
        }

        function beginInnerRead(message) {
          if (!hostCanCallTools) {
            finishInnerRead(message && message.id, false, "This host does not support app-initiated server tool calls");
            return;
          }
          if (!message || typeof message.id !== "string" || typeof message.name !== "string") return;
          if (!reads || !Object.prototype.hasOwnProperty.call(reads, message.name)) {
            finishInnerRead(message.id, false, "Unknown read binding");
            return;
          }
          if (activeHostReads >= maxActiveHostReads) {
            finishInnerRead(message.id, false, "Too many concurrent reads");
            return;
          }
          var binding = reads[message.name];
          if (!binding || typeof binding !== "object" || typeof binding.address !== "string") {
            finishInnerRead(message.id, false, "Invalid read binding");
            return;
          }
          var supplied = message.args;
          if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
            finishInnerRead(message.id, false, "Read arguments must be an object");
            return;
          }
          var allowed = Array.isArray(binding.viewArgs) ? binding.viewArgs : [];
          var suppliedKeys = Object.keys(supplied);
          for (var i = 0; i < suppliedKeys.length; i++) {
            var key = suppliedKeys[i];
            if (allowed.indexOf(key) === -1) {
              finishInnerRead(message.id, false, "Undeclared read argument " + JSON.stringify(key));
              return;
            }
          }
          var args = Object.create(null);
          var fixed = binding.fixedArgs && typeof binding.fixedArgs === "object"
            ? binding.fixedArgs
            : {};
          Object.keys(fixed).forEach(function (key) { args[key] = fixed[key]; });
          suppliedKeys.forEach(function (key) { args[key] = supplied[key]; });

          var hostId = "connecta-ui-read-" + String(++nextHostRequestId);
          pendingHostReads[hostId] = { innerId: message.id };
          activeHostReads++;
          send({
            jsonrpc: "2.0",
            id: hostId,
            method: "tools/call",
            params: {
              name: "call_tool",
              arguments: {
                address: binding.address,
                args: args,
                resultMode: "value"
              }
            }
          });
        }

        function finishHostRead(message) {
          var pending = pendingHostReads[message.id];
          if (!pending) return false;
          delete pendingHostReads[message.id];
          activeHostReads--;
          if (message.error) {
            finishInnerRead(pending.innerId, false, readError(message.error, "Host rejected read"));
            return true;
          }
          var toolResult = message.result;
          if (!toolResult || typeof toolResult !== "object") {
            finishInnerRead(pending.innerId, false, "Host returned an invalid tool result");
            return true;
          }
          var structured = toolResult.structuredContent;
          if (toolResult.isError || (structured && structured.ok === false)) {
            var detail = structured && structured.error;
            var content = Array.isArray(toolResult.content)
              ? toolResult.content.find(function (block) { return block && block.type === "text"; })
              : null;
            finishInnerRead(
              pending.innerId,
              false,
              readError(detail, content && content.text ? content.text : "Read failed")
            );
            return true;
          }
          var value = structured && structured.ok === true &&
              Object.prototype.hasOwnProperty.call(structured, "data")
            ? structured.data
            : structured !== undefined
              ? structured
              : toolResult;
          finishInnerRead(pending.innerId, true, value);
          return true;
        }

        window.addEventListener("message", function (event) {
          var message = event.data;
          if (event.source === view.contentWindow) {
            if (message && message.type === "connecta/read") beginInnerRead(message);
            return;
          }
          if (event.source !== host) return;
          if (!message || message.jsonrpc !== "2.0") return;
          if (message.id !== undefined && finishHostRead(message)) return;
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
            var capabilities = message.result.hostCapabilities;
            hostCanCallTools = Boolean(capabilities && capabilities.serverTools);
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
