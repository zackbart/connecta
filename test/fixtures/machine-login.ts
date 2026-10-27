// A synthetic kit provider keeps machine-grant lifetime and renewal coverage
// independent of the maintained provider roster.
import { Effect, Schema } from "effect";
import { optionsOf } from "../../src/config-schema.js";
import { PROVIDER_COMMON } from "../../src/connectors/option-shapes.js";
import { ConnectorCallError } from "../../src/errors.js";
import { Refusal } from "../../src/http/errors.js";
import { bearer } from "../../src/http/oauth.js";
import { defineApiProvider } from "../../src/http/provider.js";
import { Credentials, Signal } from "../../src/http/services.js";
import { read, write } from "../../src/http/tools.js";
import type { ProviderOptions } from "../../src/provider.js";
import type { CallServices } from "../../src/http/services.js";
import { get, post, vendor } from "../../src/http/vendor.js";

const listItems = get("listItems", "/items", { success: Schema.Unknown });
const createItem = post("createItem", "/items", { payload: Schema.Unknown, success: Schema.Unknown });
export function machineLogin(id: string) {
  let token: string | undefined;
  let renewed = false;
  const login = Effect.gen(function* () {
    const values = yield* (yield* Credentials).values.pipe(
      Effect.mapError((error) => new Refusal({ error })),
    );
    const signal = yield* Signal;
    token = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch("https://machine.example/login", {
          method: "POST", body: JSON.stringify(values), ...(signal ? { signal } : {}),
        });
        return ((await response.json()) as { accessToken: string }).accessToken;
      },
      catch: () => new Refusal({ error: new ConnectorCallError("auth_required", "Machine login failed.") }),
    });
    return token;
  });
  const factory = defineApiProvider<ProviderOptions>({
    name: "machine", title: "Machine",
    options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
    skill: { content: "Read and create fixture items.", instructionsHeading: "Instructions" },
    vendor: vendor("Machine", listItems, createItem),
    baseUrl: () => "https://machine.example",
    maxResponseBytes: 4096,
    credential: { label: "Machine auth", fields: [{ name: "clientId", label: "id" }, { name: "clientSecret", label: "secret" }] },
    grant: () => Effect.gen(function* () {
      const services = yield* Effect.context<CallServices>();
      const useLogin = login.pipe(Effect.provideContext(services));
      return {
      token: Effect.suspend(() => token ? Effect.succeed(token) : useLogin),
      refresh: () => Effect.suspend(() => {
        if (renewed) return Effect.succeed(token!);
        renewed = true;
        return useLogin;
      }),
      rejected: Effect.fail(new Refusal({ error: new ConnectorCallError("auth_required", "Machine rejected the token.") })),
    }; }),
    authenticate: bearer,
    errors: {
      provider: "Machine", facts: () => ({}), detail: ({ status }) => `Machine returned HTTP ${status}.`,
      unreadable: "Machine returned invalid JSON.", statuses: { 401: () => ({ code: "auth_required" }), 403: () => ({ code: "provider_permission_denied" }), 404: () => ({ code: "not_found" }) },
    },
    safety: () => ({ review: "Synthetic fixture items contain no stored secrets.", sensitiveFields: { names: [], choice: "drop" } }),
    probe: { operation: listItems, request: {}, describe: () => "Connected" },
    guide: () => ({ context: [], summary: "Fixture items" }),
    tools: ({ connection }) => [
      read(connection, { name: "list_items", description: "List fixture items", input: Schema.Struct({}), output: Schema.Unknown,
        run: () => connection.send(listItems, {}).pipe(Effect.map(({ data }) => data)) }),
      write(connection, { name: "create_item", description: "Create a fixture item", input: Schema.Struct({}), output: Schema.Unknown, destructive: true,
        run: () => connection.send(createItem, { payload: {} }).pipe(Effect.map(({ data }) => data)) }),
    ],
  });
  return factory(id, { purpose: "Machine grant regression" });
}
