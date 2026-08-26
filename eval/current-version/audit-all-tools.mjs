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

function programValue(result) {
  return objectValue(result).result;
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
    "execute_code",
    { code: "async () => await connecta.search({})" },
    (result) => {
      const tools = programValue(result)?.tools;
      return pass(
        Array.isArray(tools) &&
          tools.some((tool) => tool.address === "projects.list_issues"),
        {
          outcome: "inventory-returned",
          capability: "catalog inventory",
          route: "connecta.search",
          returned: tools?.length ?? 0,
        },
      );
    },
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
    "execute_code",
    {
      code:
        'async () => await connecta.describe({ addresses: ["controlled.records"], format: "json" })',
    },
    (result) => {
      const tools = programValue(result)?.tools;
      return pass(Array.isArray(tools) && tools.length === 1, {
        outcome: "schema-described",
        capability: "schema description",
        route: "connecta.describe",
      });
    },
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
      args: { paragraphs: 200 },
      resultMode: "value",
      diagnostics: true,
    },
    (result) => {
      const value = objectValue(result);
      return pass(
        value.ok === true &&
          value.data?.truncated === true &&
          typeof value.data?.resultId === "string" &&
          value.data?.totalBytes >= 40_000,
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
    "execute_code",
    {
      code:
        "async () => await connecta.batch([" +
        '{ address: "controlled.read_record", args: { id: 11 } },' +
        '{ address: "controlled.read_record", args: { id: 12 } }' +
        "])",
    },
    (result) => {
      const value = programValue(result);
      return pass(
        Array.isArray(value) &&
          value.length === 2 &&
          value.every((entry) => entry.ok === true),
        {
          outcome: "batch-succeeded",
          capability: "parallel calls",
          route: "connecta.batch",
          resultCount: value?.length ?? 0,
        },
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
          value.recovery === "oauth" &&
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
    "static recovery returns an operator handoff",
    "authorize_connector",
    { connector: "static-recoverable" },
    (result) => {
      const value = objectValue(result);
      return pass(
        result.isError !== true &&
          value.recovery === "operator_config" &&
          typeof value.operatorUrl === "string",
        {
          outcome: "static-operator-handoff",
          recovery: value.recovery ?? null,
          hasOperatorUrl: typeof value.operatorUrl === "string",
        },
      );
    },
  );
  const configured = await fetch(
    `${baseUrl}/ui/credentials/static-recoverable`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        origin: baseUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: "sandbox-ok" }),
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
    (result) => {
      const value = objectValue(result);
      return pass(
        result.isError !== true && value.recovery === "unavailable",
        {
        outcome: "static-recovery-unavailable",
        recovery: value.recovery ?? null,
        messagePreview: textContent(result)?.slice(0, 160) ?? null,
        },
      );
    },
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
