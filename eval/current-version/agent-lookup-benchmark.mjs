import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getEncoding } from "js-tiktoken";

import { round } from "./audit-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function positiveIntegerOption(name, fallback) {
  const raw = option(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const outputPath = resolve(
  here,
  option("--output", "results/latest-main-agent-lookup.json"),
);
const reportPath = resolve(
  here,
  option("--report", "results/latest-main-agent-lookup.md"),
);
const selectedCase = option("--case", "all");
const repetitions = positiveIntegerOption("--repetitions", 2);
const concurrency = positiveIntegerOption("--concurrency", 2);
const tokenizerName =
  process.env.CONNECTA_EVAL_TOKENIZER ?? "o200k_base";
const tokenizer = getEncoding(tokenizerName);
const tokens = (value) =>
  tokenizer.encode(JSON.stringify(value) ?? "null").length;
const textTokens = (value) => tokenizer.encode(value).length;
const agentModel = process.env.CONNECTA_EVAL_AGENT_MODEL;
const bearer = "connecta-agent-lookup-eval-token";
const disabledHostFeatures = [
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "goals",
  "tool_suggest",
  "skill_search",
];
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const productDirty =
  execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "src",
      "package.json",
      "package-lock.json",
    ],
    { cwd: root, encoding: "utf8" },
  ).trim() !== "";
const discoveryCorpusText = await readFile(
  resolve(here, "discovery-holdout.json"),
  "utf8",
);
const discoveryCorpus = JSON.parse(discoveryCorpusText);
const harnessSha256 = sha256(
  await readFile(fileURLToPath(import.meta.url), "utf8"),
);
const corpusSha256 = sha256(discoveryCorpusText);
const sandboxSha256 = sha256(
  await readFile(resolve(here, "sandbox-server.ts"), "utf8"),
);
const knownConnectorIds = new Set([
  ...discoveryCorpus.connectors.map((connector) => connector.id),
  "controlled",
  "oauth-recoverable",
  "oauth-unavailable",
  "static-recoverable",
  "static-unavailable",
]);
const knownAddresses = discoveryCorpus.connectors.flatMap((connector) =>
  connector.tools.map((tool) => `${connector.id}.${tool.name}`),
);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function pressurePrompt(currentTask) {
  const actions = [
    "list project issues and pull requests",
    "send a message and inspect a thread",
    "download, upload, share, and move files",
    "create and update calendar events",
    "search contacts and list sales deals",
    "find and update document pages",
    "rerun builds and retrieve job logs",
    "create invoices and inspect account balances",
  ];
  const background = Array.from({ length: 128 }, (_, index) => {
    const action = actions[index % actions.length];
    return `Resolved background item ${String(index + 1).padStart(3, "0")} — archive only, do not act: a prior user asked to ${action}. Its outcome is complete and irrelevant to the current task.`;
  }).join("\n");
  return `You are continuing after a long integration-triage transcript.

Everything in RESOLVED BACKGROUND is historical context. Do not execute any of
it and do not let its repeated tool vocabulary replace the current task.

RESOLVED BACKGROUND
${background}
END RESOLVED BACKGROUND

CURRENT TASK
${currentTask}`;
}

const lookupCases = [
  {
    id: "open-issues-clean",
    family: "open-issues",
    context: "clean",
    prompt:
      "Use the available integrations once to list the open project issues. Return only the integration's JSON result.",
    expectedAddresses: ["projects.list_issues"],
    expectedRoute: "call_tool",
  },
  {
    id: "page-search-clean",
    family: "page-search",
    context: "clean",
    prompt:
      "Use the available integrations once to find the page that mentions our launch plan. Return only the integration's JSON result.",
    expectedAddresses: ["documents.search_content"],
    expectedRoute: "call_tool",
  },
  {
    id: "page-search-pressure",
    family: "page-search",
    context: "pressure",
    prompt: pressurePrompt(
      "Use the available integrations once to find the page that mentions our launch plan. Return only the integration's JSON result.",
    ),
    expectedAddresses: ["documents.search_content"],
    expectedRoute: "call_tool",
  },
  {
    id: "workflow-by-id-clean",
    family: "workflow-by-id",
    context: "clean",
    prompt:
      "Use the available integrations once to get the status and conclusion of workflow run 42. Return only the integration's JSON result.",
    expectedAddresses: ["builds.get_workflow_run"],
    expectedRoute: "call_tool",
  },
  {
    id: "build-diagnosis-clean",
    family: "build-diagnosis",
    context: "clean",
    prompt:
      "Use the available integrations to get both the failed workflow run and its job logs. Return only a JSON array containing the two integration results.",
    expectedAddresses: [
      "builds.get_workflow_run",
      "builds.get_job_logs",
    ],
    expectedRoute: "execute_code",
  },
  {
    id: "unsupported-audio-pressure",
    family: "unsupported-audio",
    context: "pressure",
    prompt: pressurePrompt(
      'Determine whether an available integration can transcribe an audio recording. Do not pretend one exists. Return only {"available":false} when none does.',
    ),
    expectedAddresses: [],
    expectedRoute: "search_only",
    finalCorrect(_fixture, finalText) {
      return parseJson(finalText)?.available === false;
    },
  },
];

function startServer() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "sandbox-server.ts"],
    {
      cwd: here,
      env: {
        ...process.env,
        CONNECTA_EVAL_PORT: "0",
        CONNECTA_EVAL_TOKEN: bearer,
        CONNECTA_EVAL_SOURCE_COMMIT: sourceCommit,
        CONNECTA_EVAL_EXECUTOR: "enabled",
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
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Agent lookup server timed out.\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Agent lookup server exited before readiness (${code}).\n${stderr}`,
        ),
      );
    });
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const message = parseJson(line);
        if (message?.event !== "ready") continue;
        clearTimeout(timeout);
        resolveReady(message);
      }
    });
  });
  return { child, ready };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

function structuredAgentResult(result) {
  if (!result || typeof result !== "object") return undefined;
  if (result.structured_content !== undefined) {
    return result.structured_content;
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? parseJson(text) : undefined;
}

function addressesFromSearch(value) {
  if (!Array.isArray(value?.connectors)) return [];
  return value.connectors.flatMap((connector) =>
    Array.isArray(connector.tools)
      ? connector.tools
          .map((tool) => tool.address)
          .filter((address) => typeof address === "string")
      : [],
  );
}

function filteredSearchValue(value, relevantSet) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const connectors = Array.isArray(value.connectors)
    ? value.connectors.flatMap((connector) => {
        const tools = Array.isArray(connector.tools)
          ? connector.tools.filter((tool) => relevantSet.has(tool.address))
          : [];
        return tools.length > 0 ? [{ ...connector, tools }] : [];
      })
    : [];
  const selected = connectors.reduce(
    (sum, connector) => sum + connector.tools.length,
    0,
  );
  return {
    ...value,
    connectors,
    total: selected,
    offset: 0,
    hasMore: false,
    ...("nextOffset" in value ? { nextOffset: undefined } : {}),
  };
}

function filteredAgentResult(result, filtered) {
  if (!result || typeof result !== "object") return result;
  const copy = { ...result };
  if ("structured_content" in copy) copy.structured_content = filtered;
  if ("structuredContent" in copy) copy.structuredContent = filtered;
  if (Array.isArray(copy.content)) {
    copy.content = copy.content.map((item) =>
      item?.type === "text"
        ? { ...item, text: JSON.stringify(filtered) }
        : item,
    );
  }
  return copy;
}

function sanitizedIdentifier(value) {
  let name = value.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(name)) name = `_${name}`;
  return name;
}

function codeCallsAddress(code, address) {
  const separator = address.indexOf(".");
  const connector = address.slice(0, separator);
  const tool = address.slice(separator + 1);
  const namespaceCall = `${sanitizedIdentifier(connector)}.${sanitizedIdentifier(tool)}(`;
  return (
    code.includes(namespaceCall) ||
    code.includes(`connecta.call("${address}"`) ||
    code.includes(`connecta.call('${address}'`)
  );
}

function executionAddresses(toolCalls, expectedAddresses) {
  return toolCalls.flatMap((call) => {
    if (
      call.tool === "call_tool" ||
      call.tool === "call_destructive_tool"
    ) {
      return typeof call.arguments?.address === "string"
        ? [call.arguments.address]
        : [];
    }
    if (call.tool === "batch_call" && Array.isArray(call.arguments?.calls)) {
      return call.arguments.calls
        .map((entry) => entry?.address)
        .filter((address) => typeof address === "string");
    }
    if (
      call.tool === "execute_code" &&
      typeof call.arguments?.code === "string"
    ) {
      const candidates = [...new Set([...knownAddresses, ...expectedAddresses])];
      return candidates.filter((address) =>
        codeCallsAddress(call.arguments.code, address),
      );
    }
    return [];
  });
}

function defaultFinalCorrect(fixture, finalText) {
  const parsed = parseJson(finalText);
  function containsResult(value, connector, tool) {
    if (Array.isArray(value)) {
      return value.some((entry) => containsResult(entry, connector, tool));
    }
    if (!value || typeof value !== "object") return false;
    if (value.connector === connector && value.tool === tool) return true;
    return Object.values(value).some((entry) =>
      containsResult(entry, connector, tool),
    );
  }
  return fixture.expectedAddresses.every((address) => {
    const [connector, tool] = address.split(".");
    return containsResult(parsed, connector, tool);
  });
}

function connectaRouteCorrect(fixture, toolCalls) {
  const called = toolCalls.map((call) => call.tool);
  const discoveryCorrect =
    called.filter((tool) => tool === "search_tools").length === 1 &&
    !called.includes("describe_tools") &&
    !called.includes("list_connectors");
  const execution = called.filter((tool) =>
    [
      "call_tool",
      "batch_call",
      "execute_code",
      "call_destructive_tool",
    ].includes(tool),
  );
  if (fixture.expectedRoute === "search_only") {
    return discoveryCorrect && execution.length === 0;
  }
  return (
    discoveryCorrect &&
    execution.length === 1 &&
    execution[0] === fixture.expectedRoute
  );
}

async function runAgent(fixture, url, repetition) {
  const commandArgs = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    "/tmp",
    "--config",
    `mcp_servers.connecta.url="${url}"`,
    "--config",
    'mcp_servers.connecta.bearer_token_env_var="CONNECTA_EVAL_TOKEN"',
    "--config",
    'approval_policy="never"',
    ...disabledHostFeatures.flatMap((feature) => [
      "--disable",
      feature,
    ]),
    ...(agentModel ? ["--model", agentModel] : []),
    fixture.prompt,
  ];
  const started = performance.now();
  const child = spawn("codex", commandArgs, {
    cwd: root,
    env: {
      ...process.env,
      CONNECTA_EVAL_TOKEN: bearer,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  let buffered = "";
  let finalText = "";
  let usage = {};
  const toolCalls = [];
  const nonMcpActions = [];
  const startedItems = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const event = parseJson(line);
      if (!event) continue;
      if (event.type === "item.started") {
        startedItems.set(event.item?.id, performance.now());
      }
      if (event.type === "item.completed") {
        const item = event.item ?? {};
        const itemStarted = startedItems.get(item.id);
        if (item.type === "mcp_tool_call") {
          const resultTokens = tokens(item.result ?? null);
          const call = {
            server: item.server ?? null,
            tool: item.tool,
            arguments: item.arguments,
            status: item.status,
            error: item.error ?? null,
            durationMs:
              itemStarted === undefined
                ? null
                : round(performance.now() - itemStarted, 1),
            resultBytes: Buffer.byteLength(
              JSON.stringify(item.result ?? null),
            ),
            resultTokens,
          };
          if (item.tool === "search_tools") {
            const value = structuredAgentResult(item.result);
            const addresses = addressesFromSearch(value);
            const relevantSet = new Set(fixture.expectedAddresses);
            const relevantRanks = fixture.expectedAddresses.map((address) => {
              const index = addresses.indexOf(address);
              return index < 0 ? null : index + 1;
            });
            const relevantReturned = addresses.filter((address) =>
              relevantSet.has(address),
            ).length;
            const filtered = filteredSearchValue(value, relevantSet);
            const minimalRelevantResultTokens = tokens(
              filteredAgentResult(item.result, filtered),
            );
            call.search = {
              query: item.arguments?.query ?? "",
              connector: item.arguments?.connector ?? null,
              includeSchemas: item.arguments?.includeSchemas ?? null,
              matchMode: value?.matchMode ?? "all",
              returned: addresses.length,
              total:
                typeof value?.total === "number"
                  ? value.total
                  : addresses.length,
              addresses,
              relevantRanks,
              relevantReturned,
              top1Relevant:
                addresses.length > 0 && relevantSet.has(addresses[0]),
              precision:
                addresses.length === 0
                  ? fixture.expectedAddresses.length === 0
                    ? 1
                    : 0
                  : round(relevantReturned / addresses.length, 3),
              irrelevantCandidates: addresses.length - relevantReturned,
              minimalRelevantResultTokens,
              estimatedNoiseTokens: Math.max(
                0,
                resultTokens - minimalRelevantResultTokens,
              ),
            };
          }
          toolCalls.push(call);
        } else if (item.type === "agent_message") {
          finalText = item.text ?? "";
        } else {
          nonMcpActions.push({
            type: item.type ?? "unknown",
            status: item.status ?? null,
            command:
              typeof item.command === "string"
                ? item.command.slice(0, 500)
                : null,
          });
        }
      }
      if (event.type === "turn.completed") usage = event.usage ?? {};
    }
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(
        new Error(
          `Codex case "${fixture.id}" repetition ${repetition} timed out.`,
        ),
      );
    }, 240_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(
      `Codex exited with ${exitCode} for "${fixture.id}" repetition ${repetition}.\n${stderr}`,
    );
  }

  const connectaToolCalls = toolCalls.filter(
    (call) => call.server === "connecta",
  );
  const foreignToolCalls = toolCalls.filter(
    (call) => call.server !== "connecta",
  );
  const expected = [...fixture.expectedAddresses].sort();
  const executed = executionAddresses(
    connectaToolCalls.filter((call) => call.status === "completed"),
    fixture.expectedAddresses,
  ).sort();
  const addressAccurate =
    expected.length === executed.length &&
    expected.every((address, index) => address === executed[index]);
  const finalCorrect = (fixture.finalCorrect ?? defaultFinalCorrect)(
    fixture,
    finalText,
  );
  const routingResultCorrect = addressAccurate && finalCorrect;
  const searchCalls = connectaToolCalls.filter(
    (call) => call.tool === "search_tools",
  );
  const firstDirectSearch = searchCalls[0]?.search;
  const firstRelevantRanks = firstDirectSearch?.relevantRanks ?? [];
  const directRetrievalTop1 =
    fixture.expectedAddresses.length === 0
      ? null
      : firstDirectSearch?.top1Relevant === true;
  const directRetrievalRecall =
    fixture.expectedAddresses.length === 0
      ? null
      : round(
          firstRelevantRanks.filter((rank) => rank !== null).length /
            fixture.expectedAddresses.length,
          3,
        );
  const directRetrievalMrr =
    fixture.expectedAddresses.length === 0
      ? null
      : round(
          firstRelevantRanks.reduce(
            (sum, rank) => sum + (rank === null ? 0 : 1 / rank),
            0,
          ) / fixture.expectedAddresses.length,
          3,
        );
  const directNegativeClean =
    fixture.expectedAddresses.length > 0
      ? null
      : firstDirectSearch !== undefined &&
        firstDirectSearch.returned === 0;
  const searchResultTokens = searchCalls.reduce(
    (sum, call) => sum + call.resultTokens,
    0,
  );
  const searchReturned = searchCalls.reduce(
    (sum, call) => sum + (call.search?.returned ?? 0),
    0,
  );
  const searchRelevantReturned = searchCalls.reduce(
    (sum, call) => sum + (call.search?.relevantReturned ?? 0),
    0,
  );
  const searchIrrelevantCandidates =
    searchReturned - searchRelevantReturned;
  const searchPrecision =
    searchCalls.length === 0
      ? null
      : searchReturned === 0
      ? fixture.expectedAddresses.length === 0
        ? 1
        : 0
      : round(searchRelevantReturned / searchReturned, 3);
  const estimatedLookupNoiseTokens = searchCalls.reduce(
    (sum, call) => sum + (call.search?.estimatedNoiseTokens ?? 0),
    0,
  );
  const connectaMcpResultTokens = connectaToolCalls.reduce(
    (sum, call) => sum + call.resultTokens,
    0,
  );
  const foreignMcpResultTokens = foreignToolCalls.reduce(
    (sum, call) => sum + call.resultTokens,
    0,
  );
  const allMcpResultTokens =
    connectaMcpResultTokens + foreignMcpResultTokens;
  const inputTokens = usage.input_tokens ?? 0;
  const cachedInputTokens = usage.cached_input_tokens ?? 0;
  const intendedConnectaRoute = connectaRouteCorrect(
    fixture,
    connectaToolCalls,
  );
  const routeClean =
    intendedConnectaRoute &&
    foreignToolCalls.length === 0 &&
    nonMcpActions.length === 0;

  return {
    id: fixture.id,
    family: fixture.family,
    context: fixture.context,
    repetition,
    promptSha256: sha256(fixture.prompt),
    promptTokens: textTokens(fixture.prompt),
    promptPreview:
      fixture.context === "pressure"
        ? `${fixture.prompt.slice(0, 120)}…\n${fixture.prompt.slice(-220)}`
        : fixture.prompt,
    expectedAddresses: fixture.expectedAddresses,
    expectedRoute: fixture.expectedRoute,
    latencyMs: round(performance.now() - started, 1),
    lookupAccurate: addressAccurate,
    addressAccurate,
    finalCorrect,
    routingResultCorrect,
    connectaRouteCorrect: intendedConnectaRoute,
    routeClean,
    executedAddresses: executed,
    guidanceFetched: connectaToolCalls.some(
      (call) => call.tool === "skills",
    ),
    foreignToolCalls: foreignToolCalls.length,
    foreignTools: foreignToolCalls.map(
      (call) => `${call.server ?? "unknown"}.${call.tool}`,
    ),
    searchCalls: searchCalls.length,
    emptySearches: searchCalls.filter(
      (call) => (call.search?.returned ?? 0) === 0,
    ).length,
    unknownConnectorFilters: searchCalls.filter(
      (call) =>
        typeof call.search?.connector === "string" &&
        !knownConnectorIds.has(call.search.connector),
    ).length,
    searchReturned,
    searchRelevantReturned,
    searchIrrelevantCandidates,
    searchPrecision,
    directRetrievalTop1,
    directRetrievalRecall,
    directRetrievalMrr,
    directNegativeClean,
    toolCalls,
    nonMcpActions,
    hostActionCount: nonMcpActions.length,
    finalText,
    usage,
    nonCachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    connectaMcpResultTokens,
    foreignMcpResultTokens,
    allMcpResultTokens,
    searchResultTokens,
    estimatedLookupNoiseTokens,
  };
}

const selected =
  selectedCase === "all"
    ? lookupCases
    : lookupCases.filter((fixture) => fixture.id === selectedCase);
if (selected.length === 0) {
  throw new Error(
    `Unknown --case "${selectedCase}". Choose ${lookupCases
      .map((fixture) => fixture.id)
      .join(", ")}, or all.`,
  );
}

const jobs = Array.from({ length: repetitions }, (_, index) =>
  selected.map((fixture) => ({
    fixture,
    repetition: index + 1,
  })),
).flat();
const caseResults = Array.from({ length: jobs.length });
let nextJob = 0;
async function worker() {
  for (;;) {
    const index = nextJob;
    nextJob += 1;
    const job = jobs[index];
    if (!job) return;
    process.stderr.write(
      `Running lookup case ${job.fixture.id} (${job.repetition}/${repetitions})…\n`,
    );
    const server = startServer();
    try {
      const ready = await server.ready;
      caseResults[index] = await runAgent(
        job.fixture,
        ready.url,
        job.repetition,
      );
    } finally {
      await stopServer(server.child);
    }
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
);

function mean(items, select) {
  return items.length === 0
    ? 0
    : items.reduce((sum, item) => sum + select(item), 0) / items.length;
}

const byCase = Object.fromEntries(
  selected.map((fixture) => {
    const runs = caseResults.filter((entry) => entry.id === fixture.id);
    const precisionRuns = runs.filter(
      (entry) => entry.searchPrecision !== null,
    );
    const retrievalRuns = runs.filter(
      (entry) => entry.directRetrievalRecall !== null,
    );
    const negativeRuns = runs.filter(
      (entry) => entry.directNegativeClean !== null,
    );
    return [
      fixture.id,
      {
        runs: runs.length,
        lookupAccuracy: round(
          runs.filter((entry) => entry.lookupAccurate).length / runs.length,
          3,
        ),
        routingResultAccuracy: round(
          runs.filter((entry) => entry.routingResultCorrect).length /
            runs.length,
          3,
        ),
        addressAccuracy: round(
          runs.filter((entry) => entry.addressAccurate).length / runs.length,
          3,
        ),
        routeAccuracy: round(
          runs.filter((entry) => entry.routeClean).length / runs.length,
          3,
        ),
        connectaRouteAccuracy: round(
          runs.filter((entry) => entry.connectaRouteCorrect).length /
            runs.length,
          3,
        ),
        meanSearchPrecision:
          precisionRuns.length === 0
            ? null
            : round(
                mean(precisionRuns, (entry) => entry.searchPrecision),
                3,
              ),
        directRetrievalTop1Accuracy:
          retrievalRuns.length === 0
            ? null
            : round(
                retrievalRuns.filter(
                  (entry) => entry.directRetrievalTop1,
                ).length / retrievalRuns.length,
                3,
              ),
        meanDirectRetrievalRecall:
          retrievalRuns.length === 0
            ? null
            : round(
                mean(
                  retrievalRuns,
                  (entry) => entry.directRetrievalRecall,
                ),
                3,
              ),
        meanDirectRetrievalMrr:
          retrievalRuns.length === 0
            ? null
            : round(
                mean(
                  retrievalRuns,
                  (entry) => entry.directRetrievalMrr,
                ),
                3,
              ),
        directNegativeCleanRate:
          negativeRuns.length === 0
            ? null
            : round(
                negativeRuns.filter(
                  (entry) => entry.directNegativeClean,
                ).length / negativeRuns.length,
                3,
              ),
        meanIrrelevantCandidates: round(
          mean(runs, (entry) => entry.searchIrrelevantCandidates),
          1,
        ),
        meanLookupAttempts: round(
          mean(runs, (entry) => entry.searchCalls),
          1,
        ),
        unknownConnectorFilterRate: round(
          runs.filter((entry) => entry.unknownConnectorFilters > 0).length /
            runs.length,
          3,
        ),
        meanSearchResultTokens: round(
          mean(runs, (entry) => entry.searchResultTokens),
          1,
        ),
        meanEstimatedLookupNoiseTokens: round(
          mean(runs, (entry) => entry.estimatedLookupNoiseTokens),
          1,
        ),
        meanMcpResultTokens: round(
          mean(runs, (entry) => entry.connectaMcpResultTokens),
          1,
        ),
        meanForeignMcpResultTokens: round(
          mean(runs, (entry) => entry.foreignMcpResultTokens),
          1,
        ),
        meanInputTokens: round(
          mean(runs, (entry) => entry.usage.input_tokens ?? 0),
          1,
        ),
        meanNonCachedInputTokens: round(
          mean(runs, (entry) => entry.nonCachedInputTokens),
          1,
        ),
        meanLatencyMs: round(mean(runs, (entry) => entry.latencyMs), 1),
        guidanceFetchRate: round(
          runs.filter((entry) => entry.guidanceFetched).length / runs.length,
          3,
        ),
        hostActionRate: round(
          runs.filter((entry) => entry.hostActionCount > 0).length /
            runs.length,
          3,
        ),
        foreignToolRate: round(
          runs.filter((entry) => entry.foreignToolCalls > 0).length /
            runs.length,
          3,
        ),
      },
    ];
  }),
);
const positiveDirectRetrievalRuns = caseResults.filter(
  (entry) => entry.directRetrievalRecall !== null,
);
const negativeDirectRetrievalRuns = caseResults.filter(
  (entry) => entry.directNegativeClean !== null,
);

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    commit: sourceCommit,
    productDirty,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    codexVersion: execFileSync("codex", ["--version"], {
      encoding: "utf8",
    }).trim(),
    model: agentModel ?? "codex-default",
    tokenizer: tokenizerName,
  },
  configuration: {
    repetitions,
    concurrency,
    selectedCase,
    jobOrder: "repetition-major with clean/pressure pairs adjacent",
    harnessSha256,
    corpusSha256,
    sandboxSha256,
    disabledHostFeatures,
    isolation:
      "Fresh Connecta server and ephemeral Codex session for every run; user config ignored; host apps/plugins/browser/computer/agent features disabled; read-only filesystem sandbox.",
    noiseEstimate:
      "Search-result tokens minus a reconstructed result retaining only expected candidates and the same MCP content/structured-content shape.",
  },
  summary: {
    runs: caseResults.length,
    lookupAccurate: caseResults.filter((entry) => entry.lookupAccurate)
      .length,
    routingResultCorrect: caseResults.filter(
      (entry) => entry.routingResultCorrect,
    ).length,
    addressAccurate: caseResults.filter((entry) => entry.addressAccurate)
      .length,
    connectaRouteCorrect: caseResults.filter(
      (entry) => entry.connectaRouteCorrect,
    ).length,
    routeClean: caseResults.filter((entry) => entry.routeClean).length,
    directRetrievalTop1Accuracy:
      positiveDirectRetrievalRuns.length === 0
        ? null
        : round(
            positiveDirectRetrievalRuns.filter(
              (entry) => entry.directRetrievalTop1,
            ).length / positiveDirectRetrievalRuns.length,
            3,
          ),
    meanDirectRetrievalRecall:
      positiveDirectRetrievalRuns.length === 0
        ? null
        : round(
            mean(
              positiveDirectRetrievalRuns,
              (entry) => entry.directRetrievalRecall,
            ),
            3,
          ),
    meanDirectRetrievalMrr:
      positiveDirectRetrievalRuns.length === 0
        ? null
        : round(
            mean(
              positiveDirectRetrievalRuns,
              (entry) => entry.directRetrievalMrr,
            ),
            3,
          ),
    directNegativeCleanRate:
      negativeDirectRetrievalRuns.length === 0
        ? null
        : round(
            negativeDirectRetrievalRuns.filter(
              (entry) => entry.directNegativeClean,
            ).length / negativeDirectRetrievalRuns.length,
            3,
          ),
    totalSearchResultTokens: caseResults.reduce(
      (sum, entry) => sum + entry.searchResultTokens,
      0,
    ),
    totalEstimatedLookupNoiseTokens: caseResults.reduce(
      (sum, entry) => sum + entry.estimatedLookupNoiseTokens,
      0,
    ),
    totalConnectaMcpResultTokens: caseResults.reduce(
      (sum, entry) => sum + entry.connectaMcpResultTokens,
      0,
    ),
    totalForeignMcpResultTokens: caseResults.reduce(
      (sum, entry) => sum + entry.foreignMcpResultTokens,
      0,
    ),
    totalMcpResultTokens: caseResults.reduce(
      (sum, entry) => sum + entry.allMcpResultTokens,
      0,
    ),
    totalInputTokens: caseResults.reduce(
      (sum, entry) => sum + (entry.usage.input_tokens ?? 0),
      0,
    ),
    totalNonCachedInputTokens: caseResults.reduce(
      (sum, entry) => sum + entry.nonCachedInputTokens,
      0,
    ),
    totalOutputTokens: caseResults.reduce(
      (sum, entry) => sum + (entry.usage.output_tokens ?? 0),
      0,
    ),
    totalLatencyMs: round(
      caseResults.reduce((sum, entry) => sum + entry.latencyMs, 0),
      1,
    ),
  },
  byCase,
  cases: caseResults,
};

function yesNo(value) {
  return value ? "yes" : "NO";
}

function metric(value) {
  return value === null ? "—" : value;
}

const rows = caseResults
  .map((entry) => {
    const route = entry.toolCalls
      .map((call) => `${call.server ?? "unknown"}.${call.tool}`)
      .join(" → ");
    return `| ${entry.id} #${entry.repetition} | ${yesNo(entry.lookupAccurate)} | ${yesNo(entry.routingResultCorrect)} | ${yesNo(entry.connectaRouteCorrect)} | ${yesNo(entry.routeClean)} | ${metric(entry.directRetrievalTop1)} | ${metric(entry.directRetrievalRecall)} | ${metric(entry.directRetrievalMrr)} | ${metric(entry.searchPrecision)} | ${entry.searchIrrelevantCandidates} | ${entry.searchCalls} | ${entry.unknownConnectorFilters} | ${entry.estimatedLookupNoiseTokens} | ${entry.connectaMcpResultTokens} | ${entry.foreignMcpResultTokens} | ${entry.usage.input_tokens ?? 0} | ${entry.promptTokens} | \`${route}\` |`;
  })
  .join("\n");
const groupedRows = Object.entries(byCase)
  .map(
    ([id, metrics]) =>
      `| ${id} | ${(metrics.lookupAccuracy * 100).toFixed(0)}% | ${(metrics.routingResultAccuracy * 100).toFixed(0)}% | ${(metrics.connectaRouteAccuracy * 100).toFixed(0)}% | ${(metrics.routeAccuracy * 100).toFixed(0)}% | ${metric(metrics.directRetrievalTop1Accuracy)} | ${metric(metrics.meanDirectRetrievalRecall)} | ${metric(metrics.meanDirectRetrievalMrr)} | ${metric(metrics.meanSearchPrecision)} | ${metrics.meanIrrelevantCandidates} | ${metrics.meanLookupAttempts} | ${(metrics.unknownConnectorFilterRate * 100).toFixed(0)}% | ${metrics.meanEstimatedLookupNoiseTokens} | ${metrics.meanMcpResultTokens} | ${metrics.meanForeignMcpResultTokens} | ${metrics.meanInputTokens} |`,
  )
  .join("\n");
const report = `# Latest-main agent lookup benchmark

Generated: ${result.generatedAt}

Source: \`${sourceCommit}\`; ${result.source.codexVersion}; model ${result.source.model}

Each run used a fresh isolated server and ephemeral agent. Host apps, plugins,
browser, computer-use, multi-agent, and related discovery features were
explicitly disabled in addition to ignoring user config. Accuracy requires the
agent to execute exactly the expected downstream address set and return the
matching synthetic routing result. This is a routing canary, not validation of
real connector arguments or task semantics. The noise-token figure is the actual
serialized search result minus the same MCP envelope reconstructed with only
the expected candidate rows.

## Summary

- Exact tool-address accuracy: ${result.summary.lookupAccurate}/${result.summary.runs}
- Routing-result agreement: ${result.summary.routingResultCorrect}/${result.summary.runs}
- Intended Connecta route: ${result.summary.connectaRouteCorrect}/${result.summary.runs}
- Clean route (no foreign tool or host actions): ${result.summary.routeClean}/${result.summary.runs}
- Direct retrieval top-1 accuracy: ${metric(result.summary.directRetrievalTop1Accuracy)}
- Mean direct retrieval recall: ${metric(result.summary.meanDirectRetrievalRecall)}
- Mean direct retrieval MRR: ${metric(result.summary.meanDirectRetrievalMrr)}
- Direct negative clean rate: ${metric(result.summary.directNegativeCleanRate)}
- Search-result tokens: ${result.summary.totalSearchResultTokens.toLocaleString()}
- Estimated irrelevant lookup tokens: ${result.summary.totalEstimatedLookupNoiseTokens.toLocaleString()}
- Connecta MCP result tokens: ${result.summary.totalConnectaMcpResultTokens.toLocaleString()}
- Foreign MCP result tokens: ${result.summary.totalForeignMcpResultTokens.toLocaleString()}
- All MCP result tokens: ${result.summary.totalMcpResultTokens.toLocaleString()}
- Whole-agent input tokens: ${result.summary.totalInputTokens.toLocaleString()} (${result.summary.totalNonCachedInputTokens.toLocaleString()} non-cached)

## By case

| Case | Address accuracy | Routing result | Connecta route | Clean route | Direct top-1 | Direct recall | Direct MRR | Search precision | Irrelevant candidates | Lookup attempts | Unknown connector filter | Est. noise tokens | Connecta MCP tokens | Foreign MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${groupedRows}

## Runs

| Run | Address | Routing result | Connecta route | Clean route | Direct top-1 | Direct recall | Direct MRR | Search precision | Irrelevant candidates | Lookup attempts | Unknown connector filters | Est. noise tokens | Connecta MCP tokens | Foreign MCP tokens | Agent input tokens | Prompt tokens | Tool route |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows}

## Interpretation

- Direct retrieval metrics measure only outer search_tools calls; searches
  nested inside execute_code are intentionally not attributed without a server
  trace. Search precision measures only the returned page. An accurate answer with low
  precision means the agent reasoned through retrieval noise; it does not make
  the lookup payload cheap.
- Whole-agent input tokens are Codex CLI accounting for the complete host
  context, including built-in definitions and cache reads. MCP result tokens
  isolate the observed Connecta payloads.
- Pressure cases contain 128 explicitly resolved distractor tasks and put the
  current request at the end. They test instruction selection under long,
  competing integration vocabulary; they are not a context-window limit test.
- Repetitions expose behavioral variance. This sample remains a canary, not a
  statistical release gate.
`;

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
await writeFile(reportPath, report);
tokenizer.free?.();
process.stdout.write(
  `${JSON.stringify({
    event: "agent_lookup_benchmark_complete",
    output: outputPath,
    report: reportPath,
    sourceCommit,
    summary: result.summary,
    byCase,
  })}\n`,
);
