// Gate-server lifecycle, shared by the runner and the fixture verifier. One
// process per sample is the isolation guarantee, so starting and stopping it
// reliably is load-bearing rather than plumbing.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The three surfaces, each an ordinary connecta deployment shape since #224.
 * `classic` is the control. `classic-plus-code` is the ten-tool deployment and
 * answers only "does adding execute_code help or hurt?" — it is reported and
 * never gates the verdict. `code-first` is the seven-tool consolidated surface,
 * which is what a deployment with an executor now serves by default, and it is
 * the arm the verdict keys on.
 *
 * `folded` lists what a given arm's surface does not advertise. It used to be
 * an instruction to the harness ("hide these"); it is now a declaration about
 * the deployment, which the fixture verifier and the corpus checks read to know
 * which routes are impossible on which arm.
 */
export const ARMS = {
  classic: {
    executor: "disabled",
    surface: "classic",
    folded: [],
    role: "control",
    expectedToolCount: 9,
  },
  "classic-plus-code": {
    executor: "enabled",
    surface: "classic",
    folded: [],
    role: "incremental",
    expectedToolCount: 10,
  },
  "code-first": {
    executor: "enabled",
    surface: "code-first",
    folded: ["list_connectors", "describe_tools", "batch_call"],
    role: "candidate",
    expectedToolCount: 7,
  },
};

export const ARM_NAMES = Object.keys(ARMS);
export const CANDIDATE_ARM = "code-first";
export const CONTROL_ARM = "classic";

/**
 * The fixture catalogs, so the runner can reject a typo before spending and the
 * fixture verifier can walk every one of them. `gate-server.ts` owns the
 * authoritative list and refuses an unknown value on its own — this is the copy
 * the `.mjs` side can import, and `verify-fixtures.mjs` boots each name here plus
 * one that is not, so the two lists cannot drift apart quietly.
 */
export const CATALOGS = ["core", "wide"];
export const DEFAULT_CATALOG = "core";

/** Start one gate server on an ephemeral port; resolve when it reports ready. */
export function startGateServer({
  arm,
  token,
  activityToken,
  sourceCommit,
  catalog = DEFAULT_CATALOG,
  downstreamDelayMs = 0,
}) {
  const configuration = ARMS[arm];
  if (!configuration) {
    throw new Error(
      `Unknown arm "${arm}". Choose one or more of ${ARM_NAMES.join(", ")}.`,
    );
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(here, "gate-server.ts")],
    {
      cwd: here,
      env: {
        ...process.env,
        CONNECTA_GATE_PORT: "0",
        CONNECTA_GATE_TOKEN: token,
        CONNECTA_GATE_ACTIVITY_TOKEN: activityToken,
        CONNECTA_GATE_SOURCE_COMMIT: sourceCommit,
        CONNECTA_GATE_EXECUTOR: configuration.executor,
        CONNECTA_GATE_SURFACE: configuration.surface,
        CONNECTA_GATE_CATALOG: catalog,
        CONNECTA_GATE_DOWNSTREAM_DELAY_MS: String(downstreamDelayMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  let buffered = "";
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`Gate server timed out.\n${stderr}`));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(
        new Error(`Gate server exited before readiness (${code}).\n${stderr}`),
      );
    });
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.event === "ready") {
            clearTimeout(timer);
            resolveReady(message);
          }
        } catch {
          // Server output that is not the readiness line is not interesting.
        }
      }
    });
  });
  return { child, ready };
}

export async function stopGateServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

/**
 * Read the connecta activity events this deployment recorded, plus the fixtures'
 * own mutation counters. Payload-free by construction — the event type has
 * nowhere to put arguments, results, or code. Guarded by its own token, never the
 * MCP bearer: the agent under test holds that one, and an instrument the subject
 * can read is not an instrument.
 */
export async function readActivity(activityUrl, activityToken) {
  const response = await fetch(activityUrl, {
    headers: { Authorization: `Bearer ${activityToken}` },
  });
  if (!response.ok) {
    throw new Error(`Activity read failed with HTTP ${response.status}.`);
  }
  const body = await response.json();
  if (!Array.isArray(body?.events)) {
    throw new Error("Activity response did not contain an events array.");
  }
  return {
    events: body.events,
    mutations: body.mutations ?? { rollbacks: 0, purgeAttempts: 0 },
  };
}
