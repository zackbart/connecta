import { api } from "../../src/connectors/api.js";
import { bearerToken } from "../../src/auth/bearer.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { ConnectaConfig } from "../../src/index.js";
import type { Connector, InboundAuth } from "../../src/types.js";
import { createTestConnecta } from "../helpers.js";

const TEST_BASE = "https://connecta.test";
const TEST_TOKEN = "test-token-123";

let rpcId = 0;

type RpcOptions = {
  baseUrl?: string;
  id?: number;
  query?: string;
  runtimeContext?: { waitUntil(promise: Promise<unknown>): void };
  signal?: AbortSignal;
  token?: string;
};

type TestDeployment = {
  fetch(
    request: Request,
    env?: unknown,
    ctx?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response>;
};

export function mcpRpc(
  method: string,
  params?: unknown,
  options?: RpcOptions,
): Request;
export function mcpRpc(
  deployment: TestDeployment,
  method: string,
  params?: unknown,
  options?: RpcOptions,
): Promise<Response>;
export function mcpRpc(
  deploymentOrMethod: TestDeployment | string,
  methodOrParams: string | unknown = {},
  paramsOrOptions: unknown | RpcOptions = {},
  maybeOptions: RpcOptions = {},
): Request | Promise<Response> {
  const deployment = typeof deploymentOrMethod === "string"
    ? undefined
    : deploymentOrMethod;
  const method = typeof deploymentOrMethod === "string"
    ? deploymentOrMethod
    : methodOrParams as string;
  const params = typeof deploymentOrMethod === "string"
    ? methodOrParams
    : paramsOrOptions;
  const options = (typeof deploymentOrMethod === "string"
    ? paramsOrOptions
    : maybeOptions) as RpcOptions;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const request = new Request(
    `${options.baseUrl ?? TEST_BASE}/mcp${options.query ?? ""}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: options.id ?? ++rpcId,
        method,
        params,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return deployment
    ? deployment.fetch(request, undefined, options.runtimeContext)
    : request;
}

export async function readJsonRpc(response: Response): Promise<any> {
  const text = await response.text();
  const payload = (response.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  )
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .pop()
        ?.slice("data:".length)
        .trim()
    : text;
  return payload ? JSON.parse(payload) : null;
}

export function fakeClerkAuth(options: {
  frontendApiUrl?: string;
  publishableKey?: string;
  token?: string;
  userId?: string;
  signInUrl?: string;
  signUpUrl?: string;
  unauthorized?: () => Response;
} = {}): InboundAuth {
  return {
    kind: "clerk",
    uiAuth: {
      kind: "clerk",
      publishableKey: options.publishableKey ?? "pk_test_fake",
      frontendApiUrl: options.frontendApiUrl ?? "https://clerk.example.test",
      ...(options.signInUrl === undefined ? {} : { signInUrl: options.signInUrl }),
      ...(options.signUpUrl === undefined ? {} : { signUpUrl: options.signUpUrl }),
    },
    authorize(request) {
      if (request.headers.get("authorization") ===
        `Bearer ${options.token ?? "clerk-operator"}`) {
        return { ok: true, userId: options.userId ?? "user_operator" };
      }
      return {
        ok: false,
        response: options.unauthorized?.() ??
          Response.json({ error: "unauthorized" }, { status: 401 }),
      };
    },
  };
}

export function calcApi(options: {
  empty?: boolean;
  inputSchema?: "numbers" | "object";
  title?: string;
} = {}): Connector {
  return api("calc", {
    ...(options.title ? { title: options.title } : {}),
    description: "Calculator",
    tools: options.empty
      ? []
      : [
          {
            name: "add",
            description: "Add two numbers",
            annotations: { readOnlyHint: true },
            inputSchema: options.inputSchema === "object"
              ? { type: "object" }
              : {
                  type: "object",
                  properties: {
                    a: { type: "number" },
                    b: { type: "number" },
                  },
                  required: ["a", "b"],
                },
            handler: (args: { a: number; b: number }) => ({
              sum: args.a + args.b,
            }),
          },
        ],
  });
}

export function makeDeployment(
  config: Partial<Omit<ConnectaConfig, "executor">> & {
    executor?: ConnectaConfig["executor"];
  } = {},
) {
  return createTestConnecta({
    ...config,
    connectors: config.connectors ?? [calcApi()],
    auth: config.auth ?? bearerToken(TEST_TOKEN),
    storage: config.storage ?? memoryStorage(),
    publicUrl: config.publicUrl ?? TEST_BASE,
  });
}
