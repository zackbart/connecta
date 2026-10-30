// Skills and resources: the Skills extension's bounded listing and reads,
// and resource reads limited to what the downstream advertises.
import { utf8Length } from "../../bytes.js";
import { authFlow, authCall, authInvoke, authMethod, authCatch } from "../../auth/native.js";
import { Client, ResourceNotFoundError, isInputRequiredResult, UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult,
  StandardSchemaV1,
} from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { requestSentSecrets } from "../../sent-secrets.js";
import { MAX_SERIALIZED_CATALOG_BYTES } from "../../catalog-limits.js";
import { ConnectorCallError } from "../../errors.js";
import { carryFailureFacts } from "../../operator-record.js";
import { resourceUriMatchesTemplates, type ResourceTemplateRefusal } from "../resource-uri.js";
import type { ConnectorContext, ConnectorSkill, ConnectorSkillResourceContents } from "../../types.js";
import type { RemoteMcpRuntime, RemoteMcpShared } from "./runtime.js";
import type { ConnectionState } from "./connection.js";
import { downstreamCallError, hasSdkPayload, ownAbortReason, requiresAuthorization, withheldAs } from "./errors.js";

function unadvertisedResource(): ConnectorCallError {
  return new ConnectorCallError("not_found", "The resource URI is not advertised by this connector.", {
    retryable: false,
  });
}
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const MAX_SKILLS = 10_000;
const MAX_SKILL_FILES = 512;
const MAX_SKILL_BYTES = 16 * 1024 * 1024;
// A valid UTF-8 text file can expand sixfold when JSON escapes control bytes.
// Leave room for the envelope while accepting every file up to the spec limit.
export const MAX_SKILL_READ_RPC_BYTES = 6 * MAX_SKILL_BYTES + 1024 * 1024;

/** Count UTF-8 without allocating another full copy of a bounded response. */

export function skillObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skillJsonBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}

function validSkill(value: unknown): value is ConnectorSkill {
  if (
    !skillObject(value) ||
    typeof value.uri !== "string" ||
    !value.uri ||
    !skillObject(value.frontmatter) ||
    typeof value.frontmatter.name !== "string" ||
    !value.frontmatter.name ||
    typeof value.frontmatter.description !== "string" ||
    !value.frontmatter.description
  )
    return false;
  if (value.resources === "dynamic") return true;
  if (!Array.isArray(value.resources) || !value.resources.length || value.resources.length > MAX_SKILL_FILES)
    return false;
  const uris = new Set<string>();
  let bytes = 0;
  for (const resource of value.resources) {
    if (
      !skillObject(resource) ||
      typeof resource.uri !== "string" ||
      !resource.uri ||
      uris.has(resource.uri) ||
      typeof resource.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(resource.digest) ||
      typeof resource.size !== "number" ||
      !Number.isSafeInteger(resource.size) ||
      resource.size < 0
    )
      return false;
    uris.add(resource.uri);
    bytes += resource.size;
    if (bytes > MAX_SKILL_BYTES) return false;
  }
  return uris.has(value.uri);
}

function completeSkillResult(value: unknown): value is Record<string, unknown> {
  // The modern SDK codec rejects non-complete wire results and removes
  // resultType before invoking an explicit result schema.
  return (
    skillObject(value) &&
    typeof value.ttlMs === "number" &&
    Number.isSafeInteger(value.ttlMs) &&
    value.ttlMs >= 0 &&
    (value.cacheScope === "public" || value.cacheScope === "private")
  );
}

interface SkillPage {
  skills: ConnectorSkill[];
  nextCursor?: string;
  bytes: number;
}

const SkillPageSchema: StandardSchemaV1<unknown, SkillPage> = {
  "~standard": {
    version: 1,
    vendor: "connecta",
    validate(value) {
      if (
        !completeSkillResult(value) ||
        !Array.isArray(value.skills) ||
        value.skills.length > MAX_SKILLS ||
        !value.skills.every(validSkill) ||
        (value.nextCursor !== undefined && typeof value.nextCursor !== "string")
      ) {
        return { issues: [{ message: "Invalid or incomplete Skills listing." }] };
      }
      const bytes = skillJsonBytes(value);
      if (bytes > MAX_SERIALIZED_CATALOG_BYTES)
        return { issues: [{ message: "Skills listing exceeds the byte limit." }] };
      return {
        value: {
          skills: value.skills,
          bytes,
          ...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}),
        },
      };
    },
  },
};

function skillReadSchema(uri: string): StandardSchemaV1<unknown, ConnectorSkillResourceContents[]> {
  return {
    "~standard": {
      version: 1,
      vendor: "connecta",
      validate(value) {
        if (
          !completeSkillResult(value) ||
          !Array.isArray(value.contents) ||
          value.contents.length !== 1 ||
          skillJsonBytes(value) > MAX_SKILL_READ_RPC_BYTES
        ) {
          return { issues: [{ message: "Invalid or incomplete skill resource response." }] };
        }
        const content: unknown = value.contents[0];
        if (
          !skillObject(content) ||
          content.uri !== uri ||
          (content.mimeType !== undefined && typeof content.mimeType !== "string")
        ) {
          return { issues: [{ message: "Unexpected skill resource contents." }] };
        }
        const mimeType = typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {};
        if (typeof content.text === "string" && !("blob" in content) && utf8Length(content.text) <= MAX_SKILL_BYTES) {
          return { value: [{ uri, ...mimeType, text: content.text }] };
        }
        if (
          typeof content.blob === "string" &&
          !("text" in content) &&
          content.blob.length % 4 === 0 &&
          !/[^A-Za-z0-9+/]/.test(content.blob.replace(/={1,2}$/, ""))
        ) {
          const bytes =
            (content.blob.length / 4) * 3 - (content.blob.endsWith("==") ? 2 : content.blob.endsWith("=") ? 1 : 0);
          if (bytes <= MAX_SKILL_BYTES) return { value: [{ uri, ...mimeType, blob: content.blob }] };
        }
        return { issues: [{ message: "Invalid or oversized skill resource bytes." }] };
      },
    },
  };
}

/** Bound the body before SDK consumption, including its detached SSE reader. */
export async function boundedSkillResponse(
  response: Response,
  limit: number,
  rpcId: unknown,
  signal?: AbortSignal | null,
): Promise<Response> {
  const exceeded = () =>
    new ConnectorCallError("connector_call_failed", "Downstream Skills response exceeds the RPC byte limit.");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel().catch(() => {});
    throw exceeded();
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let buffer: Uint8Array | undefined;
  let buffered = 0;
  const sse = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
  // Decode an entire SSE message once. Its byte buffer has no per-chunk or
  // per-line objects, and preserves embedded resource BOMs on workerd too.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });
  let data = new Uint8Array(0);
  let dataBytes = 0;
  let hasData = false;
  const newline = new Uint8Array([10]);
  const field = [100, 97, 116, 97, 58]; // data:
  const bom = [239, 187, 191];
  let bomOffset = 0;
  let fieldOffset = 0;
  // 0: field prefix, 1: optional value space, 2: data value, 3: ignored line.
  let state = 0;
  let lineBytes = false;
  let skipLf = false;
  const append = (value: Uint8Array) => {
    const needed = dataBytes + value.byteLength;
    if (needed > limit) throw exceeded();
    if (needed > data.length) {
      const next = new Uint8Array(Math.min(limit, Math.max(65_536, needed, data.length * 2)));
      next.set(data.subarray(0, dataBytes));
      data = next;
    }
    data.set(value, dataBytes);
    dataBytes = needed;
  };
  const beginData = () => {
    if (hasData) append(newline);
    hasData = true;
  };
  const consume = (chunk: Uint8Array): string | undefined => {
    for (let offset = 0; offset < chunk.length;) {
      const byte = chunk[offset]!;
      if (skipLf) {
        skipLf = false;
        if (byte === 10) {
          offset++;
          continue;
        }
      }
      // Strip exactly one initial UTF-8 BOM, even across single-byte chunks.
      if (bomOffset >= 0) {
        if (byte === bom[bomOffset]) {
          if (++bomOffset === bom.length) bomOffset = -1;
          offset++;
          continue;
        }
        if (bomOffset) {
          lineBytes = true;
          state = 3;
        }
        bomOffset = -1;
      }
      if (byte === 10 || byte === 13) {
        if (lineBytes) {
          if (state === 0 && fieldOffset === 4) beginData();
        } else {
          const json = hasData && dataBytes ? decoder.decode(data.subarray(0, dataBytes)) : "";
          dataBytes = 0;
          hasData = false;
          if (json) {
            const message: unknown = JSON.parse(json);
            if (skillObject(message) && message.id === rpcId && ("result" in message || "error" in message)) {
              data = new Uint8Array(0);
              return json;
            }
          }
        }
        state = 0;
        fieldOffset = 0;
        lineBytes = false;
        skipLf = byte === 13;
        offset++;
        continue;
      }
      lineBytes = true;
      if (state === 0) {
        if (byte === field[fieldOffset]) {
          if (++fieldOffset === field.length) {
            beginData();
            state = 1;
          }
        } else state = 3;
        offset++;
        continue;
      }
      if (state === 1) {
        state = 2;
        if (byte === 32) {
          offset++;
          continue;
        }
      }
      let end = offset;
      while (end < chunk.length && chunk[end] !== 13 && chunk[end] !== 10) end++;
      if (state === 2) append(chunk.subarray(offset, end));
      offset = end;
    }
  };
  const terminalResponse = async (json: string) => {
    // The SDK's detached SSE consumer does not settle body-read errors. Hand
    // it the bounded terminal answer and close a server-kept-open stream.
    await reader.cancel().catch(() => {});
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    return new Response(json, { status: response.status, statusText: response.statusText, headers });
  };
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw exceeded();
      if (!sse) {
        // Network chunk count and backing-buffer size are untrusted. Retain
        // only owned fixed-size blocks, never one object per incoming byte.
        for (let offset = 0; offset < chunk.value.byteLength;) {
          buffer ??= new Uint8Array(65_536);
          const size = Math.min(buffer.length - buffered, chunk.value.byteLength - offset);
          buffer.set(chunk.value.subarray(offset, offset + size), buffered);
          offset += size;
          buffered += size;
          if (buffered === buffer.length) {
            chunks.push(buffer);
            buffer = undefined;
            buffered = 0;
          }
        }
        continue;
      }
      const terminal = consume(chunk.value);
      if (terminal !== undefined) return await terminalResponse(terminal);
    }
    if (sse)
      throw new ConnectorCallError(
        "connector_call_failed",
        "Downstream Skills stream ended without a terminal RPC response.",
      );
    if (buffer && buffered) chunks.push(buffer.subarray(0, buffered));
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** One connector's Skills and resource read operations. */
export function remoteMcpResources(
  rt: RemoteMcpRuntime,
): Pick<RemoteMcpShared, "listSkills" | "readSkill" | "readResourceOperation" | "resourceTemplateRefusals"> {
  const { id } = rt;
  const resourceTemplateRefusals = new Set<ResourceTemplateRefusal>();
  const skillScopeOpen = (ctx: ConnectorContext, state: ConnectionState) => {
    if (rt.isClosed(state)) throw rt.scopeEndedError();
    if (ctx.signal?.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : rt.scopeEndedError();
  };

  const withSkillsClient = authMethod(
    <T>(
      ctx: ConnectorContext,
      method: "skills/list" | "resources/read",
      run: (client: Client, state: ConnectionState) => Promise<T>,
    ) =>
      authFlow<T>(function* () {
        const state = rt.stateFor(ctx);
        const client = (yield authCall(rt.ensureConnected, [ctx, state])) as Client;
        try {
          skillScopeOpen(ctx, state);
          const capabilities = client.getServerCapabilities();
          const extension = capabilities?.extensions?.[SKILLS_EXTENSION];
          if (
            client.getProtocolEra() !== "modern" ||
            !skillObject(capabilities?.resources) ||
            !skillObject(extension) ||
            (extension.directoryRead !== undefined && typeof extension.directoryRead !== "boolean")
          ) {
            throw new ConnectorCallError(
              "connector_call_failed",
              "The downstream did not declare a valid Skills extension and resources capability.",
            );
          }
          const result = (yield authCall(run, [client, state])) as Awaited<T>;
          skillScopeOpen(ctx, state);
          return result;
        } catch (error) {
          if (ownAbortReason(error, [ctx.signal]) && !hasSdkPayload(error)) throw error;
          const classified = rt.atMcpBoundary(ctx, error, method, client.transport, [ctx.signal]);
          if (requiresAuthorization(classified) && state.client === client) state.authRequired = true;
          throw carryFailureFacts(classified, withheldAs(`Connector "${id}" downstream ${method} failed.`, classified));
        }
      }),
  );

  const listSkills = authMethod(
    (ctx: ConnectorContext) =>
      authCall(withSkillsClient, [
        ctx,
        "skills/list",
        authMethod((client: Client, state: ConnectionState) =>
          authFlow<ConnectorSkill[]>(function* () {
            const listed: ConnectorSkill[] = [];
            const uris = new Set<string>();
            const cursors = new Set<string>();
            let cursor: string | undefined;
            let bytes = 0;
            for (let page = 0; page < MAX_SKILLS; page++) {
              skillScopeOpen(ctx, state);
              const result = (yield authInvoke(client, "request", [
                { method: "skills/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
                SkillPageSchema,
                rt.requestOptions(ctx),
              ])) as SkillPage;
              bytes += result.bytes;
              if (bytes > MAX_SERIALIZED_CATALOG_BYTES || listed.length + result.skills.length > MAX_SKILLS) {
                throw new ConnectorCallError(
                  "connector_call_failed",
                  "Downstream Skills listing exceeds the aggregate limit.",
                );
              }
              for (const skill of result.skills) {
                if (uris.has(skill.uri))
                  throw new ConnectorCallError(
                    "connector_call_failed",
                    "Downstream Skills listing contains duplicate skill URIs.",
                  );
                uris.add(skill.uri);
                listed.push(skill);
              }
              if (result.nextCursor === undefined) return listed;
              if (!result.skills.length || cursors.has(result.nextCursor)) {
                throw new ConnectorCallError(
                  "connector_call_failed",
                  "Downstream Skills pagination loops or makes no progress.",
                );
              }
              cursors.add(result.nextCursor);
              cursor = result.nextCursor;
            }
            throw new ConnectorCallError("connector_call_failed", "Downstream Skills listing exceeds the page limit.");
          }),
        ),
      ]) as Effect.Effect<ConnectorSkill[], unknown>,
  );

  const readSkill = authMethod(
    (uri: string, ctx: ConnectorContext) =>
      authCall(withSkillsClient, [
        ctx,
        "resources/read",
        authMethod(
          (client: Client) =>
            authInvoke(client, "request", [
              { method: "resources/read", params: { uri } },
              skillReadSchema(uri),
              rt.requestOptions(ctx),
            ]) as Effect.Effect<ConnectorSkillResourceContents[], unknown>,
        ),
      ]) as Effect.Effect<ConnectorSkillResourceContents[], unknown>,
  );

  const readResourceOperation = authMethod((uri: string, ctx: ConnectorContext) =>
    authFlow<ReadResourceResult>(function* () {
      const state = rt.stateFor(ctx);
      const client = (yield authCall(rt.ensureConnected, [ctx, state])) as Client;
      try {
        const options = rt.requestOptions(ctx) ?? {};
        rt.listingContexts.set(options, ctx);
        try {
          if (!client.getServerCapabilities()?.resources) throw unadvertisedResource();
          const resources = (yield authInvoke(client, "listResources", [undefined, options])) as ListResourcesResult;
          const templates = (yield authInvoke(client, "listResourceTemplates", [
            undefined,
            options,
          ])) as ListResourceTemplatesResult;
          const exact = resources.resources.some(
            (resource: ListResourcesResult["resources"][number]) => resource.uri === uri,
          );
          if (!exact) {
            const match = resourceUriMatchesTemplates(
              uri,
              templates.resourceTemplates,
              (code: ResourceTemplateRefusal) => resourceTemplateRefusals.add(code),
            );
            if (!match.matched) {
              if (match.refusal)
                throw new ConnectorCallError(
                  match.refusal,
                  match.refusal === "resource_template_ambiguous"
                    ? "The advertised resource templates have ambiguous expression boundaries."
                    : "Resource template matching exceeds the read work limit.",
                  { retryable: false },
                );
              throw unadvertisedResource();
            }
          }
        } catch (err) {
          throw rt.atMcpBoundary(ctx, err, "resources/read", client.transport, [ctx.signal]);
        } finally {
          rt.listingContexts.delete(options);
        }
        const result = (yield authCatch(
          authInvoke(client, "readResource", [
            { uri },
            {
              ...rt.requestOptions(ctx),
              cacheMode: "bypass",
              allowInputRequired: true,
            },
          ]),
          (err: unknown) => {
            if (err instanceof ResourceNotFoundError) {
              throw new ConnectorCallError("not_found", "The downstream resource does not exist.");
            }
            throw rt.atMcpBoundary(ctx, err, "resources/read", client.transport, [ctx.signal]);
          },
        )) as ReadResourceResult;
        if (isInputRequiredResult(result)) {
          throw new ConnectorCallError(
            "input_required_unsupported",
            "Resource reads inside programs cannot request mid-call input.",
          );
        }
        return result;
      } catch (err) {
        if (ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err)) throw err;
        if (requiresAuthorization(err)) {
          if (state.client === client) state.authRequired = true;
          if (err instanceof UnauthorizedError) throw carryFailureFacts(err, rt.authRequiredError(ctx));
        }
        throw downstreamCallError(err, undefined, undefined, undefined, requestSentSecrets(ctx));
      }
    }),
  );
  return { listSkills, readSkill, readResourceOperation, resourceTemplateRefusals };
}
