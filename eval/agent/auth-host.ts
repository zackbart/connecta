/** A deterministic 2026-07-28 host around the CLI's MCP transport.
 * The model still chooses tools. This adapter exercises Connecta's real MRTR
 * boundary even when a CLI negotiates an older protocol. It is not evidence
 * that that CLI natively implements URL elicitation. `auto-decline` stands for a
 * client that declares URL elicitation and refuses without showing anyone the
 * prompt, as observed from the Agent SDK. It never opens the link it was given.
 * `accept-first` keeps a real host's ordering: accept is consent to open the link,
 * not proof that it opened, so the retry goes out before the visit lands. `capable`
 * instead finishes the visit first, which makes a round's outcome deterministic.
 */
import type { Deployment } from "../deploy/node.js";
import { serveFetch } from "../support/serve.js";
import type { ActiveTask } from "../tasks/types.js";
import type { StreamEvent } from "./trace.js";

export async function startAuthHost(
  deployment: Deployment,
  mode: NonNullable<ActiveTask["host"]>["urlElicitation"],
  onEvent: (event: StreamEvent) => void,
) {
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
        "io.modelcontextprotocol/clientCapabilities": {
          elicitation: mode === "incapable" ? { form: {} } : { url: {} },
        },
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
        mode === "incapable" ||
        input?.method !== "elicitation/create" ||
        input.params.mode !== "url" ||
        typeof link !== "string"
      ) {
        throw new Error("Unexpected eval auth input request");
      }
      const action = mode === "auto-decline" ? "decline" : "accept";
      onEvent({ type: "eval_url_elicitation", connector: "oauth", url: link, action });
      if (mode === "capable") await deployment.openConnect(link);
      ({ response, reply } = await dispatch({
        ...modern,
        requestState: reply.result.requestState,
        inputResponses: { connecta_auth: { action } },
      }));
      if (mode === "accept-first") await deployment.openConnect(link);
    }
    return Response.json(reply, { status: response.status });
  });
  return { mcpUrl: `${server.url}/mcp`, close: () => server.close() };
}
