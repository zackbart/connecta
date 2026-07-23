import {
  ACM,
  AI,
  AIGateway,
  AISearch,
  Accounts,
  Alerting,
  AuditLogs,
  Billing,
  BrowserRendering,
  Calls,
  CertificateAuthorities,
  ClientCertificates,
  Connectivity,
  CustomCertificates,
  CustomCsrs,
  CustomHostnames,
  CustomNameservers,
  D1Resource,
  DCVDelegation,
  DNS,
  DNSFirewall,
  Diagnostics,
  DurableObjects,
  EmailAuth,
  EmailRouting,
  EmailSecurity,
  EmailSending,
  Hostnames,
  HyperdriveResource,
  IAM,
  Images,
  KV,
  KeylessCertificates,
  Logs,
  Logpush,
  Memberships,
  MoQ,
  MTLSCertificates,
  Organizations,
  OriginPostQuantumEncryption,
  OriginTLSClientAuth,
  OriginTLSComplianceModes,
  Pages,
  Pipelines,
  Queues,
  R2,
  R2DataCatalog,
  RealtimeKit,
  RequestTracers,
  ResourceSharing,
  ResourceTagging,
  SSL,
  SecretsStore,
  Stream,
  TenantCustomNameservers,
  Tenants,
  Turnstile,
  User,
  Vectorize,
  Workers,
  WorkersForPlatforms,
  Workflows,
  ZeroTrust,
  Zones,
} from "cloudflare/resources";
import { createClient } from "cloudflare/tree-shakable";
import {
  CLOUDFLARE_OPERATIONS,
  CLOUDFLARE_SDK_COMMIT,
  type CloudflareOperation,
} from "./cloudflare-manifest.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorCredentialValues,
  JsonSchema,
  ToolDef,
} from "../types.js";

type DynamicClient = Record<string, unknown>;
type DynamicFunction = (...args: unknown[]) => unknown;
const MAX_RAW_RESPONSE_BYTES = 256 * 1024;

const RESOURCES = [
  Accounts,
  ACM,
  AI,
  AIGateway,
  AISearch,
  Alerting,
  AuditLogs,
  Billing,
  BrowserRendering,
  Calls,
  CertificateAuthorities,
  ClientCertificates,
  Connectivity,
  CustomCertificates,
  CustomCsrs,
  CustomHostnames,
  CustomNameservers,
  D1Resource,
  DCVDelegation,
  Diagnostics,
  DNS,
  DNSFirewall,
  DurableObjects,
  EmailAuth,
  EmailRouting,
  EmailSecurity,
  EmailSending,
  Hostnames,
  HyperdriveResource,
  IAM,
  Images,
  KeylessCertificates,
  KV,
  Logs,
  Logpush,
  Memberships,
  MoQ,
  MTLSCertificates,
  Organizations,
  OriginPostQuantumEncryption,
  OriginTLSClientAuth,
  OriginTLSComplianceModes,
  Pages,
  Pipelines,
  Queues,
  R2,
  R2DataCatalog,
  RealtimeKit,
  RequestTracers,
  ResourceSharing,
  ResourceTagging,
  SecretsStore,
  SSL,
  Stream,
  TenantCustomNameservers,
  Tenants,
  Turnstile,
  User,
  Vectorize,
  Workers,
  WorkersForPlatforms,
  Workflows,
  ZeroTrust,
  Zones,
];

const instantiateClient = createClient as unknown as (options: {
  apiEmail: string;
  apiKey: string;
  resources: readonly unknown[];
  maxRetries: number;
  timeout?: number;
  fetchOptions?: { signal?: AbortSignal };
}) => DynamicClient;

function isReadOnly(operation: CloudflareOperation): boolean {
  return operation.method === "GET" || operation.method === "HEAD";
}

function operationSchema(operation: CloudflareOperation): JsonSchema {
  const readOnly = isReadOnly(operation);
  return {
    type: "object",
    properties: {
      arguments: {
        type: "array",
        description:
          `Ordered arguments for ${operation.signature}. ` +
          "Use an empty array when the SDK method takes no arguments. " +
          'Uploads may be represented as {"$file":{"base64":"...",' +
          '"name":"file.bin","type":"application/octet-stream"}}.',
        items: {},
      },
      ...(!readOnly
        ? {
            confirm: {
              type: "boolean",
              const: true,
              description:
                "Required confirmation that this operation may change, delete, send, deploy, or incur charges in Cloudflare.",
            },
          }
        : {}),
    },
    ...(!readOnly ? { required: ["confirm"] } : {}),
    additionalProperties: false,
  };
}

function operationDescription(operation: CloudflareOperation): string {
  const effect = isReadOnly(operation)
    ? "Read Cloudflare state."
    : "Change Cloudflare state; explicit confirmation is required.";
  return `${effect} ${operation.signature}. HTTP ${operation.method} ${operation.endpoint}`;
}

const DOCUMENTATION_TOOL: ToolDef = {
  name: "sdk.getOperationDocumentation",
  description:
    "Get the official pinned Cloudflare TypeScript SDK source excerpt and parameter types for one exposed operation.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          'Exact Cloudflare tool name, for example "d1.database.query".',
      },
    },
    required: ["operation"],
    additionalProperties: false,
  },
  annotations: {
    title: "Get Cloudflare operation documentation",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

const TOOL_DEFS: ToolDef[] = [
  DOCUMENTATION_TOOL,
  ...CLOUDFLARE_OPERATIONS.map((operation) => {
    const readOnly = isReadOnly(operation);
    return {
      name: operation.name,
      description: operationDescription(operation),
      inputSchema: operationSchema(operation),
      annotations: {
        title: operation.signature.split("(")[0]?.replace("client.", ""),
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint:
          readOnly ||
          operation.method === "PUT" ||
          operation.method === "DELETE",
        openWorldHint: true,
      },
    };
  }),
];

const OPERATIONS_BY_NAME = new Map(
  CLOUDFLARE_OPERATIONS.map((operation) => [operation.name, operation]),
);

function credentials(
  values: ConnectorCredentialValues | null,
): { apiEmail: string; apiKey: string } {
  const apiEmail = values?.apiEmail?.trim();
  const apiKey = values?.apiKey?.trim();
  if (!apiEmail || !apiKey) {
    throw new Error(
      "Cloudflare credentials are not configured. Add the account email and Global API Key in Connecta /ui.",
    );
  }
  return { apiEmail, apiKey };
}

function makeClient(
  values: ConnectorCredentialValues,
  ctx: ConnectorContext,
  operation?: CloudflareOperation,
): DynamicClient {
  const auth = credentials(values);
  return instantiateClient({
    ...auth,
    resources: RESOURCES,
    // Never automatically replay a state-changing request.
    maxRetries: operation && !isReadOnly(operation) ? 0 : 2,
    ...(ctx.timeoutMs ? { timeout: ctx.timeoutMs } : {}),
    ...(ctx.signal ? { fetchOptions: { signal: ctx.signal } } : {}),
  });
}

function base64Bytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Invalid base64 in $file upload");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hydrateUploads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateUploads);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (
    object.$file &&
    typeof object.$file === "object" &&
    !Array.isArray(object.$file)
  ) {
    const file = object.$file as Record<string, unknown>;
    if (typeof file.base64 !== "string") {
      throw new Error("$file.base64 must be a string");
    }
    return new File(
      [base64Bytes(file.base64)],
      typeof file.name === "string" ? file.name : "upload.bin",
      {
        type:
          typeof file.type === "string"
            ? file.type
            : "application/octet-stream",
      },
    );
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, nested]) => [key, hydrateUploads(nested)]),
  );
}

function methodAt(
  client: DynamicClient,
  path: readonly string[],
): { owner: DynamicClient; method: DynamicFunction } {
  let owner: DynamicClient = client;
  for (const segment of path.slice(0, -1)) {
    const next = owner[segment];
    if (!next || typeof next !== "object") {
      throw new Error(`Cloudflare SDK resource is unavailable at ${segment}`);
    }
    owner = next as DynamicClient;
  }
  const methodName = path.at(-1)!;
  const method = owner[methodName];
  if (typeof method !== "function") {
    throw new Error(`Cloudflare SDK method is unavailable at ${path.join(".")}`);
  }
  return { owner, method: method as DynamicFunction };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readBoundedResponse(
  response: Response,
): Promise<{
  bytes: Uint8Array;
  truncated: boolean;
  contentLength?: number;
}> {
  const rawLength = response.headers.get("content-length");
  const contentLength = rawLength ? Number(rawLength) : undefined;
  if (
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > MAX_RAW_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    return {
      bytes: new Uint8Array(),
      truncated: true,
      contentLength,
    };
  }
  if (!response.body) {
    return {
      bytes: new Uint8Array(),
      truncated: false,
      ...(contentLength !== undefined ? { contentLength } : {}),
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const remaining = MAX_RAW_RESPONSE_BYTES - total;
    if (next.value.byteLength > remaining) {
      if (remaining > 0) chunks.push(next.value.slice(0, remaining));
      total += Math.max(remaining, 0);
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    truncated,
    ...(contentLength !== undefined && Number.isFinite(contentLength)
      ? { contentLength }
      : {}),
  };
}

function sourceExcerpt(source: string, operation: CloudflareOperation): string {
  const methodName = operation.path.at(-1)!;
  const methodPattern = new RegExp(`\\n  ${methodName}\\s*\\(`);
  const methodMatch = methodPattern.exec(source);
  if (!methodMatch) return source.slice(0, 50_000);

  const docStart = source.lastIndexOf("/**", methodMatch.index);
  const excerptStart = docStart >= 0 ? docStart : methodMatch.index;
  const methodEnd = source.indexOf("\n  }\n", methodMatch.index);
  const excerptEnd =
    methodEnd >= 0 ? methodEnd + "\n  }".length : methodMatch.index + 12_000;
  const methodSource = source.slice(excerptStart, excerptEnd);
  const parameterTypes = new Set(
    methodSource.match(/\b[A-Z][A-Za-z0-9_]*Params\b/g) ?? [],
  );
  const typeSources: string[] = [];
  for (const typeName of parameterTypes) {
    const interfaceStart = source.indexOf(`export interface ${typeName}`);
    if (interfaceStart >= 0) {
      const interfaceEnd = source.indexOf("\n}", interfaceStart);
      if (interfaceEnd >= 0) {
        typeSources.push(source.slice(interfaceStart, interfaceEnd + 2));
        continue;
      }
    }
    const typeStart = source.indexOf(`export type ${typeName}`);
    if (typeStart >= 0) {
      const typeEnd = source.indexOf(";\n", typeStart);
      if (typeEnd >= 0) {
        typeSources.push(source.slice(typeStart, typeEnd + 1));
      }
    }
  }
  return [methodSource, ...typeSources].join("\n\n").slice(0, 50_000);
}

async function operationDocumentation(
  name: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const operation = OPERATIONS_BY_NAME.get(name);
  if (!operation) {
    throw new Error(`Unknown Cloudflare operation "${name}"`);
  }
  const sourceUrl =
    `https://raw.githubusercontent.com/cloudflare/cloudflare-typescript/` +
    `${CLOUDFLARE_SDK_COMMIT}/${operation.source}`;
  const response = await fetch(sourceUrl, { signal });
  if (!response.ok) {
    throw new Error(
      `Could not load Cloudflare SDK documentation (${response.status})`,
    );
  }
  const source = await response.text();
  return {
    operation: operation.name,
    signature: operation.signature,
    http: `${operation.method} ${operation.endpoint}`,
    sdkCommit: CLOUDFLARE_SDK_COMMIT,
    sourceUrl,
    sourceExcerpt: sourceExcerpt(source, operation),
  };
}

async function normalizeResult(value: unknown): Promise<unknown> {
  if (value instanceof Response) {
    const contentType = value.headers.get("content-type") ?? "";
    const headers = Object.fromEntries(value.headers.entries());
    const body = await readBoundedResponse(value);
    const bodyMetadata = {
      bodyTruncated: body.truncated,
      bodyBytes: body.bytes.byteLength,
      ...(body.contentLength !== undefined
        ? { contentLength: body.contentLength }
        : {}),
    };
    if (
      contentType.includes("json") ||
      contentType.startsWith("text/") ||
      contentType.includes("javascript") ||
      contentType.includes("xml")
    ) {
      return {
        status: value.status,
        headers,
        body: new TextDecoder().decode(body.bytes),
        ...bodyMetadata,
      };
    }
    return {
      status: value.status,
      headers,
      bodyBase64: bytesToBase64(body.bytes),
      ...bodyMetadata,
    };
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_RAW_RESPONSE_BYTES) {
      return { bodyTruncated: true, bodyBytes: 0, contentLength: value.byteLength };
    }
    return {
      base64: bytesToBase64(new Uint8Array(value)),
      bodyTruncated: false,
      bodyBytes: value.byteLength,
    };
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_RAW_RESPONSE_BYTES) {
      return { bodyTruncated: true, bodyBytes: 0, contentLength: value.byteLength };
    }
    return {
      base64: bytesToBase64(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      ),
      bodyTruncated: false,
      bodyBytes: value.byteLength,
    };
  }
  if (value instanceof Blob) {
    if (value.size > MAX_RAW_RESPONSE_BYTES) {
      return {
        type: value.type,
        size: value.size,
        bodyTruncated: true,
        bodyBytes: 0,
      };
    }
    return {
      type: value.type,
      size: value.size,
      base64: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      bodyTruncated: false,
      bodyBytes: value.size,
    };
  }
  if (
    value &&
    typeof value === "object" &&
    "getPaginatedItems" in value &&
    typeof (value as { getPaginatedItems?: unknown }).getPaginatedItems ===
      "function"
  ) {
    const page = value as {
      getPaginatedItems(): unknown[];
      hasNextPage(): boolean;
      result_info?: unknown;
    };
    return {
      items: page.getPaginatedItems(),
      hasNextPage: page.hasNextPage(),
      ...(page.result_info ? { resultInfo: page.result_info } : {}),
    };
  }
  return value;
}

async function configuredValues(
  ctx: ConnectorContext,
): Promise<ConnectorCredentialValues> {
  return credentials((await ctx.credential?.getAll()) ?? null);
}

export interface CloudflareConnectorOptions {
  title?: string;
  description?: string;
}

/**
 * Broad Cloudflare API connector backed by the official tree-shakable
 * TypeScript SDK. The generated manifest pins the exact SDK commit and exposes
 * the chosen product families as individually searchable Connecta tools.
 */
export function cloudflareApi(
  id = "cloudflare",
  options: CloudflareConnectorOptions = {},
): Connector {
  return {
    id,
    title: options.title ?? "Cloudflare",
    kind: "api",
    description:
      options.description ??
      "Cloudflare workers, data, domains, networking, email, media, billing, and administration",
    credential: {
      label: "Cloudflare credentials",
      description:
        "Legacy Global API Key authentication. Both values are encrypted before storage.",
      fields: [
        {
          name: "apiEmail",
          label: "Cloudflare account email",
          placeholder: "you@example.com",
          inputType: "email",
        },
        {
          name: "apiKey",
          label: "Global API Key",
          placeholder: "Paste Global API Key",
          inputType: "password",
        },
      ],
    },
    async testCredentials(values, ctx) {
      try {
        const client = makeClient(values, ctx);
        const { owner, method } = methodAt(client, ["user", "get"]);
        const user = (await method.apply(owner, [])) as {
          email?: string;
          username?: string;
        };
        return {
          ok: true,
          message: `Authenticated as ${user.email ?? user.username ?? values.apiEmail}.`,
        };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Cloudflare rejected the credentials.",
        };
      }
    },
    staticTools: TOOL_DEFS,
    async listTools() {
      return TOOL_DEFS;
    },
    async callTool(name, args, ctx) {
      if (name === DOCUMENTATION_TOOL.name) {
        const operation =
          args && typeof args === "object"
            ? (args as { operation?: unknown }).operation
            : undefined;
        if (typeof operation !== "string" || !operation.trim()) {
          throw new Error("operation must be a non-empty string");
        }
        return operationDocumentation(operation, ctx.signal);
      }
      const operation = OPERATIONS_BY_NAME.get(name);
      if (!operation) {
        throw new Error(`Unknown tool "${name}" on connector "${id}"`);
      }
      const input =
        args && typeof args === "object"
          ? (args as { arguments?: unknown; confirm?: unknown })
          : {};
      if (!isReadOnly(operation) && input.confirm !== true) {
        throw new Error(
          `Cloudflare operation "${name}" changes state and requires confirm: true`,
        );
      }
      if (input.arguments !== undefined && !Array.isArray(input.arguments)) {
        throw new Error("arguments must be an array");
      }
      const values = await configuredValues(ctx);
      const client = makeClient(values, ctx, operation);
      const { owner, method } = methodAt(client, operation.path);
      const orderedArguments = (input.arguments ?? []).map(hydrateUploads);
      return normalizeResult(await method.apply(owner, orderedArguments));
    },
    async status(ctx) {
      const values = await ctx.credential?.getAll();
      try {
        credentials(values ?? null);
        return { state: "ok" };
      } catch (error) {
        return {
          state: "auth_required",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
