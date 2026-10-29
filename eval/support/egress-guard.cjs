// Preloaded into wrangler's Node processes by eval/support/workerd.ts
// (NODE_OPTIONS --require). Eval runs are hermetic: any TCP or TLS connect to
// a non-loopback host is destroyed with an error before DNS or a socket opens,
// so an update check, telemetry or registry fetch fails closed instead of
// reaching the network. Loopback and local (Unix socket) connections pass.
"use strict";
const net = require("node:net");

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3}|0\.0\.0\.0|::)$/i;

function target(args) {
  let first = args[0];
  // net.connect() passes its normalized [options, callback] array.
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") return { path: first.path, host: first.host, port: first.port };
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
  return { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const { path, host, port } = target(args);
  const name = String(host ?? "localhost").replace(/^\[|\]$/g, "");
  if (path === undefined && !LOOPBACK.test(name)) {
    const error = Object.assign(new Error(`Eval egress guard refused ${name}:${port}: eval runs are hermetic.`), {
      code: "EVAL_EGRESS_REFUSED",
    });
    process.stderr.write(`[eval egress] refused ${name}:${port}\n`);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return connect.apply(this, args);
};
