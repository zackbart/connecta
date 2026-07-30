// Gate-server lifecycle, shared by the runner and the fixture verifier. One
// process per sample is the isolation guarantee, so starting and stopping it
// reliably is load-bearing rather than plumbing.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const ARMS = {
  code: { executor: "enabled", control: false },
  classic: { executor: "disabled", control: true },
};

/** Start one gate server on an ephemeral port; resolve when it reports ready. */
export function startGateServer({ arm, token, sourceCommit }) {
  const configuration = ARMS[arm];
  if (!configuration) {
    throw new Error(`Unknown arm "${arm}". Choose code and/or classic.`);
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
        CONNECTA_GATE_SOURCE_COMMIT: sourceCommit,
        CONNECTA_GATE_EXECUTOR: configuration.executor,
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
 * Read the connecta activity events this deployment recorded. Payload-free by
 * construction — the event type has nowhere to put arguments, results, or code.
 */
export async function readActivity(activityUrl, token) {
  const response = await fetch(activityUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Activity read failed with HTTP ${response.status}.`);
  }
  const body = await response.json();
  if (!Array.isArray(body?.events)) {
    throw new Error("Activity response did not contain an events array.");
  }
  return { events: body.events, rollbacks: body.rollbacks ?? 0 };
}
