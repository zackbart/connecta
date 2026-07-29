import { errorCode, structured, textContent } from "./audit-lib.mjs";

function objectValue(result) {
  const value = structured(result);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function pass(condition, details = {}) {
  return { passed: Boolean(condition), ...details };
}

export async function runTaskAudit(context, { baseUrl, operatorToken }) {
  const cases = [];

  async function task(name, tool, args, classify) {
    const { result, observation } = await context.call(
      name,
      tool,
      args,
      classify,
    );
    cases.push(observation);
    return result;
  }

  await task("list guidance", "skills", {}, (result) => {
    return pass(
      textContent(result)?.includes("usage") === true,
      { outcome: "guidance-listed" },
    );
  });
  await task("fetch routing guidance", "skills", { name: "usage" }, (result) =>
    pass(
      (textContent(result)?.length ?? 0) > 100,
      { outcome: "guidance-fetched" },
    ),
  );
  await task(
    "inventory configured connectors",
    "list_connectors",
    { probe: false },
    (result) =>
      pass(Array.isArray(objectValue(result).connectors), {
        outcome: "inventory-returned",
      }),
  );
  await task(
    "focused discovery",
    "search_tools",
    {
      query: "deterministic records",
      connector: "controlled",
      includeSchemas: "compact",
    },
    (result) => {
      const groups = objectValue(result).connectors;
      const addresses = Array.isArray(groups)
        ? groups.flatMap((group) =>
            Array.isArray(group.tools)
              ? group.tools.map((tool) => tool.address)
              : [],
          )
        : [];
      return pass(addresses.includes("controlled.records"), {
        outcome: "tool-discovered",
        returned: addresses.length,
      });
    },
  );
  await task(
    "inspect complete schema",
    "describe_tools",
    { addresses: ["controlled.records"], format: "json" },
    (result) =>
      pass(
        Array.isArray(objectValue(result).tools) &&
          objectValue(result).tools.length === 1,
        { outcome: "schema-described" },
      ),
  );
  await task(
    "single read-only call",
    "call_tool",
    {
      address: "controlled.read_record",
      args: { id: 7 },
      resultMode: "value",
      diagnostics: true,
    },
    (result) =>
      pass(result.isError !== true && objectValue(result).ok === true, {
        outcome: "read-succeeded",
      }),
  );
  await task(
    "read-only route refuses destructive tool",
    "call_tool",
    {
      address: "controlled.increment_counter",
      args: { amount: 1 },
      resultMode: "value",
    },
    (result) =>
      pass(
        objectValue(result).ok === false &&
          errorCode(result) === "destructive_tool_requires_approval",
        {
          outcome: "destructive-refused",
          errorCode: errorCode(result) ?? null,
        },
      ),
  );
  await task(
    "approved destructive call",
    "call_destructive_tool",
    {
      address: "controlled.increment_counter",
      args: { amount: 2 },
      resultMode: "value",
      diagnostics: true,
    },
    (result) =>
      pass(result.isError !== true && objectValue(result).ok === true, {
        outcome: "destructive-approved",
      }),
  );
  const truncated = await task(
    "create truncated result",
    "call_tool",
    {
      address: "controlled.large_document",
      args: { paragraphs: 30 },
      resultMode: "value",
      diagnostics: true,
    },
    (result) => {
      const value = objectValue(result);
      return pass(
        value.ok === true &&
          value.data?.truncated === true &&
          typeof value.data?.resultId === "string",
        {
          outcome: "result-truncated",
          resultId: value.data?.resultId ?? null,
          totalBytes: value.data?.totalBytes ?? null,
        },
      );
    },
  );
  const resultId = objectValue(truncated).data?.resultId;
  if (typeof resultId !== "string") {
    throw new Error("Truncation scenario did not return a result id.");
  }
  await task(
    "page truncated result",
    "get_result",
    { id: resultId, offset: 0, maxBytes: 300 },
    (result) => {
      const value = objectValue(result);
      return pass(
        typeof value.text === "string" &&
          value.offset === 0 &&
          typeof value.nextOffset === "number",
        {
          outcome: "result-paged",
          offset: value.offset ?? null,
          nextOffset: value.nextOffset ?? null,
          totalBytes: value.totalBytes ?? null,
        },
      );
    },
  );
  await task(
    "batch independent reads",
    "batch_call",
    {
      calls: [
        {
          address: "controlled.read_record",
          args: { id: 11 },
          fields: ["id", "score"],
        },
        {
          address: "controlled.read_record",
          args: { id: 12 },
          fields: ["id", "group"],
        },
      ],
      resultMode: "value",
      diagnostics: true,
    },
    (result) => {
      const value = objectValue(result);
      return pass(
        Array.isArray(value.results) &&
          value.results.length === 2 &&
          value.results.every((entry) => entry.ok === true),
        { outcome: "batch-succeeded", resultCount: value.results?.length ?? 0 },
      );
    },
  );
  await task(
    "reduce records in code mode",
    "execute_code",
    {
      code:
        "async () => { const rows = await controlled.records({ count: 120 }); " +
        "return rows.reduce((out, row) => { const group = out[row.group] ??= " +
        "{ count: 0, sum: 0 }; group.count++; group.sum += row.score; " +
        "return out; }, {}); }",
    },
    (result) =>
      pass(result.isError !== true && "result" in objectValue(result), {
        outcome: "code-reduction-succeeded",
      }),
  );

  await task(
    "OAuth call requires recovery",
    "call_tool",
    {
      address: "oauth-recoverable.whoami",
      args: {},
      resultMode: "value",
    },
    (result) =>
      pass(objectValue(result).ok === false && errorCode(result) === "auth_required", {
        outcome: "oauth-auth-required",
        errorCode: errorCode(result) ?? null,
      }),
  );
  const oauthStart = await task(
    "OAuth recovery starts",
    "authorize_connector",
    { connector: "oauth-recoverable" },
    (result) => {
      const value = objectValue(result);
      return pass(
        result.isError !== true &&
          typeof value.authorizationUrl === "string",
        {
          outcome: "oauth-operator-handoff",
          hasAuthorizationUrl: typeof value.authorizationUrl === "string",
        },
      );
    },
  );
  const authorizationUrl = objectValue(oauthStart).authorizationUrl;
  if (typeof authorizationUrl !== "string") {
    throw new Error("OAuth recovery did not return an authorization URL.");
  }
  const consent = await fetch(authorizationUrl);
  if (!consent.ok) {
    throw new Error(`OAuth fixture consent failed with HTTP ${consent.status}.`);
  }
  await task(
    "OAuth retry succeeds",
    "call_tool",
    {
      address: "oauth-recoverable.whoami",
      args: {},
      resultMode: "value",
    },
    (result) =>
      pass(result.isError !== true && objectValue(result).ok === true, {
        outcome: "oauth-recovered",
        recovery: "success",
      }),
  );
  await task(
    "OAuth unavailable recovery is explicit",
    "authorize_connector",
    { connector: "oauth-unavailable" },
    (result) =>
      pass(result.isError === true, {
        outcome: "oauth-recovery-unavailable",
        recovery: "unavailable",
        messagePreview: textContent(result)?.slice(0, 160) ?? null,
      }),
  );

  await task(
    "static credential call requires recovery",
    "call_tool",
    {
      address: "static-recoverable.whoami",
      args: {},
      resultMode: "value",
    },
    (result) =>
      pass(objectValue(result).ok === false && errorCode(result) === "auth_required", {
        outcome: "static-auth-required",
        errorCode: errorCode(result) ?? null,
      }),
  );
  await task(
    "current static agent recovery reaches its boundary",
    "authorize_connector",
    { connector: "static-recoverable" },
    (result) =>
      pass(result.isError === true, {
        outcome: "static-agent-handoff-missing",
        recovery: "operator-required",
        messagePreview: textContent(result)?.slice(0, 160) ?? null,
      }),
  );
  const configured = await fetch(
    `${baseUrl}/fixture/static-recoverable/configure`,
    {
      method: "POST",
      headers: { "x-connecta-eval-operator": operatorToken },
    },
  );
  if (!configured.ok) {
    throw new Error(
      `Static operator fixture failed with HTTP ${configured.status}.`,
    );
  }
  await task(
    "static credential retry succeeds after operator update",
    "call_tool",
    {
      address: "static-recoverable.whoami",
      args: {},
      resultMode: "value",
    },
    (result) =>
      pass(result.isError !== true && objectValue(result).ok === true, {
        outcome: "static-recovered",
        recovery: "success",
      }),
  );
  await task(
    "static unavailable recovery is explicit",
    "authorize_connector",
    { connector: "static-unavailable" },
    (result) =>
      pass(result.isError === true, {
        outcome: "static-recovery-unavailable",
        recovery: "unavailable",
        messagePreview: textContent(result)?.slice(0, 160) ?? null,
      }),
  );
  await task(
    "activity remains payload-free",
    "call_tool",
    {
      address: "controlled.activity_snapshot",
      args: {},
      resultMode: "value",
    },
    (result) => {
      const value = objectValue(result);
      const snapshot = value.data ?? {};
      return pass(
        value.ok === true &&
          Array.isArray(snapshot.forbiddenPresent) &&
          snapshot.forbiddenPresent.length === 0,
        {
          outcome: "activity-payload-free",
          eventCount: snapshot.eventCount ?? null,
          activityKeys: snapshot.keys ?? [],
          forbiddenPresent: snapshot.forbiddenPresent ?? null,
        },
      );
    },
  );

  return {
    summary: {
      caseCount: cases.length,
      passed: cases.filter((entry) => entry.passed).length,
      failed: cases.filter((entry) => !entry.passed).length,
      taskSuccessRate:
        cases.length === 0
          ? 0
          : cases.filter((entry) => entry.passed).length / cases.length,
      roundTrips: cases.length,
      summedLatencyMs: cases.reduce(
        (sum, entry) => sum + entry.latencyMs,
        0,
      ),
    },
    cases,
  };
}
