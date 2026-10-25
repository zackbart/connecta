// Independent peer so the server's process.exit cannot hide truncation of queued bytes.
import assert from "node:assert/strict";
import { createConnection } from "node:net";

const mode = process.argv[3]!;
const socket = createConnection({ host: "127.0.0.1", port: Number(process.argv[2]), allowHalfOpen: true });
let output = "";
let requested = false;
const send = (path: string) => socket.write(`GET /${path} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`);
socket.on("connect", () => {
  if (mode === "unused") process.send!("ready");
  else if (mode === "partial") {
    socket.write("GET / HTTP/1.1\r\nHo");
    setTimeout(() => process.send!("ready"), 20);
  } else send("warm");
});
socket.on("data", (chunk) => {
  output += chunk;
  if (!requested && output.includes("warm")) {
    requested = true;
    assert.match(output, /Connection: keep-alive/i, "normal keepalive is preserved");
    send("slow");
    if (mode === "pipeline") send("after");
    if (mode !== "sse" && mode !== "error") process.send!("ready");
  }
  if ((mode === "sse" || mode === "error") && output.includes("data: opened")) {
    process.send!("ready");
  }
});
socket.on("end", () => {
  if (mode === "sse") assert.match(output, /data: finished/, "complete SSE bytes arrive");
  else if (["short", "long", "pipeline"].includes(mode)) assert.match(output, /finished/, "complete response bytes arrive");
  if (mode === "pipeline") assert.match(output, /after-pipeline/, "the queued pipelined response arrives");
  console.log(`peer verified ${mode}`);
  // The peer never initiates FIN; it exits only after the server closes first.
  process.exit(0);
});
socket.on("error", (error) => {
  // A partial first request and a failed stream may be reset rather than FIN.
  if (["partial", "unused", "error", "deadline"].includes(mode)) {
    console.log(`peer verified ${mode}`);
    process.exit(0);
  }
  throw error;
});
