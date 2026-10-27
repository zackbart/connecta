// Internal opt-in adapters for the standard hatch. Inputs have crossed
// connection safety.
import { ConnectorCallError } from "../errors.js";

export interface HatchPageAdapter {
  readonly param: string;
  readonly in: "query" | "body";
  readonly headers?: readonly string[];
  /** Reviewed exact vendor count only; missing or invalid optional counts are omitted. */
  readonly total?: (data: unknown) => number | undefined;
  /** With a separate cursor, permit a first-request raw record id. Parameter-based
   * paging permits only a numeric timestamp anchor; opaque tokens stay signed. */
  readonly initialAnchor?: boolean;
  /** Opt-in repair guidance for unsigned first-page/raw vendor continuations. */
  readonly cursorInputMessage?: string;
  /** Preserve required protocol metadata in vendor field masks before dispatch. */
  readonly prepareQuery?: (query: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  /** Validate and restore a decoded cursor's vendor type before index.check. */
  readonly decode: (cursor: string | number) => string | number;
  /** undefined: no paging metadata; null: last page; a scalar: next vendor cursor;
   * { hasMore: true }: keep the data, but no continuation can be confined. */
  readonly next: (
    data: unknown,
    call: {
      readonly path: string;
      readonly query: Readonly<Record<string, unknown>>;
      readonly headers: Readonly<Record<string, string>>;
    },
  ) => string | number | null | undefined | { readonly hasMore: true };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bad(): never {
  throw new ConnectorCallError("connector_call_failed", "The vendor returned invalid paging metadata.", {
    retryable: false,
  });
}

function integer(cursor: string | number): number {
  const value = Number(cursor);
  if (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(value) || value < 1) {
    throw new ConnectorCallError("invalid_args", "This paging cursor contains no valid page number.");
  }
  return value;
}

/** Google list methods explicitly opt in; row count and resultSizeEstimate are irrelevant. */
export const googlePageToken: HatchPageAdapter = {
  param: "pageToken",
  in: "query",
  cursorInputMessage:
    "Omit pageToken on the first call; pass page.nextCursor unchanged as top-level cursor thereafter.",
  decode(cursor) {
    if (
      typeof cursor !== "string" ||
      !cursor.trim() ||
      /^[a-z][a-z0-9+.-]*:/i.test(cursor) ||
      [...cursor].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new ConnectorCallError("invalid_args", "This paging cursor contains no valid Google page token.");
    return cursor;
  },
  prepareQuery(query) {
    const mask = query["fields"];
    if (mask === undefined) return query;
    // Google's field-mask grammar includes balanced nested selectors. Restrict
    // to that grammar; no wild guessing after the vendor drops its token.
    if (typeof mask !== "string" || !mask || !/^[A-Za-z0-9_*/(),]+$/.test(mask))
      throw new ConnectorCallError(
        "invalid_args",
        "query.fields must be a Google field mask; omit it to read the full JSON response.",
      );
    const tokens = mask.match(/[A-Za-z_][A-Za-z0-9_]*|\*|[/(),]/g) ?? [];
    let depth = 0,
      hasToken = false,
      name = true,
      child = false,
      valid = tokens.join("") === mask;
    for (const [position, token] of tokens.entries()) {
      if (token === "(") {
        if (name || !child) valid = false;
        depth++;
        name = true;
        child = false;
      } else if (token === ")") {
        if (name || depth === 0) valid = false;
        depth--;
        name = false;
        child = false;
      } else if (token === ",") {
        if (name) valid = false;
        name = true;
        child = false;
      } else if (token === "/") {
        if (name || !child) valid = false;
        name = true;
        child = false;
      } else {
        if (
          depth === 0 &&
          (position === 0 || tokens[position - 1] === ",") &&
          token === "nextPageToken" &&
          (position === tokens.length - 1 || tokens[position + 1] === ",")
        )
          hasToken = true;
        if (!name) valid = false;
        name = false;
        child = true;
      }
    }
    if (!valid || name || depth !== 0)
      throw new ConnectorCallError("invalid_args", "query.fields has invalid selectors.");
    return hasToken ? query : { ...query, fields: `${mask},nextPageToken` };
  },
  next(data) {
    const token = record(data)["nextPageToken"];
    if (token === undefined || token === "") return null;
    if (typeof token !== "string") return bad();
    try {
      return googlePageToken.decode(token);
    } catch {
      return bad();
    }
  },
};

/** Stripe forward lists: never infer another page from a full result. */
export const stripePage: HatchPageAdapter = {
  param: "starting_after",
  in: "query",
  initialAnchor: true,
  decode: (cursor) => {
    if (typeof cursor !== "string" || !cursor) {
      throw new ConnectorCallError("invalid_args", "This paging cursor contains no valid item id.");
    }
    return cursor;
  },
  next(data) {
    const body = record(data);
    if (body["has_more"] === undefined) return undefined;
    if (body["has_more"] === false) return null;
    if (body["has_more"] !== true || !Array.isArray(body["data"])) return bad();
    const id = record(body["data"].at(-1))["id"];
    return typeof id === "string" && id ? id : bad();
  },
};

/** Stripe reverse lists use the first safe row as the ending_before anchor. */
export const stripeBackwardPage: HatchPageAdapter = {
  ...stripePage,
  param: "ending_before",
  next(data, call) {
    const body = record(data);
    return stripePage.next(Array.isArray(body["data"]) ? { ...body, data: [...body["data"]].reverse() } : data, call);
  },
};

/** Search cursors are vendor tokens, distinct from v1 list record-id anchors. */
export const stripeSearchPage: HatchPageAdapter = {
  param: "page",
  in: "query",
  decode: stripePage.decode,
  next(data) {
    const body = record(data);
    if (body["has_more"] === undefined) return undefined;
    if (body["has_more"] === false) return null;
    const next = body["next_page"];
    return body["has_more"] === true && typeof next === "string" && next ? next : bad();
  },
};

/** Extract only a v2 page token; every subsequent request retains its original path and filters. */
export const stripeV2Page: HatchPageAdapter = {
  param: "page",
  in: "query",
  decode: stripePage.decode,
  next(data, call) {
    const body = record(data);
    if (!Object.hasOwn(body, "next_page_url")) return undefined;
    if (body["next_page_url"] === null) return null;
    if (typeof body["next_page_url"] !== "string" || !body["next_page_url"]) return bad();
    let next: URL;
    try {
      next = new URL(body["next_page_url"], "https://api.stripe.com");
    } catch {
      return bad();
    }
    if (
      next.origin !== "https://api.stripe.com" ||
      next.pathname !== call.path ||
      next.username ||
      next.password ||
      next.hash
    )
      return bad();
    const pages = next.searchParams.getAll("page");
    if (pages.length !== 1 || !pages[0]) return bad();
    // URLs can omit filters: preserve them from the original call. Reject any
    // filter the URL does state unless it has exactly the original wire values.
    const expected = new URLSearchParams();
    for (const [name, value] of Object.entries(call.query)) {
      if (name === "page" || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!["string", "number", "boolean"].includes(typeof item)) return bad();
        expected.append(name, String(item));
      }
    }
    let extra = false;
    for (const name of new Set(next.searchParams.keys())) {
      if (name !== "page" && !expected.has(name)) {
        extra = true;
        continue;
      }
      if (
        name !== "page" &&
        JSON.stringify(next.searchParams.getAll(name).sort()) !== JSON.stringify(expected.getAll(name).sort())
      )
        return bad();
    }
    // A URL may echo vendor defaults absent from the original call. Keep the
    // fetched data, without minting a cursor that would silently drop them.
    return extra ? { hasMore: true } : pages[0];
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
    // Cursor-style result_info belongs to a separately declared token adapter.
    if (page === undefined) return undefined;
    if (!Number.isSafeInteger(page) || (page as number) < 1) return bad();
    const perPage = info["per_page"] ?? 0;
    const totalCount = info["total_count"];
    const count = info["count"] ?? 0;
    for (const value of [total, totalCount, perPage, count]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) return bad();
    }
    const hasMore =
      total !== undefined
        ? (page as number) < (total as number)
        : totalCount !== undefined
          ? (page as number) * (perPage as number) < (totalCount as number)
          : (perPage as number) > 0 && (count as number) >= (perPage as number);
    return hasMore ? (page as number) + 1 : null;
  },
};

/** Vercel's pagination.next is sent back as until, as a timestamp or token. */
export const vercelPage: HatchPageAdapter = {
  param: "until",
  in: "query",
  decode: (cursor) => {
    if ((typeof cursor === "number" && (!Number.isSafeInteger(cursor) || cursor < 0)) || cursor === "") {
      throw new ConnectorCallError("invalid_args", "This paging cursor contains no valid timestamp.");
    }
    return cursor;
  },
  next(data) {
    const pagination = record(record(data)["pagination"]);
    if (!Object.hasOwn(pagination, "next")) return undefined;
    const next = pagination["next"];
    if (next === null) return null;
    if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) return next;
    return typeof next === "string" && next && !/^[a-z][a-z0-9+.-]*:\/\//i.test(next) ? next : bad();
  },
};

/** GitHub Link: extract only page, from the same origin and unchanged filters. */
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
      const links = [...header.matchAll(/<([^<>]+)>([^<>]*)/g)].filter((match) => {
        const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(match[2]!);
        return (rel?.[1] ?? rel?.[2])?.split(/\s+/).includes("next");
      });
      if (links.length === 0) return null;
      if (links.length !== 1) return bad();
      const target = new URL(call.path.replace(/^\//, ""), base);
      let next: URL;
      try {
        next = new URL(links[0]![1]!, target);
      } catch {
        return bad();
      }
      if (next.origin !== target.origin || next.username || next.password || next.hash) return bad();
      // GitHub can replace /repos/owner/name with /repositories/id. Only the
      // page is extracted; the next request always keeps its original path.
      // Compare parsed wire values as multisets, preserving duplicate counts
      // while tolerating parameter order and equivalent URL encodings.
      const expected = new URLSearchParams();
      for (const [name, value] of Object.entries(call.query)) {
        if (name === "page" || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          if (
            typeof item !== "string" &&
            typeof item !== "boolean" &&
            !(typeof item === "number" && Number.isFinite(item))
          )
            return bad();
          expected.append(name, String(item));
        }
      }
      const actual = new URLSearchParams(next.search);
      const pages = actual.getAll("page");
      actual.delete("page");
      const ordered = (params: URLSearchParams) =>
        JSON.stringify(
          [...params].sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)),
        );
      if (ordered(expected) !== ordered(actual) || pages.length !== 1) return bad();
      try {
        return integer(pages[0]!);
      } catch {
        return bad();
      }
    },
  };
}
