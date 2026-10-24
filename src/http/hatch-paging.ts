// Internal opt-in adapters for the standard hatch. No maintained provider opts
// in until its separate step-2 migration. Inputs have crossed connection safety.
import { ConnectorCallError } from "../errors.js";

export interface HatchPageAdapter {
  readonly param: string;
  readonly in: "query" | "body";
  readonly headers?: readonly string[];
  /** Validate and restore a decoded cursor's vendor type before index.check. */
  readonly decode: (cursor: string) => string | number;
  /** undefined: no paging metadata; null: last page; a scalar: next vendor cursor. */
  readonly next: (
    data: unknown,
    call: {
      readonly path: string;
      readonly query: Readonly<Record<string, unknown>>;
      readonly headers: Readonly<Record<string, string>>;
    },
  ) => string | number | null | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bad(): never {
  throw new ConnectorCallError("connector_call_failed", "The vendor returned invalid paging metadata.", {
    retryable: false,
  });
}

function integer(cursor: string): number {
  const value = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(value) || value < 1) {
    throw new ConnectorCallError("invalid_args", "This paging cursor contains no valid page number.");
  }
  return value;
}

/** Stripe forward lists: never infer another page from a full result. */
export const stripePage: HatchPageAdapter = {
  param: "starting_after",
  in: "query",
  decode: (cursor) => cursor,
  next(data) {
    const body = record(data);
    if (body["has_more"] === undefined) return undefined;
    if (body["has_more"] === false) return null;
    if (body["has_more"] !== true || !Array.isArray(body["data"])) return bad();
    const id = record(body["data"].at(-1))["id"];
    return typeof id === "string" && id ? id : bad();
  },
};

/** Cloudflare page-number lists; preserve result_info until the adapter runs. */
export const cloudflarePage: HatchPageAdapter = {
  param: "page",
  in: "query",
  decode: integer,
  next(data) {
    const info = record(record(data)["result_info"]);
    if (Object.keys(info).length === 0) return undefined;
    const page = info["page"];
    const total = info["total_pages"];
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(total) || (page as number) < 1 || (total as number) < 0)
      return bad();
    return (page as number) < (total as number) ? (page as number) + 1 : null;
  },
};

/** Vercel's pagination.next is sent back as until, as a timestamp or token. */
export const vercelPage: HatchPageAdapter = {
  param: "until",
  in: "query",
  decode: (cursor) => {
    if (!/^\d+$/.test(cursor)) return cursor;
    const value = Number(cursor);
    if (!Number.isSafeInteger(value)) {
      throw new ConnectorCallError("invalid_args", "This paging cursor contains no valid timestamp.");
    }
    return value;
  },
  next(data) {
    const pagination = record(record(data)["pagination"]);
    if (!Object.hasOwn(pagination, "next")) return undefined;
    const next = pagination["next"];
    if (next === null) return null;
    if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) return next;
    return typeof next === "string" && next ? next : bad();
  },
};

/** GitHub Link: extract only page, from the same endpoint and unchanged filters. */
export function githubPage(baseUrl: string): HatchPageAdapter {
  const base = new URL(baseUrl.replace(/\/+$/, "") + "/");
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("GitHub hatch paging needs a confined API base URL.");
  }
  return {
    param: "page",
    in: "query",
    headers: ["link"],
    decode: integer,
    next(_data, call) {
      const header = call.headers["link"];
      if (!header) return null;
      const links = [...header.matchAll(/<([^<>]+)>([^<>]*)/g)].filter((match) =>
        /;\s*rel\s*=\s*"([^"]*)"/i.exec(match[2]!)?.[1]?.split(/\s+/).includes("next"),
      );
      if (links.length === 0) return null;
      if (links.length !== 1) return bad();
      const target = new URL(call.path.replace(/^\//, ""), base);
      let next: URL;
      try {
        next = new URL(links[0]![1]!, target);
      } catch {
        return bad();
      }
      if (
        next.origin !== target.origin ||
        next.pathname !== target.pathname ||
        next.username ||
        next.password ||
        next.hash
      )
        return bad();
      // The link cannot silently change a filter or add another parameter.
      const expected = new URLSearchParams();
      for (const [name, value] of Object.entries(call.query)) {
        if (name === "page" || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) expected.append(name, String(item));
      }
      const actual = new URLSearchParams(next.search);
      const pages = actual.getAll("page");
      actual.delete("page");
      expected.sort();
      actual.sort();
      if (expected.toString() !== actual.toString() || pages.length !== 1) return bad();
      try {
        return integer(pages[0]!);
      } catch {
        return bad();
      }
    },
  };
}
