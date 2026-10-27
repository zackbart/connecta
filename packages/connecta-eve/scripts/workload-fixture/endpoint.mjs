// Derived from the retained #1040 fixture. No persistent data or model calls.
import { createConnecta, api, memoryStorage, customExecutor } from "@zackbart/connecta";

export function endpoint(binding, onRead = () => {}, onLifecycle = () => {}) {
  return createConnecta({
    readOnly: true,
    storage: memoryStorage(),
    agents: [{ name: "assistant", vercel: binding }],
    pools: {
      assistant: {
        tools: ["crm"],
        members: ["agent:assistant"],
        surface: "native",
        executeCode: false,
        description: "Disposable workload identity proof",
      },
    },
    connectors: [
      api("crm", {
        tools: [
          {
            name: "read",
            description: "Read one deterministic proof record",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            handler: async (args, ctx) => {
              onRead(args.id);
              if (args.id === "cancellation-probe") {
                onLifecycle("handler-started", false);
                await new Promise((accept, reject) => {
                  const timer = setTimeout(() => {
                    ctx.signal.removeEventListener("abort", cancel);
                    onLifecycle("handler-completed", false);
                    accept();
                  }, 8_000);
                  function cancel() {
                    clearTimeout(timer);
                    onLifecycle("handler-cancelled", ctx.signal.aborted);
                    reject(new Error("fixture cancelled"));
                  }
                  if (ctx.signal.aborted) cancel();
                  else ctx.signal.addEventListener("abort", cancel, { once: true });
                });
              }
              return { id: args.id, fixture: 1040 };
            },
          },
        ],
      }),
    ],
    executor: customExecutor(
      {
        execute: async () => {
          throw new Error("Code surface disabled");
        },
      },
      { lifecycle: "self-managed" },
    ),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

export function selectBinding(expected, variant) {
  switch (variant) {
    case "positive":
      return { team: expected.team, project: expected.project };
    case "wrong-team":
      return { team: "team_refused", project: expected.project };
    case "wrong-project":
      return { team: expected.team, project: "prj_refused" };
    case "wrong-environment":
      return { team: expected.team, project: expected.project, environments: ["development"] };
    default:
      throw new Error("Unknown fixture variant");
  }
}
