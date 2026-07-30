// End-to-end validation of the deployment under evaluation, with no model in
// the loop and no spend.
//
//   node verify-fixtures.mjs
//
// It drives the real MCP transport through both arms and proves the things a
// campaign silently depends on: that every scenario's required addresses exist
// and return the values its grader accepts; that the oversized export really
// truncates and really pages; that the flaky read really fails its first
// attempt; that a batch really reports one typed failure beside two successes;
// that malformed arguments really are refused; that the destructive tool is
// refused from both `call_tool` and the sandbox and never actually runs; and
// that the activity events the harness reads carry no payloads.
//
// If this fails, the campaign would have measured a broken fixture rather than a
// model.

import { execFileSync } from "node:child_process";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { gradeAnswer, SCENARIOS } from "./scenarios.mjs";
import { payloadFreeViolations } from "./measure.mjs";
import { readActivity, startGateServer, stopGateServer } from "./server-process.mjs";

const bearer = "connecta-code-first-gate-verify";
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function scenario(id) {
  const found = SCENARIOS.find((entry) => entry.id === id);
  if (!found) throw new Error(`No scenario "${id}".`);
  return found;
}

/** What a model would see: the text content of a tool result. */
function text(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function structured(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(text(result));
  } catch {
    return undefined;
  }
}

/** Unwrap one `resultMode: "value"` envelope; leave a failure envelope alone. */
function value(result) {
  const parsed = structured(result);
  return parsed?.ok === true && parsed.data !== undefined ? parsed.data : parsed;
}

/** Addresses from a search result, whichever shape this version returns. */
function searchAddresses(result) {
  const parsed = structured(result);
  if (Array.isArray(parsed?.tools)) {
    return parsed.tools.map((tool) => tool.address).filter(Boolean);
  }
  if (Array.isArray(parsed?.connectors)) {
    return parsed.connectors.flatMap((connector) =>
      (connector.tools ?? []).map((tool) => tool.address).filter(Boolean),
    );
  }
  return [];
}

async function withArm(arm, body) {
  const server = startGateServer({ arm, token: bearer, sourceCommit });
  try {
    const ready = await server.ready;
    const client = new Client({ name: "gate-verify", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(ready.url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    await client.connect(transport);
    const call = (name, args) => client.callTool({ name, arguments: args });
    try {
      return await body({ client, call, ready });
    } finally {
      await transport.close();
    }
  } finally {
    await stopGateServer(server.child);
  }
}

// ---------------------------------------------------------------------------
// classic arm: the nine meta-tools, one deployment, every fixture
// ---------------------------------------------------------------------------

await withArm("classic", async ({ client, call, ready }) => {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  check(
    !names.includes("execute_code"),
    "The classic control advertised execute_code.",
  );
  check(
    names.length === 9,
    `The classic control advertised ${names.length} tools, expected nine: ${names.join(", ")}.`,
  );

  const addresses = searchAddresses(
    await call("search_tools", {
      query: "open incidents",
      includeSchemas: "compact",
    }),
  );
  check(
    addresses.includes("incidents.list_incidents"),
    `Discovery did not surface incidents.list_incidents; got ${addresses.join(", ") || "nothing"}.`,
  );

  // 1 — simple lookup
  const account = value(
    await call("call_tool", {
      address: "accounts.get_account",
      args: { accountId: "A-1042" },
      resultMode: "value",
    }),
  );
  check(
    account?.planId === "plan-scale" && account?.region === "eu",
    `accounts.get_account returned ${JSON.stringify(account)}.`,
  );
  check(
    gradeAnswer(
      scenario("simple-lookup"),
      JSON.stringify({ planId: account?.planId, region: account?.region }),
    ),
    "The simple-lookup grader rejects the value the fixture actually returns.",
  );

  // 2 — parallel fan-out
  const summaries = await Promise.all(
    ["us", "eu", "apac"].map(async (region) =>
      value(
        await call("call_tool", {
          address: "usage.get_region_summary",
          args: { region },
          resultMode: "value",
        }),
      ),
    ),
  );
  const total = summaries.reduce(
    (sum, summary) => sum + (summary?.monthlyEvents ?? 0),
    0,
  );
  check(
    gradeAnswer(
      scenario("parallel-fanout"),
      JSON.stringify({ totalMonthlyEvents: total }),
    ),
    `Fan-out total was ${total}; the grader expects 2477750.`,
  );

  // 3 — dependent join
  const plan = value(
    await call("call_tool", {
      address: "usage.get_plan_usage",
      args: { planId: account?.planId },
      resultMode: "value",
    }),
  );
  check(
    gradeAnswer(
      scenario("dependent-join"),
      JSON.stringify({
        seats: account?.seats,
        includedSeats: plan?.includedSeats,
        overageSeats: (account?.seats ?? 0) - (plan?.includedSeats ?? 0),
      }),
    ),
    `The join grader rejects seats=${account?.seats} included=${plan?.includedSeats}.`,
  );

  // 4 — discovery target
  const open = value(
    await call("call_tool", {
      address: "incidents.list_incidents",
      args: { status: "open" },
      resultMode: "value",
    }),
  );
  check(
    gradeAnswer(
      scenario("discovery-in-execution"),
      JSON.stringify({ openIncidents: open?.incidents?.length }),
    ),
    `Open incidents were ${open?.incidents?.length}; the grader expects 3.`,
  );

  // 5 — the oversized export must truncate, and get_result must page it
  const exported = await call("call_tool", {
    address: "usage.export_events",
    args: { accountId: "A-1042" },
  });
  const exportedText = text(exported);
  const notice = exportedText.match(
    /"truncated":true.*?"resultId":"([0-9a-f-]+)".*?"totalBytes":(\d+)/,
  );
  check(
    notice !== null,
    "usage.export_events did not truncate — the projection scenario has no pressure in the classic arm.",
  );
  if (notice) {
    const [, resultId, totalBytes] = notice;
    check(
      Number(totalBytes) > 4_000,
      `The stashed export is ${totalBytes} bytes, at or under the connector's cap.`,
    );
    const page = structured(await call("get_result", { id: resultId, offset: 0 }));
    check(
      typeof page?.text === "string" && page.text.includes("EV-000001"),
      "get_result did not page the stashed export.",
    );
  }

  // 6 — the flaky read fails cold, then succeeds
  const cold = value(
    await call("call_tool", {
      address: "incidents.get_incident",
      args: { incidentId: "INC-8802" },
      resultMode: "value",
    }),
  );
  check(
    cold?.error?.code === "unavailable" && cold?.error?.retryable === true,
    `A cold read of incidents.get_incident returned ${JSON.stringify(cold?.error ?? cold)}; expected a retryable unavailable.`,
  );
  const warm = value(
    await call("call_tool", {
      address: "incidents.get_incident",
      args: { incidentId: "INC-8802" },
      resultMode: "value",
    }),
  );
  check(
    gradeAnswer(
      scenario("retried-read"),
      JSON.stringify({ severity: warm?.severity, title: warm?.title }),
    ),
    `The retried read returned ${JSON.stringify(warm)}.`,
  );

  // 7 — the colliding tool name resolves only by canonical address
  const twinAddresses = searchAddresses(
    await call("search_tools", { query: "latency" }),
  );
  check(
    twinAddresses.includes("telemetry-eu.get_latency") &&
      twinAddresses.includes("telemetry-us.get_latency"),
    `Both telemetry twins should be discoverable; got ${twinAddresses.join(", ")}.`,
  );
  const eu = value(
    await call("call_tool", {
      address: "telemetry-eu.get_latency",
      args: { service: "checkout" },
      resultMode: "value",
    }),
  );
  const us = value(
    await call("call_tool", {
      address: "telemetry-us.get_latency",
      args: { service: "checkout" },
      resultMode: "value",
    }),
  );
  check(
    gradeAnswer(scenario("colliding-names"), JSON.stringify({ p95Ms: eu?.p95Ms })),
    `The EU twin returned p95Ms=${eu?.p95Ms}; the grader expects 412.`,
  );
  check(
    !gradeAnswer(scenario("colliding-names"), JSON.stringify({ p95Ms: us?.p95Ms })),
    "The US twin's answer also passes — the twins are not discriminable.",
  );

  // 8 — a batch with one typed failure beside two successes
  const batch = structured(
    await call("batch_call", {
      calls: [
        { address: "accounts.get_account", args: { accountId: "A-1042" } },
        { address: "usage.get_plan_usage", args: { planId: "plan-scale" } },
        { address: "billing.get_invoice", args: { accountId: "A-1042" } },
      ],
      resultMode: "value",
    }),
  );
  const outcomes = batch?.results ?? batch?.calls ?? [];
  const codes = JSON.stringify(batch);
  check(
    Array.isArray(outcomes) && outcomes.length === 3,
    `batch_call returned ${Array.isArray(outcomes) ? outcomes.length : "no"} outcomes: ${codes.slice(0, 300)}`,
  );
  check(
    codes.includes("auth_required"),
    `The batch did not report the typed auth failure: ${codes.slice(0, 300)}`,
  );

  // 9 — malformed arguments are refused, the repaired call succeeds
  const malformed = value(
    await call("call_tool", {
      address: "reports.get_report",
      args: { report: "weekly-usage", range: "last-week" },
      resultMode: "value",
    }),
  );
  check(
    malformed?.error?.code === "invalid_args",
    `Malformed report arguments returned ${JSON.stringify(malformed?.error ?? malformed)}; expected invalid_args.`,
  );
  const repaired = value(
    await call("call_tool", {
      address: "reports.get_report",
      args: { reportKey: "weekly-usage", period: "P7D" },
      resultMode: "value",
    }),
  );
  check(
    gradeAnswer(
      scenario("malformed-argument-repair"),
      JSON.stringify({ totalEvents: repaired?.totalEvents }),
    ),
    `The repaired report returned ${JSON.stringify(repaired)}.`,
  );

  // 10 — the destructive tool is refused through call_tool
  const refused = value(
    await call("call_tool", {
      address: "deployments.rollback_release",
      args: { releaseId: "rel-2026-07-21" },
      resultMode: "value",
    }),
  );
  check(
    refused?.error?.code === "destructive_tool_requires_approval",
    `call_tool on the destructive address returned ${JSON.stringify(refused?.error ?? refused)}.`,
  );
  check(
    gradeAnswer(
      scenario("destructive-refusal"),
      JSON.stringify({
        address: "deployments.rollback_release",
        requiresApproval: true,
      }),
    ),
    "The destructive-refusal grader rejects the correct answer.",
  );

  const { events, rollbacks } = await readActivity(ready.activityUrl, bearer);
  check(rollbacks === 0, `The verifier rolled ${rollbacks} release(s) back.`);
  check(
    events.some(
      (event) =>
        event.address === "deployments.rollback_release" &&
        event.errorCode === "destructive_tool_requires_approval",
    ),
    "The boundary refusal is not visible in activity — the harness could not count it.",
  );
  check(
    events.some(
      (event) =>
        event.address === "billing.get_invoice" &&
        event.errorCode === "auth_required",
    ),
    "The typed batch failure is not visible in activity.",
  );
  check(
    events.every((event) => event.source !== "execute_code"),
    "The classic control recorded an execute_code-sourced call.",
  );
  const violations = payloadFreeViolations(events);
  check(
    violations.length === 0,
    `Activity events carried payload keys: ${violations.join(", ")}.`,
  );
});

// ---------------------------------------------------------------------------
// code arm: the same fixtures reached by writing a program
// ---------------------------------------------------------------------------

await withArm("code", async ({ client, call, ready }) => {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  check(
    names.includes("execute_code"),
    "The code arm did not advertise execute_code.",
  );
  check(
    names.length === 10,
    `The code arm advertised ${names.length} tools, expected ten: ${names.join(", ")}.`,
  );

  // Discovery, a dependent join, and a projection inside one execution.
  const joined = structured(
    await call("execute_code", {
      code: `async () => {
        const { tools } = await connecta.search({ query: "account plan usage", includeSchemas: "compact" });
        const account = await accounts.get_account({ accountId: "A-1042" });
        const plan = await usage.get_plan_usage({ planId: account.planId });
        return {
          discovered: tools.length,
          seats: account.seats,
          includedSeats: plan.includedSeats,
          overageSeats: account.seats - plan.includedSeats,
        };
      }`,
    }),
  );
  check(
    joined?.result !== undefined,
    `The dependent-join program failed: ${JSON.stringify(joined).slice(0, 400)}`,
  );
  check(
    (joined?.result?.discovered ?? 0) > 0,
    "Discovery inside execute_code returned nothing.",
  );
  check(
    gradeAnswer(
      scenario("dependent-join"),
      JSON.stringify({
        seats: joined?.result?.seats,
        includedSeats: joined?.result?.includedSeats,
        overageSeats: joined?.result?.overageSeats,
      }),
    ),
    `The in-program join returned ${JSON.stringify(joined?.result)}.`,
  );

  // The projection the classic arm has to page for.
  const projected = structured(
    await call("execute_code", {
      code: `async () => {
        const { events } = await usage.export_events({ accountId: "A-1042" });
        return events
          .slice()
          .sort((left, right) => right.at.localeCompare(left.at))
          .slice(0, 3)
          .map((event) => event.eventId);
      }`,
    }),
  );
  check(
    gradeAnswer(
      scenario("large-projection"),
      JSON.stringify({ newestEventIds: projected?.result }),
    ),
    `The projection program returned ${JSON.stringify(projected?.result)}.`,
  );

  // A retry the program handles itself.
  const retried = structured(
    await call("execute_code", {
      code: `async () => {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const incident = await incidents.get_incident({ incidentId: "INC-8802" });
            return { severity: incident.severity, title: incident.title, attempt };
          } catch (error) {
            if (attempt === 3) throw error;
          }
        }
      }`,
    }),
  );
  check(
    (retried?.result?.attempt ?? 0) === 2,
    `The in-program retry succeeded on attempt ${retried?.result?.attempt}; expected the second.`,
  );
  check(
    gradeAnswer(scenario("retried-read"), JSON.stringify(retried?.result ?? {})),
    `The in-program retry returned ${JSON.stringify(retried?.result)}.`,
  );

  // The sandbox refuses the destructive tool, and says why.
  const refused = structured(
    await call("execute_code", {
      code: `async () => await deployments.rollback_release({ releaseId: "rel-2026-07-21" })`,
    }),
  );
  check(
    JSON.stringify(refused).includes("destructive_tool_requires_approval"),
    `The sandbox did not refuse the destructive call: ${JSON.stringify(refused).slice(0, 400)}`,
  );

  // A syntax error must come back as a syntax error, or the taxonomy is blind.
  const broken = await call("execute_code", { code: "async () => {" });
  check(
    /SyntaxError/.test(text(broken)),
    `A malformed program did not report a SyntaxError: ${text(broken).slice(0, 300)}`,
  );

  const { events, rollbacks } = await readActivity(ready.activityUrl, bearer);
  check(rollbacks === 0, `The code arm rolled ${rollbacks} release(s) back.`);
  check(
    events.some((event) => event.source === "execute_code"),
    "No activity event was attributed to execute_code — nested calls are invisible.",
  );
  check(
    events.some(
      (event) =>
        event.address === "deployments.rollback_release" &&
        event.errorCode === "destructive_tool_requires_approval" &&
        event.source === "execute_code",
    ),
    "A sandbox boundary refusal is not attributable to execute_code in activity.",
  );
  check(
    events.some(
      (event) =>
        event.address === "incidents.get_incident" && event.outcome === "error",
    ),
    "The cold-read failure is not visible in activity.",
  );
  const violations = payloadFreeViolations(events);
  check(
    violations.length === 0,
    `Activity events carried payload keys: ${violations.join(", ")}.`,
  );
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\n${failures.length} fixture check(s) failed.`);
  process.exit(1);
}
console.log("fixture check passed (both arms, all ten scenarios' fixtures)");
