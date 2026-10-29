// Run under the egress guard by eval/tasks/worker-controls.ts: tries every
// Node network path at a non-loopback sink and prints each outcome as JSON.
// argv: <sink host or ""> <tcp port> <udp port> <loopback tcp port>
"use strict";
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const http2 = require("node:http2");
const dns = require("node:dns");
const dgram = require("node:dgram");

const [host, tcp, udp, local] = process.argv.slice(2);
const code = (error) => error?.code ?? error?.cause?.code ?? String(error);
const socket = (make) =>
  new Promise((resolve) => {
    try {
      const s = make();
      s.once("error", (e) => resolve(code(e)));
      s.once("connect", () => (s.destroy(), resolve("connected")));
      s.once("secureConnect", () => (s.destroy(), resolve("connected")));
    } catch (e) {
      resolve(code(e));
    }
  });
const callback = (make) =>
  new Promise((resolve) => {
    try {
      make((e) => resolve(e ? code(e) : "answered"));
    } catch (e) {
      resolve(code(e));
    }
  });
const promise = (make) =>
  Promise.resolve()
    .then(make)
    .then(() => "answered", code);
const sync = (make) => {
  try {
    make();
    return "sent";
  } catch (e) {
    return code(e);
  }
};

(async () => {
  const out = {};
  if (host) {
    const port = Number(tcp);
    Object.assign(out, {
      "net.connect path:null": await socket(() => net.connect({ host, port, path: null })),
      'net.connect path:""': await socket(() => net.connect({ host, port, path: "" })),
      "net.connect port,host": await socket(() => net.connect(port, host)),
      "net.createConnection": await socket(() => net.createConnection({ host, port })),
      "Socket#connect port,host": await socket(() => new net.Socket().connect(port, host)),
      "Socket#connect options": await socket(() => new net.Socket().connect({ port, host })),
      "tls.connect options": await socket(() => tls.connect({ host, port, rejectUnauthorized: false })),
      "tls.connect port,host": await socket(() => tls.connect(port, host, { rejectUnauthorized: false })),
      "http.get": await new Promise((resolve) => {
        const r = http.get(`http://${host}:${port}/`, () => resolve("answered"));
        r.once("error", (e) => resolve(code(e)));
      }),
      "http2.connect": await new Promise((resolve) => {
        try {
          const session = http2.connect(`http://${host}:${port}`);
          session.once("error", (e) => resolve(code(e)));
          session.once("connect", () => (session.destroy(), resolve("connected")));
        } catch (e) {
          resolve(code(e));
        }
      }),
      "http2.connect createConnection": await new Promise((resolve) => {
        const session = http2.connect(`http://${host}:${port}`, {
          createConnection: () => net.connect({ host, port }),
        });
        session.once("error", (e) => resolve(code(e)));
      }),
      fetch: await promise(() => fetch(`http://${host}:${port}/`)),
      "dgram send": sync(() => dgram.createSocket("udp4").send("x", Number(udp), host)),
      "dgram connect": sync(() => dgram.createSocket("udp4").connect(Number(udp), host)),
    });
  }
  Object.assign(out, {
    "dns.lookup": await callback((done) => dns.lookup("registry.npmjs.org", done)),
    "dns.resolve4": await callback((done) => dns.resolve4("registry.npmjs.org", done)),
    "dns.resolve": await callback((done) => dns.resolve("registry.npmjs.org", done)),
    "dns.reverse": await callback((done) => dns.reverse("1.1.1.1", done)),
    "dns.lookupService": await callback((done) => dns.lookupService("1.1.1.1", 53, done)),
    "dns.Resolver#resolve4": await callback((done) => new dns.Resolver().resolve4("registry.npmjs.org", done)),
    "dns.promises.lookup": await promise(() => dns.promises.lookup("registry.npmjs.org")),
    "dns.promises.resolve4": await promise(() => dns.promises.resolve4("registry.npmjs.org")),
    "dns.promises.Resolver#resolve4": await promise(() => new dns.promises.Resolver().resolve4("registry.npmjs.org")),
    "loopback tcp": await socket(() => net.connect(Number(local), "127.0.0.1")),
    "loopback lookup": await callback((done) => dns.lookup("localhost", done)),
  });
  console.log(JSON.stringify(out));
  process.exit(0);
})();
