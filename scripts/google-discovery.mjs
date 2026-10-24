// Build-time only. Original bytes stay pinned separately from this conversion.
export const GOOGLE_DISCOVERY_FORMAT = "google-discovery-v1";

export function discoveryMethods(discovery) {
  const methods = [];
  const visit = (resource) => {
    methods.push(...Object.values(resource.methods ?? {}));
    for (const child of Object.values(resource.resources ?? {})) visit(child);
  };
  visit(discovery);
  return methods;
}

/** Comparison mode deliberately retains the historical #/schemas pointers. */
export function discoveryRefs(value, prefix = "#/schemas/") {
  if (Array.isArray(value)) return value.map((child) => discoveryRefs(child, prefix));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "enumDescriptions")
      .map(([key, child]) => [
        key,
        key === "$ref" && typeof child === "string" && !child.startsWith("#")
          ? `${prefix}${child}`
          : discoveryRefs(child, prefix),
      ]),
  );
}

const ROOTS = {
  gmail: "/gmail/v1/users/me",
  drive: "/drive/v3",
  docs: "/v1",
  sheets: "/v4",
  slides: "/v1",
  forms: "/v1",
};
const GLOBALS = new Set(["fields", "prettyPrint"]);
// Reviewed action vocabulary supplements original ids/nouns, never negates
// another operation. Product-specific summaries can refine these defaults.
const ACTIONS = {
  get: "Get read retrieve",
  list: "List find search",
  create: "Create add",
  update: "Update edit modify",
  patch: "Patch update edit",
  delete: "Delete remove",
  batchUpdate: "Batch update edit",
  batchGet: "Batch get read",
  batchDelete: "Batch delete remove",
  batchModify: "Batch modify update",
  append: "Append add rows",
  clear: "Clear erase values",
  send: "Send deliver",
  trash: "Trash move to trash",
  untrash: "Untrash restore",
  generateCseToken: "Generate mint CSE access token",
  getProfile: "Get read mailbox profile",
  getByDataFilter: "Get read by data filter",
  batchGetByDataFilter: "Batch get read by data filter",
  getThumbnail: "Get generate thumbnail",
};

export function canonicalDiscovery(value) {
  if (Array.isArray(value)) return value.map(canonicalDiscovery);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalDiscovery(value[key])]),
  );
}

function schemaOf(raw, request = false, method, reference = (name) => `Input_${name}`) {
  if (!raw || typeof raw !== "object") return {};
  const out = raw.$ref ? { $ref: `#/components/schemas/${request ? reference(raw.$ref) : raw.$ref}` } : {};
  for (const key of ["type", "format", "description", "enum", "pattern", "default", "readOnly", "deprecated"])
    if (raw[key] !== undefined) out[key] = raw[key];
  for (const key of ["minimum", "maximum"])
    if (raw[key] !== undefined && Number.isFinite(Number(raw[key]))) out[key] = Number(raw[key]);
  if (raw.items) out.items = schemaOf(raw.items, request, method, reference);
  if (raw.properties) {
    out.properties = Object.fromEntries(
      Object.entries(raw.properties)
        .filter(
          ([, value]) => !request || !(value.readOnly === true || /^Output only\./i.test(value.description ?? "")),
        )
        .map(([key, value]) => [key, schemaOf(value, request, method, reference)]),
    );
  }
  if (raw.additionalProperties !== undefined)
    out.additionalProperties =
      typeof raw.additionalProperties === "boolean"
        ? raw.additionalProperties
        : schemaOf(raw.additionalProperties, request, method, reference);
  else if (raw.type === "object" && !Object.keys(raw.properties ?? {}).length) out.additionalProperties = true;
  if (Array.isArray(raw.required)) out.required = raw.required;
  if (request && raw.properties) {
    const required = Object.entries(raw.properties)
      .filter(
        ([key, value]) =>
          out.properties[key] && (value.required === true || value.annotations?.required?.includes(method)),
      )
      .map(([key]) => key);
    if (required.length) out.required = [...new Set([...(out.required ?? []), ...required])];
  }
  return out;
}

/** Specialize only the affected reachable input graph, including recursive parents. */
function methodInput(discovery, method, schemas) {
  const reachable = new Map();
  const scan = (value, refs, required) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) refs.add(value.$ref);
    if (value.annotations?.required?.includes(method.id)) required.value = true;
    for (const child of Object.values(value)) scan(child, refs, required);
  };
  const visit = (name) => {
    if (reachable.has(name)) return;
    const refs = new Set(),
      required = { value: false };
    scan(discovery.schemas[name], refs, required);
    reachable.set(name, { refs, required });
    for (const ref of refs) visit(ref);
  };
  visit(method.request.$ref);
  const changed = new Set([...reachable].filter(([, node]) => node.required.value).map(([name]) => name));
  for (let previous = -1; previous !== changed.size;) {
    previous = changed.size;
    for (const [name, node] of reachable) if ([...node.refs].some((ref) => changed.has(ref))) changed.add(name);
  }
  const reference = (name) => (changed.has(name) ? `Input_${method.id.replaceAll(".", "_")}_${name}` : `Input_${name}`);
  for (const name of changed) schemas[reference(name)] = schemaOf(discovery.schemas[name], true, method.id, reference);
  return reference(method.request.$ref);
}

/** Complete inventory, no execution verdicts. Products own literal admission tables. */
export function normalizeDiscovery(discovery, { summaries = {} } = {}) {
  if (discovery?.kind !== "discovery#restDescription" || !ROOTS[discovery.name])
    throw new Error("Expected a supported Google Workspace Discovery document.");
  const root = ROOTS[discovery.name];
  const schemas = Object.fromEntries(
    Object.entries(discovery.schemas ?? {}).flatMap(([name, schema]) => [
      [name, schemaOf(schema)],
      [`Input_${name}`, schemaOf(schema, true)],
    ]),
  );
  const paths = {},
    mapping = [];
  for (const method of discoveryMethods(discovery)) {
    const original = `/${discovery.servicePath ?? ""}${method.flatPath ?? method.path}`.replace(/\/{2,}/g, "/");
    const full = original.replace(/\{\+([^}]+)\}/g, "{$1}");
    // Only the source-owned Gmail userId is fixed. Never strip caller prefixes.
    const fixed = discovery.name === "gmail" ? full.replace("/users/{userId}", "/users/me") : full;
    // Out-of-mailbox settings remain searchable, with a non-callable source-relative path.
    const path = fixed.startsWith(`${root}/`) ? fixed.slice(root.length) : fixed;
    if (!path.startsWith("/")) throw new Error(`Invalid Discovery path: ${path}`);
    const verb = String(method.httpMethod).toLowerCase();
    const variables = (text) => [...text.matchAll(/\{\+?([^}]+)\}/g)].map((match) => match[1]);
    const originalVariables = variables(method.path);
    const flatVariables = variables(method.flatPath ?? method.path);
    const pathVariables = variables(path);
    const pathName = (name) => {
      if (pathVariables.includes(name)) return name;
      const at = originalVariables.indexOf(name);
      if (originalVariables.length === flatVariables.length && at >= 0 && pathVariables.includes(flatVariables[at]))
        return flatVariables[at];
      throw new Error(`Cannot reconcile ${method.id} path parameter ${name} with ${path}`);
    };
    paths[path] ??= {};
    if (paths[path][verb]) throw new Error(`Duplicate normalized operation: ${verb.toUpperCase()} ${path}`);
    const globals = Object.fromEntries(Object.entries(discovery.parameters ?? {}).filter(([key]) => GLOBALS.has(key)));
    const parameters = Object.entries({ ...globals, ...method.parameters })
      .filter(([name]) => !(discovery.name === "gmail" && name === "userId"))
      .filter(
        ([name]) =>
          !["access_token", "oauth_token", "key", "callback", "upload_protocol", "uploadType", "alt"].includes(name),
      )
      .map(([name, parameter]) => ({
        name: parameter.location === "path" ? pathName(name) : name,
        in: parameter.location,
        required: parameter.required === true,
        ...(parameter.deprecated === true ? { deprecated: true } : {}),
        ...(parameter.description ? { description: parameter.description } : {}),
        ...(parameter.repeated ? { style: "form", explode: true } : {}),
        schema: parameter.repeated ? { type: "array", items: schemaOf(parameter) } : schemaOf(parameter),
      }));
    const declared = parameters.filter((parameter) => parameter.in === "path").map((parameter) => parameter.name);
    if (JSON.stringify([...declared].sort()) !== JSON.stringify([...pathVariables].sort()))
      throw new Error(`Discovery path parameters do not match ${method.id}: ${path}`);
    const input = method.request?.$ref ? methodInput(discovery, method, schemas) : undefined;
    const parts = method.id.split(".").slice(1);
    const action = parts.pop();
    const words = `${ACTIONS[action] ?? action} ${parts.join(" ")}`.replace(/([a-z])([A-Z])/g, "$1 $2");
    paths[path][verb] = {
      operationId: method.id,
      summary: summaries[method.id] ?? words,
      description: method.description ?? words,
      tags: [method.id.split(".").slice(1, -1).join(".")],
      "x-scopes": method.scopes ?? [],
      "x-google-source-path": original,
      ...(method.deprecated === true ? { "x-google-deprecated": true } : {}),
      parameters,
      ...(method.request?.$ref
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: `#/components/schemas/${input}` } },
              },
            },
          }
        : {}),
      responses: {
        200: {
          description: "Success",
          ...(method.response?.$ref
            ? {
                content: { "application/json": { schema: { $ref: `#/components/schemas/${method.response.$ref}` } } },
              }
            : {}),
        },
      },
    };
    mapping.push({
      id: method.id,
      source: `${method.httpMethod} ${original}`,
      operation: `${method.httpMethod} ${path}`,
    });
  }
  return canonicalDiscovery({
    openapi: "3.1.0",
    info: { title: discovery.title, version: discovery.version },
    servers: [{ url: `${new URL(discovery.rootUrl).origin}${root}` }],
    paths,
    components: {
      schemas,
    },
    "x-google-discovery": {
      format: GOOGLE_DISCOVERY_FORMAT,
      revision: discovery.revision,
      mapping: mapping.sort((a, b) => a.id.localeCompare(b.id)),
    },
  });
}
