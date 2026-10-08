/** A deterministic 2026-07-28 host around the CLI's MCP transport.
 * The model still chooses tools. This adapter exercises Connecta's real MRTR
 * boundary even when a CLI negotiates an older protocol. It is not evidence
 * that that CLI natively implements URL elicitation.
 */
import type { Deployment } from "../deploy/node.js";
import { serveFetch } from "../support/serve.js";
import type { StreamEvent } from "./trace.js";

export async function startAuthHost(deployment: Deployment, capable: boolean, onEvent: (event: StreamEvent) => void) {
  const server = await serveFetch(async (request) => {
    const url = new URL(deployment.mcpUrl);
    const headers = new Headers(request.headers);
    headers.set("host", url.host);
    headers.delete("content-length");
    if (request.method !== "POST") return fetch(url, { method: request.method, headers });
    const body = (await request.json()) as { id?: unknown; method: string; params?: Record<string, any> };
    if (body.method !== "tools/call") return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const params = body.params ?? {};
    headers.set("MCP-Protocol-Version", "2026-07-28");
    headers.set("Mcp-Method", "tools/call");
    headers.set("Mcp-Name", String(params.name));
    headers.set("Accept", "application/json");
    headers.delete("Mcp-Session-Id");
    if (typeof params.arguments?.address === "string") headers.set("Mcp-Param-Address", params.arguments.address);
    const modern = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "connecta-eval-auth-host", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": { elicitation: capable ? { url: {} } : { form: {} } },
      },
    };
    const dispatch = async (p: Record<string, unknown>) => {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, params: p }) });
      const reply = (await response.json()) as { result?: Record<string, any>; error?: unknown };
      return { response, reply };
    };
    let { response, reply } = await dispatch(modern);
    for (let round = 0; reply.result?.resultType === "input_required" && round < 3; round++) {
      const input = reply.result.inputRequests?.connecta_auth;
      const link = input?.params?.url;
      if (
        !capable ||
        input?.method !== "elicitation/create" ||
        input.params.mode !== "url" ||
        typeof link !== "string"
      ) {
        throw new Error("Unexpected eval auth input request");
      }
      onEvent({ type: "eval_url_elicitation", connector: "oauth", url: link, action: "accept" });
      await deployment.openConnect(link);
      ({ response, reply } = await dispatch({
        ...modern,
        requestState: reply.result.requestState,
        inputResponses: { connecta_auth: { action: "accept" } },
      }));
    }
    return Response.json(reply, { status: response.status });
  });
  return { mcpUrl: `${server.url}/mcp`, close: () => server.close() };
}
