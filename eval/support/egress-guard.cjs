// Preloaded into wrangler's Node processes by eval/support/workerd.ts
// (NODE_OPTIONS --require). Eval runs are hermetic, so this refuses, before any
// packet leaves the process:
// - TCP connects to a non-loopback host, and HTTP/2 sessions to one. Every net/tls/http/http2/undici
//   connect reaches net.Socket.prototype.connect, including an existing
//   Socket's connect(). Only a non-empty string `path` is a local socket;
//   anything else (undefined, null, "") is TCP and its host is checked.
// - DNS: every dns and dns.promises lookup, resolve*, reverse and
//   lookupService for a non-loopback name, and every Resolver query.
// - UDP: dgram send and connect to a non-loopback address.
// Loopback and Unix-socket traffic pass. This guards Node code only: native
// children such as workerd are not covered (see eval/README.md).
"use strict";
const net = require("node:net");
const dns = require("node:dns");
const dgram = require("node:dgram");
const http2 = require("node:http2");

const CODE = "EVAL_EGRESS_REFUSED";
const LOOPBACK =
  /^(localhost|127(\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1|::ffff:127(\.\d{1,3}){3}|::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0\.0\.0\.0|::)$/i;
const loopback = (host) => LOOPBACK.test(String(host).replace(/^\[|\]$/g, ""));

function refusal(what) {
  process.stderr.write(`[eval egress] refused ${what}\n`);
  return Object.assign(new Error(`Eval egress guard refused ${what}: eval runs are hermetic.`), { code: CODE });
}

/** The TCP target of any Socket#connect overload, or undefined for a local socket path. */
function tcpTarget(args) {
  let first = args[0];
  // net.connect() passes its normalized [options, callback] array.
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string" && first.path !== "") return undefined;
    return { host: first.host ?? first.hostname ?? "localhost", port: first.port };
  }
  if (typeof first === "string" && first !== "" && !/^\d+$/.test(first)) return undefined;
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = tcpTarget(args);
  if (target && !loopback(target.host)) {
    const error = refusal(`TCP ${target.host}:${target.port}`);
    // Still "connecting" until destroyed, so no client (http2 among them)
    // mistakes the refused socket for an open one.
    this.connecting = true;
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return connect.apply(this, args);
};

// http2 wraps a socket without a handle (a refused one) in a JS stream that
// reports itself connected, so refuse a non-loopback authority up front. A
// caller-supplied createConnection still connects through the guard above.
const h2connect = http2.connect;
http2.connect = function guardedHttp2Connect(authority, options, ...rest) {
  if (typeof options?.createConnection !== "function") {
    const url = typeof authority === "string" ? new URL(authority) : authority;
    const host = url?.hostname || url?.host || "localhost";
    if (!loopback(host)) throw refusal(`HTTP/2 ${host}`);
  }
  return h2connect.call(this, authority, options, ...rest);
};

// ---- DNS: names other than loopback never reach a resolver.
const RESOLVE = Object.keys(dns).filter((name) => name.startsWith("resolve") || name === "reverse");

function guardCallback(owner, name, nameArg = 0) {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = function guarded(...args) {
    const host = args[nameArg];
    if (name !== "lookup" || !loopback(host)) {
      const callback = args.findLast((arg) => typeof arg === "function");
      const error = refusal(`DNS ${name} ${host}`);
      if (callback) process.nextTick(() => callback(error));
      else throw error;
      return undefined;
    }
    return original.apply(this, args);
  };
}

function guardPromise(owner, name, nameArg = 0) {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = function guarded(...args) {
    const host = args[nameArg];
    if (name !== "lookup" || !loopback(host)) return Promise.reject(refusal(`DNS ${name} ${host}`));
    return original.apply(this, args);
  };
}

for (const name of ["lookup", ...RESOLVE]) guardCallback(dns, name);
guardCallback(dns, "lookupService");
for (const name of RESOLVE) guardCallback(dns.Resolver.prototype, name);
for (const name of ["lookup", ...RESOLVE]) guardPromise(dns.promises, name);
guardPromise(dns.promises, "lookupService");
for (const name of RESOLVE) guardPromise(dns.promises.Resolver.prototype, name);

// ---- UDP: no datagram to a non-loopback address.
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function guardedSend(...args) {
  // send(msg[, offset, length][, port][, address][, callback]); an address is
  // the only string after the message. Omitted, it defaults to loopback or
  // to the connect()ed peer, which connect() already checked.
  const address = args.slice(1).find((arg) => typeof arg === "string");
  if (address !== undefined && !loopback(address)) throw refusal(`UDP ${address}`);
  return send.apply(this, args);
};
const udpConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function guardedUdpConnect(port, address, ...rest) {
  if (typeof address === "string" && !loopback(address)) throw refusal(`UDP ${address}:${port}`);
  return udpConnect.call(this, port, address, ...rest);
};
