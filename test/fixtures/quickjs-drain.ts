// Run in a watched process: a broken drain can starve this event loop's timers.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";
import { executeQuickJs } from "../../src/executors/quickjs-runtime.js";

const QuickJS = await getQuickJS();
const newContext = QuickJS.newContext.bind(QuickJS);
let context: QuickJSContext | undefined;
QuickJS.newContext = (...args) => {
  context = newContext(...args);
  return context;
};

let releaseFirst!: (value: number) => void;
let releaseSecond!: (value: number) => void;
const first = new Promise<number>((resolve) => { releaseFirst = resolve; });
const second = new Promise<number>((resolve) => { releaseSecond = resolve; });
let started!: () => void;
const bothStarted = new Promise<void>((resolve) => { started = resolve; });
let calls = 0;
const hostCall = (promise: Promise<number>) => {
  if (++calls === 2) started();
  return promise;
};

// Expire only after both host calls start; subprocess startup and WASM loading
// consume no deadline. setImmediate remains real so each release lets the
// bridge and drain run before the next assertion.
mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
const pending = executeQuickJs(
  "async () => Promise.all([slow.a(), slow.b()])",
  [{ name: "slow", fns: { a: () => hostCall(first), b: () => hostCall(second) } }],
  {
    timeoutMs: 50,
    cpuTimeMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxStackSizeBytes: 1024 * 1024,
  },
);
await bothStarted;
mock.timers.tick(50);
assert.deepEqual(await pending, {
  result: undefined,
  error: "Execution timed out after 50ms.",
  timedOut: true,
});
mock.timers.reset();
assert.ok(context);
assert.equal(context.alive, true, "the pending calls retain the context");

releaseFirst(1);
await setImmediate();
assert.equal(context.alive, true, "the second call still retains the context");
releaseSecond(2);
await setImmediate();
assert.equal(context.alive, false, "the drain disposes after the last call settles");
console.log("drain completed after separate releases");
