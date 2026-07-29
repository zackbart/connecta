# Code mode

Code mode adds one optional meta-tool, `execute_code`, for dependent read-only
workflows, loops, joins, and reducing large connector results before they enter
the model context. It is a deploy-time capability, not a runtime preference.

## Capability contract

The `executor` passed to `createConnecta()` is the complete switch:

- omit `executor` and `tools/list` contains exactly the nine base meta-tools;
- provide a live `Executor` and `tools/list` also contains `execute_code`.

There is no separate feature flag. Connecta never advertises a code tool that
it plans to discover or initialize later. Changing whether a deployment offers
code mode means changing its executor configuration and redeploying.

The always-loaded instructions and tool descriptions say “when available”
because clients connected to an executor-free deployment retain the normal
`call_tool` and `batch_call` paths. One straightforward call belongs in
`call_tool`; two to ten independent calls belong in `batch_call`. Code mode
earns its larger definition only when the workflow has dependencies, loops,
joins, branching, or meaningful result reduction.

## Configure an executor

On Node, install the optional `quickjs-emscripten` peer and use the package's
QuickJS subpath:

```ts
import { createConnecta } from "@zackbart/connecta";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";

const connecta = createConnecta({
  executor: quickJsExecutor(),
  // connectors, auth, storage…
});
```

`quickJsExecutor()` runs each program in a disposable child-process sandbox.
Its CPU, wall-time, memory, stack, queue, result, log, and IPC bounds are
configured on the executor. Server bundlers must keep the
`@zackbart/connecta/quickjs` package files external so the child entry remains
on disk. The [Node example](../examples/node/README.md) is enabled; remove its
`executor` field to see the nine-tool deployment.

On Cloudflare Workers, the Worker Loader binding is both the paid capability
and the configuration switch:

```ts
createConnecta({
  ...(env.LOADER
    ? { executor: new DynamicWorkerExecutor({ loader: env.LOADER }) }
    : {}),
  // connectors, auth, storage…
});
```

Leave the binding absent on the Workers Free plan. Its absence must also be
represented as optional in the deployment's `Env` type. The
[Worker example](../examples/worker/README.md#code-mode) carries the complete
binding and package setup.

## Sandbox boundary

Model-written code has no ambient network, filesystem, environment, timers, or
imports. Its only capabilities are:

- lazy connector globals for explicitly read-only tools;
- `connecta.call()` and `connecta.batch()` for exact-address read-only calls;
- `connecta.search()` and `connecta.describe()` for request-local discovery;
  schema-bearing search matches also expose `inputKeys`,
  `requiredInputKeys`, and `outputKeys` so one program can check exact field
  names before continuing to a dependent call;
- captured `console.*` output.

The key lists are derived by the same walk that renders the compact schema, so
they resolve a top-level `$ref` and compose `allOf` instead of disagreeing with
the shape printed beside them. A schema that is not an object at all — a union,
an array, an unresolvable `$ref` — gets no lists rather than empty ones: absent
means "read the schema", where `[]` would claim the tool takes no fields. The
metadata is code-mode-only; `search_tools` never carries it, and a program that
wants the bytes back can pass `includeSchemaKeys: false`.

All calls use the same catalog, fail-closed read-only predicate, admission,
cancellation, timeout classification, health, credential containment, and
payload-free activity events as the ordinary meta-tools. Unannotated,
write-capable, or destructive work must leave the sandbox and cross
`call_destructive_tool`, where the MCP host can ask a human.

Never implement this seam with unsandboxed `eval` or `node:vm`.

## Verify the surface

`test/server.test.ts` calls `tools/list` with and without a live executor and
asserts the exact nine- and ten-tool surfaces. The current-version release audit
supports the same comparison:

```sh
npm --prefix eval/current-version run audit
npm --prefix eval/current-version run audit -- --executor disabled
```

The results record whether `execute_code` was advertised plus the complete
definition, request, response, latency, and task-success surfaces.
