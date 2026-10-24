// Cloudflare's reviewed standard hatch binding; the kit owns discovery and admission.
import { Effect } from "effect";
import { ConnectorCallError } from "../../../errors.js";
import type { Connection } from "../../../http/vendor.js";
import type { HatchBinding, HatchDeclaration } from "../../../http/hatch.js";
import { cloudflarePage, type HatchPageAdapter } from "../../../http/hatch-paging.js";
import { cloudflareIndex, SAFETY, READ_POSTS, HEADERS, cloudflareRuntime, settings, record, invalid } from "../api.js";
import { withholdEmbeddedUrlsIn } from "../../_shared/rest/value-safety.js";
import type { CloudflareOptions } from "../index.js";

export const CLOUDFLARE_VERDICTS = Object.fromEntries(
  cloudflareIndex.ops.map((op) => [
    `${op.method} ${op.path}`,
    SAFETY.refusal(op.method, op.path) || op.server
      ? "refuse"
      : op.method === "GET" || READ_POSTS.some(([method, path]) => method === op.method && path === op.path)
        ? "read"
        : "destructive",
  ]),
) as HatchDeclaration["verdicts"];
const badPage = (message: string): never => {
  throw new ConnectorCallError("connector_call_failed", message, { retryable: false });
};
const tokenPage = (param: string): HatchPageAdapter => ({
  param,
  in: "query",
  decode: (value) =>
    typeof value === "string" && value ? value : invalid("This paging cursor contains no valid Cloudflare token."),
  next(data) {
    const info = record(record(data)["result_info"]);
    const value = info["cursor"] ?? record(info["cursors"])["after"];
    if (value === undefined && !("cursor" in info) && !("cursors" in info)) return undefined;
    if (info["is_truncated"] === false || info["is_truncated"] === "false") return null;
    if (value === null || value === undefined || value === "") {
      if (info["is_truncated"] === true || info["is_truncated"] === "true")
        badPage("Cloudflare reported another page without a cursor.");
      return null;
    }
    if (typeof value !== "string") return badPage("Cloudflare returned invalid cursor metadata.");
    if (withholdEmbeddedUrlsIn(value) !== value || /\[redacted\]/i.test(value)) return { hasMore: true };
    return value;
  },
});
export const CLOUDFLARE_PAGES = Object.fromEntries(
  cloudflareIndex.ops.flatMap((op) => {
    if (CLOUDFLARE_VERDICTS[`${op.method} ${op.path}`] !== "read") return [];
    const params = cloudflareIndex.contract(op).parameters.filter((p) => p.in === "query");
    const token = params.find((p) => p.name === "cursor" || p.name === "after");
    const adapter = token ? tokenPage(token.name) : params.some((p) => p.name === "page") ? cloudflarePage : undefined;
    return adapter ? [[`${op.method} ${op.path}`, adapter]] : [];
  }),
) as NonNullable<HatchDeclaration["pages"]>;
export const CLOUDFLARE_HEADERS = Object.fromEntries(
  Object.entries(HEADERS).map(([key, description]) => [
    key,
    {
      description,
      values:
        key === "cf-r2-jurisdiction"
          ? ["default", "eu", "us", "fedramp", "fedramp-high"]
          : ["Standard", "InfrequentAccess"],
    },
  ]),
);
export function cloudflareBinding({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<CloudflareOptions>;
}): HatchBinding {
  const runtime = cloudflareRuntime(connection, settings(options));
  return {
    review:
      "Cloudflare's indexed text, SQL, NDJSON and SCIM framing, closed R2 headers and configured defaults retain the same confined Connection, scoped admission and value safety.",
    allowOtherBodyTypes: true,
    path: runtime.fillDefaults,
    prepareBody: (body, op) =>
      runtime.scope({ method: op.method, path: op.path, op, params: {}, query: {}, body }).body,
    refuse: (call) => {
      runtime.scope(call);
      for (const parameter of cloudflareIndex.contract(call.op).parameters) {
        if (
          parameter.in !== "query" ||
          !["page", "per_page", "limit"].includes(parameter.name) ||
          !["integer", "number"].includes(String(parameter.schema.type))
        )
          continue;
        const value = call.query[parameter.name];
        if (value === undefined) continue;
        if (
          !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0) &&
          !(typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
        )
          invalid(`${parameter.name} must be a whole number within the operation's declared bounds.`);
      }
      const policy = SAFETY.refusal(call.method, call.op.path);
      if (policy) return policy;
      const type = cloudflareIndex.bodyType(call.op)?.toLowerCase() ?? "";
      if (/multipart|octet-stream|image\//.test(type))
        return "Use cloudflare_api_upload for this reviewed binary or multipart operation.";
      return SAFETY.refusal(call.method, call.op.path) ?? runtime.checkServer(call.op.server) ?? runtime.refuse(call);
    },
    send: (call) =>
      runtime.sendEnvelope(runtime.scope(call)).pipe(Effect.map(({ status, data }) => ({ status, data }))),
  };
}
