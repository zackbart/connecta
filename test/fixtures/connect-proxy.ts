// Loopback CONNECT proxy: observe authentication/tunnels without inspecting TLS or rewriting requests.
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { onTestFinished } from "vitest";

export async function connectProxy(mode: "tunnel" | "refuse" | "reset" | "hold" = "tunnel") {
  const sockets = new Set<Socket>();
  const tunnels: Array<{ target: string; authorization: string | undefined }> = [];
  const server = createServer((_request, response) => response.writeHead(405).end());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, incoming, head) => {
    tunnels.push({ target: request.url!, authorization: request.headers["proxy-authorization"] });
    if (mode === "refuse") { incoming.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return; }
    if (mode === "reset") { incoming.destroy(); return; }
    if (mode === "hold") {
      incoming.on("end", () => incoming.destroy());
      incoming.resume();
      return;
    }
    const target = new URL(`http://${request.url}`);
    const outgoing = connect({ host: target.hostname, port: Number(target.port) });
    sockets.add(outgoing);
    outgoing.once("close", () => { sockets.delete(outgoing); incoming.destroy(); });
    incoming.once("close", () => outgoing.destroy());
    outgoing.on("error", () => incoming.destroy());
    incoming.on("error", () => outgoing.destroy());
    outgoing.once("connect", () => {
      incoming.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) outgoing.write(head);
      outgoing.pipe(incoming).pipe(outgoing);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, tunnels, sockets };
}
