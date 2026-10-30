/**
 * Every `connecta.<name>` function a guest program can reach, in one list.
 *
 * Guest-safe data only: no host implementation, no imports. The guest runtime
 * builds its namespace from it, execute.ts admits each host call by its budget
 * class and binds it by name to an implementation typed against this list, and
 * the execute_code description's compact declaration is joined from it.
 * `GuestApi` in guest-types.ts stays the published type; the package-surface
 * test compiles the joined declaration against it.
 */
export const GUEST_FUNCTIONS = [
  /** Searches the catalog and returns one flat page of `{ tools }`. */
  {
    name: "search",
    budget: "hostCall",
    declaration:
      "search(args?: { query?: string; connector?: string; limit?: number; offset?: number; includeSchemas?: Schemas }): Promise<{ tools: Tool[]; catalogErrors: { connector: string; code: string; message: string }[]; hasMore: boolean; nextOffset?: number }>;",
  },
  /** Describes exact addresses, one entry per address in order. */
  {
    name: "describe",
    budget: "hostCall",
    declaration:
      "describe(args?: { address?: string; addresses?: string[]; format?: Schemas }): Promise<{ tools: (Tool & { error?: string })[] }>;",
  },
  /** Calls one tool and inlines transfer pages and native content. */
  {
    name: "call",
    budget: "hostCall",
    wrapped: true,
    declaration: "call(address: string, args?: unknown, options?: { timeoutMs?: number }): Promise<Result>;",
  },
  /** Reads one advertised resource URI. */
  {
    name: "read",
    budget: "hostCall",
    declaration: "read(uri: string): Promise<{ contents: { uri: string; text?: string; blob?: string }[] }>;",
  },
  /** Pages a retained result by page or UTF-8 byte offset. */
  {
    name: "result",
    budget: "hostCall",
    deadline: "result storage",
    declaration:
      "result(id: string | Paged, options?: { page?: number; offset?: number; maxBytes?: number }): Promise<{ text: string; hasMore: boolean; nextOffset?: number }>;",
  },
  /** Fetches a skill's text by exact name. */
  {
    name: "skill",
    budget: "hostCall",
    deadline: "skill lookup",
    alias: { name: "skills", note: "models write connecta.skills, the top-level tool's name." },
    declaration: "skill(name: string): Promise<{ text: string }>;",
  },
  /** Forwards a content block to the client; needs no await. */
  {
    name: "emit",
    budget: "emission",
    declaration: "emit(block: Block | Native | Exclude<Result, Paged>): PromiseLike<void>;",
  },
  /** Tells the host a failed program read a result field off an unawaited call. */
  {
    name: "unawaited",
    budget: "once",
    label: "missing-await notice",
  },
] as const satisfies readonly GuestFunction[];

/**
 * One guest function, under a one-line JSDoc purpose that
 * documentation/code-mode.md's contributor table repeats. `budget` is how the
 * host admits each call before its implementation runs, and it fixes the
 * wrapper the guest runtime installs.
 */
type GuestFunction =
  | (GuestFunctionBase & {
      /**
       * Spends one host call on entry (M7, L4). Returns a Promise whose result
       * fields mark an unawaited read (#1191).
       */
      budget: "hostCall";
      /** Wrap the runtime's local function of this name instead of `provider.<name>`. */
      wrapped?: true;
      /** Bounded by hostCallTimeoutMs; a timeout names this starting stage. */
      deadline?: string;
      /** A second, undeclared namespace name for the same function. */
      alias?: { name: string; note: string };
      declaration: string;
    })
  | (GuestFunctionBase & {
      /**
       * Spends no host call; the emission collector and an attempt cap bound it.
       * Returns a tracked thenable whose unhandled rejection fails the run.
       */
      budget: "emission";
      declaration: string;
    })
  | (GuestFunctionBase & {
      /**
       * Spends no host call; the first call per run is accepted and a second
       * ends the run. Called only by the runtime, never on the namespace.
       */
      budget: "once";
      /** Names the bound in the run-ending refusal. */
      label: string;
    });

interface GuestFunctionBase {
  /** `connecta.<name>` in the guest and the provider function the host binds. */
  name: string;
}

export type GuestFunctionSpec = (typeof GUEST_FUNCTIONS)[number];

/** Public guest functions that spend no host call, for the agent-facing text. */
export const UNCOUNTED_GUEST_FUNCTIONS = GUEST_FUNCTIONS.filter((fn) => fn.budget === "emission")
  .map((fn) => fn.name)
  .join(" and ");

/**
 * The guest API as the execute_code description shows it: compact shapes of
 * GuestApi in src/guest-types.ts, checked against it by the package-surface
 * declaration test. Arguments match what GuestApi accepts in both directions,
 * results are supertypes of its results, and no field is invented. Type notation, not runnable JS.
 */
export const GUEST_API_DECLARATION = `declare const connecta: {
${GUEST_FUNCTIONS.flatMap((fn) => ("declaration" in fn ? [fn.declaration] : [])).join("\n")}
};
type Schemas = "json" | "compact" | "typescript";
type Tool = { address: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; signature?: string };
type Paged = { format: "paged"; valueFormat: "json" | "text"; resultId?: string; totalBytes: number; truncated: true; hint: string };
type Result = ({ format: "json"; data: unknown } | { format: "text"; data: string } | Paged) & { content?: Native[] };
type Block = { type: "text"; text: string } | { type: "image" | "audio"; data: string; mimeType: string };
type Native = Block | { type: "resource"; resource: { uri: string } & ({ text: string } | { blob: string }) } | { type: "resource_link"; uri: string; name: string };`;
