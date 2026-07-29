import {
  ConnectorCallError,
  api,
  bearerToken,
  createConnecta,
  memoryStorage,
  type ConnectorContext,
  type ToolCallActivityEvent,
} from "../../src/index.js";
import { CredentialVault } from "../../src/credentials.js";
import { quickJsExecutor } from "../../src/executors/quickjs.js";
import { listen } from "../../src/node.js";

const port = Number(process.env.CONNECTA_EVAL_PORT ?? "8797");
const token = process.env.CONNECTA_EVAL_TOKEN ?? "connecta-eval-token";
const host = "127.0.0.1";
const credentialEncryptionKey = Buffer.alloc(32, 7).toString("base64");
const storage = memoryStorage();

if (process.env.CONNECTA_EVAL_SEED_PROTECTED === "1") {
  await new CredentialVault(storage, credentialEncryptionKey).set(
    "protected",
    "sandbox-ok",
    "sandbox-bootstrap",
  );
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.trunc(seconds * 1_000)
    : undefined;
}

async function getJson(url: URL, ctx: ConnectorContext): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "connecta-current-version-eval",
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (cause) {
    if (ctx.signal?.aborted) {
      throw new ConnectorCallError("timeout", "Public API request timed out.", {
        cause,
      });
    }
    throw new ConnectorCallError(
      "unavailable",
      "Public API request could not be completed.",
      { cause },
    );
  }
  if (response.ok) return response.json();
  if (response.status === 401) {
    throw new ConnectorCallError(
      "auth_required",
      "The public API requires authorization.",
    );
  }
  if (response.status === 403 || response.status === 429) {
    const wait = retryAfterMs(response);
    throw new ConnectorCallError(
      "rate_limited",
      `The public API returned HTTP ${response.status}.`,
      wait !== undefined ? { retryAfterMs: wait } : {},
    );
  }
  if (response.status >= 500) {
    throw new ConnectorCallError(
      "unavailable",
      `The public API returned HTTP ${response.status}.`,
    );
  }
  throw new ConnectorCallError(
    "connector_call_failed",
    `The public API returned HTTP ${response.status}.`,
  );
}

const npm = api("npm", {
  title: "npm Registry",
  description: "Live public npm package metadata and download counts",
  usageGuide:
    "# npm Registry\n\nUse `search_packages` to discover exact package names before fetching metadata or counts.",
  tools: [
    {
      name: "search_packages",
      description:
        "Search the live npm registry for packages matching a text query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          size: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async (args: { query: string; size?: number }, ctx) => {
        const url = new URL("https://registry.npmjs.org/-/v1/search");
        url.searchParams.set("text", args.query);
        url.searchParams.set("size", String(args.size ?? 5));
        return getJson(url, ctx);
      },
    },
    {
      name: "get_package",
      description:
        "Fetch complete live npm registry metadata for an exact package name.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (args: { name: string }, ctx) =>
        getJson(
          new URL(`https://registry.npmjs.org/${encodeURIComponent(args.name)}`),
          ctx,
        ),
    },
    {
      name: "get_download_counts",
      description:
        "Fetch npm download counts for an exact package and period such as last-week or last-month.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          period: { type: "string", default: "last-week" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (args: { name: string; period?: string }, ctx) =>
        getJson(
          new URL(
            `https://api.npmjs.org/downloads/point/${encodeURIComponent(args.period ?? "last-week")}/${encodeURIComponent(args.name)}`,
          ),
          ctx,
        ),
    },
  ],
});

const github = api("github", {
  title: "GitHub Public API",
  description: "Live unauthenticated read-only GitHub repository data",
  usageGuide:
    "# GitHub Public API\n\nThis sandbox is intentionally unauthenticated and read-only. Keep result sizes small to avoid the public rate limit.",
  tools: [
    {
      name: "get_repository",
      description: "Fetch current metadata for one public GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", minLength: 1 },
          repo: { type: "string", minLength: 1 },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (args: { owner: string; repo: string }, ctx) =>
        getJson(
          new URL(
            `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`,
          ),
          ctx,
        ),
    },
    {
      name: "list_issues",
      description:
        "List current issues and pull requests for a public GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", minLength: 1 },
          repo: { type: "string", minLength: 1 },
          state: { type: "string", enum: ["open", "closed", "all"] },
          perPage: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (
        args: {
          owner: string;
          repo: string;
          state?: "open" | "closed" | "all";
          perPage?: number;
        },
        ctx,
      ) => {
        const url = new URL(
          `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues`,
        );
        url.searchParams.set("state", args.state ?? "open");
        url.searchParams.set("per_page", String(args.perPage ?? 5));
        return getJson(url, ctx);
      },
    },
    {
      name: "get_issue",
      description:
        "Fetch one current issue or pull request by repository and number.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", minLength: 1 },
          repo: { type: "string", minLength: 1 },
          number: { type: "integer", minimum: 1 },
        },
        required: ["owner", "repo", "number"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (
        args: { owner: string; repo: string; number: number },
        ctx,
      ) =>
        getJson(
          new URL(
            `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.number}`,
          ),
          ctx,
        ),
    },
    {
      name: "list_releases",
      description:
        "List recent releases for a public GitHub repository, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", minLength: 1 },
          repo: { type: "string", minLength: 1 },
          perPage: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (
        args: { owner: string; repo: string; perPage?: number },
        ctx,
      ) => {
        const url = new URL(
          `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/releases`,
        );
        url.searchParams.set("per_page", String(args.perPage ?? 5));
        return getJson(url, ctx);
      },
    },
  ],
});

const controlled = api("controlled", {
  title: "Controlled Eval Fixtures",
  description:
    "Deterministic read-only fixtures for paging and reduction edge cases",
  maxResultBytes: 700,
  tools: [
    {
      name: "large_document",
      description:
        "Return a deterministic UTF-8 document large enough to require get_result paging.",
      inputSchema: {
        type: "object",
        properties: {
          paragraphs: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: 40,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (args: { paragraphs?: number }) => {
        const count = args.paragraphs ?? 40;
        return {
          title: "Deterministic paging fixture",
          paragraphs: Array.from(
            { length: count },
            (_, index) =>
              `${index + 1}. Connecta keeps discovery bounded while preserving complete catalogs. UTF-8 check: café, 東京, 🧪.`,
          ),
        };
      },
    },
    {
      name: "records",
      description:
        "Return deterministic records for execute_code filtering and aggregation.",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            default: 100,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (args: { count?: number }) =>
        Array.from({ length: args.count ?? 100 }, (_, index) => ({
          id: index + 1,
          group: ["alpha", "beta", "gamma"][index % 3],
          score: (index * 17) % 101,
        })),
    },
  ],
});

const protectedConnector = api("protected", {
  title: "Credential-gated Sandbox Service",
  description:
    "An isolated credential-gated connector for fail-at-use recovery testing",
  credential: {
    label: "Sandbox access token",
    description: "The disposable eval value is sandbox-ok.",
  },
  testCredential: async (value) => ({
    ok: value === "sandbox-ok",
    message:
      value === "sandbox-ok"
        ? "Sandbox credential is valid."
        : "Sandbox credential was rejected.",
  }),
  tools: [
    {
      name: "whoami",
      description:
        "Return the sandbox identity after a valid operator credential is configured.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async (_args, ctx) => {
        const value = await ctx.credential?.get();
        if (value !== "sandbox-ok") {
          throw new ConnectorCallError(
            "auth_required",
            "Sandbox credential missing or invalid; configure protected in /credentials.",
          );
        }
        return { id: "sandbox-agent", role: "evaluator" };
      },
    },
  ],
});

const activityEvents: ToolCallActivityEvent[] = [];

const connecta = createConnecta({
  auth: bearerToken(token, { subjectId: "current-version-evaluator" }),
  connectors: [npm, github, controlled, protectedConnector],
  storage,
  executor: quickJsExecutor({
    timeoutMs: 10_000,
    cpuTimeMs: 2_000,
  }),
  credentials: {
    encryptionKey: credentialEncryptionKey,
  },
  calls: {
    defaultTimeoutMs: 15_000,
    maxResultBytes: 8_000,
    maxBatchResultBytes: 12_000,
  },
  activity: {
    deploymentId: "current-origin-main-sandbox",
    store: {
      record(event) {
        activityEvents.unshift(event);
      },
      async list({ limit }) {
        return { events: activityEvents.slice(0, limit) };
      },
    },
  },
  serverInfo: {
    name: "connecta-current-version-eval",
    version: "b43dd2d",
    title: "Connecta current-version eval sandbox",
  },
  deploymentInfo: {
    sourceCommit: "b43dd2d85a32953b81af3d827a722d13ee60e5b5",
    isolated: true,
  },
});

const server = listen(connecta, {
  port,
  host,
  gracefulShutdown: false,
});

console.log(
  JSON.stringify({
    event: "ready",
    url: `http://${host}:${port}/mcp`,
    commit: "b43dd2d85a32953b81af3d827a722d13ee60e5b5",
    connectors: ["npm", "github", "controlled", "protected"],
    protectedCredentialSeeded:
      process.env.CONNECTA_EVAL_SEED_PROTECTED === "1",
  }),
);

async function shutdown(): Promise<void> {
  server.close();
  await connecta.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
