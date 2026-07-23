export const CONNECTA_INSTRUCTIONS =
  'Connecta exposes many integrations behind meta-tools. When an address is unknown, start with search_tools and includeSchemas="compact"; use describe_tools only when that schema is insufficient. Use call_tool for one explicitly read-only call, batch_call for 2–10 independent explicitly read-only calls, and execute_code (when available) only for dependent read-only steps, loops, joins, or reducing large results. Unannotated, write-capable, and destructive tools must use call_destructive_tool individually. Use authorize_connector only after auth_required and get_result only for truncated results. For the detailed workflow, call skills({ name: "usage" }) once per task.';

export const USAGE_SKILL = `# Connecta usage

## Choose the smallest execution tool

- Unknown address: \`search_tools({ query, includeSchemas: "compact" })\`.
- Schema still unclear: \`describe_tools({ addresses: [...] })\`.
- One explicitly read-only call: \`call_tool\`.
- Two to ten independent explicitly read-only calls: \`batch_call\`.
- Dependent read-only calls, loops, joins, branching, or large-result reduction: \`execute_code\` when available.
- Any unannotated, write-capable, or destructive call: \`call_destructive_tool\`, individually and only after reviewing its schema and consequences.
- Truncated result: retry with \`fields\` when possible; otherwise page it with \`get_result\`.
- \`auth_required\`: use \`authorize_connector\`, have the operator complete consent, then confirm with \`list_connectors\`.

Use \`list_connectors({ probe: false })\` for a fast inventory. Use \`probe: true\` only when diagnosing live health or authorization.

## Code mode

Use code mode when a later call depends on an earlier result, when joining across connectors, or when filtering or aggregating data in the sandbox will substantially shrink the response. Use \`Promise.all\` or \`connecta.batch\` for independent calls inside one execution.

Do not use code mode for one straightforward call, for independent calls already handled by \`batch_call\`, or for any tool not explicitly annotated \`readOnlyHint: true\`. Code mode has a bounded host-call budget and per-call deadline. Return only the reduced value the agent needs; do not return a large upstream payload unchanged.

## Examples

These addresses are illustrative; always use the exact address returned by \`search_tools\`.

Single call:
\`\`\`json
{ "address": "crm.get_account", "args": { "id": "acct_123" }, "resultMode": "value" }
\`\`\`

Independent calls:
\`\`\`json
{ "calls": [
  { "address": "crm.get_account", "args": { "id": "acct_123" } },
  { "address": "billing.list_invoices", "args": { "status": "open" } }
] }
\`\`\`

Dependent code with reduction:
\`\`\`js
async () => {
  const accounts = await crm.search_accounts({ query: "renewal" });
  const details = await Promise.all(
    accounts.results.slice(0, 5).map((account) =>
      crm.get_account({ id: account.id })
    )
  );
  return details.map(({ id, name, status }) => ({ id, name, status }));
}
\`\`\`
`;

export const AVAILABLE_SKILLS = [
  {
    name: "usage",
    description:
      "How to choose among Connecta discovery, direct, batch, destructive, and code-mode tools.",
    content: USAGE_SKILL,
  },
] as const;
