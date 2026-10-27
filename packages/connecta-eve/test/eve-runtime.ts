import type { DynamicContext, DynamicInstructionsResult, DynamicSentinel } from "eve/instructions";

// Eve 0.84.0 is pinned exactly as a devDependency. These internals are not
// exported: resolve their files only in test support, never in shipped source.
const root = new URL("../../", import.meta.resolve("eve/connections"));
const { openMemos } = (await import(
  new URL("reactions/records.js", root).href
)) as typeof import("../node_modules/eve/dist/src/reactions/records.js");
const { connectionReaction } = (await import(
  new URL("reactions/kinds/connection.js", root).href
)) as typeof import("../node_modules/eve/dist/src/reactions/kinds/connection.js");
const { instructionsReaction } = (await import(
  new URL("reactions/kinds/instructions.js", root).href
)) as typeof import("../node_modules/eve/dist/src/reactions/kinds/instructions.js");
const { ContextContainer, contextStorage } = (await import(
  new URL("context/container.js", root).href
)) as typeof import("../node_modules/eve/dist/src/context/container.js");

let sessions = 0;
export function dynamicSession<T>(definition: DynamicSentinel<T>, kind: "connection" | "instructions") {
  const sessionId = `session_${++sessions}`;
  const ctx = new ContextContainer();
  const reaction = (kind === "connection" ? connectionReaction : instructionsReaction)({
    slug: "connecta",
    sourceId: `test:${kind}`,
    sourceKind: "module",
    logicalPath: `agent/${kind}/connecta.ts`,
    exportName: "default",
    evaluate: definition.evaluate,
  });
  let kept: ReturnType<ReturnType<typeof openMemos>["used"]> | undefined;
  return async (id: string | null, abortSignal = new AbortController().signal, frame: Partial<DynamicContext> = {}) => {
    const memos = openMemos({ scope: reaction.id, label: reaction.label, sessionId, abortSignal, kept });
    // Tests supply the public frame fields the selector reads; ctx and the
    // signal are stripped by Eve's real authoredEvaluate before calling it.
    const internal = {
      ...frame,
      session: { id: sessionId },
      turn: id === null ? null : { id, status: "running", input: [] },
      memo: memos.memo,
      abortSignal,
      ctx,
      history: undefined,
    } as Parameters<typeof reaction.evaluate>[0];
    try {
      // Eve's ContextContainer implements AlsContext at runtime; its declaration
      // exposes an optional-property mismatch under exactOptionalPropertyTypes.
      return await contextStorage.run(ctx as Parameters<typeof contextStorage.run>[0], async () => {
        const result = (await reaction.evaluate(internal)) as T;
        const contribution = await reaction.contribute(result, internal);
        kept = memos.used();
        return { result, contribution };
      });
    } finally {
      memos.close();
    }
  };
}

export function instructionSession(definition: DynamicSentinel<DynamicInstructionsResult>) {
  const evaluate = dynamicSession(definition, "instructions");
  return async (id: string | null, signal?: AbortSignal) => (await evaluate(id, signal)).result;
}
