// Stripe's two curated reads; the definition supplies the standard coverage hatch.
import { Effect, Schema } from "effect";
import { read } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import type { RestCall } from "../_shared/rest/kit.js";
import { connectedAccount, record, text, sendStripe, stripeIndex } from "./api.js";
import type { StripeApiKeyOptions } from "./index.js";
const NullableText = Schema.Union([Schema.String, Schema.Null]);
const NullableFlag = Schema.Union([Schema.Boolean, Schema.Null]);
export function stripeTools({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<StripeApiKeyOptions>;
}) {
  // Both named reads use the API origin; only the coverage binding needs files.
  const send = (call: RestCall) => sendStripe(connection, options, call, connection);
  const call = (path: string) => {
    const { op, params } = stripeIndex.resolve("GET", path);
    return send({ method: "GET", path, op, params, query: {}, body: undefined });
  };
  return [
    read(connection, {
      fields: true,
      name: "get_stripe_account_info",
      description:
        "Read the Stripe account this key reaches: id, name, country, default currency, mode, and connected account. Use it to confirm scope first.",
      input: Schema.Struct({}),
      output: Schema.Struct({
        accountId: Schema.String,
        name: Schema.optionalKey(NullableText),
        country: Schema.optionalKey(NullableText),
        defaultCurrency: Schema.optionalKey(NullableText),
        mode: Schema.Literals(["production", "sandbox"]),
        livemode: Schema.Boolean,
        connectedAccount: NullableText.annotate({ description: "Set when every call acts as this account." }),
        chargesEnabled: Schema.optionalKey(NullableFlag),
        payoutsEnabled: Schema.optionalKey(NullableFlag),
      }),
      run: () =>
        call("/v1/account").pipe(
          Effect.map(({ data }) => {
            const account = record(data),
              profile = record(account["business_profile"]),
              dashboard = record(record(account["settings"])["dashboard"]);
            return {
              accountId: String(account["id"] ?? ""),
              name: text(profile["name"]) ?? text(dashboard["display_name"]) ?? null,
              country: text(account["country"]) ?? null,
              defaultCurrency: text(account["default_currency"]) ?? null,
              mode: options.mode,
              livemode: options.mode === "production",
              connectedAccount: connectedAccount(options) ?? null,
              chargesEnabled: typeof account["charges_enabled"] === "boolean" ? account["charges_enabled"] : null,
              payoutsEnabled: typeof account["payouts_enabled"] === "boolean" ? account["payouts_enabled"] : null,
            };
          }),
        ),
    }),
    read(connection, {
      fields: true,
      name: "get_balance_summary",
      description:
        "Read the account's available and pending Stripe balance per currency, in minor units. Excludes balance transactions; list those with stripe_api_read.",
      input: Schema.Struct({}),
      output: Schema.Struct({
        livemode: Schema.Boolean,
        available: Schema.Array(Schema.Unknown).annotate({ description: "Funds available to pay out, per currency." }),
        pending: Schema.Array(Schema.Unknown).annotate({ description: "Funds not yet available, per currency." }),
        instantAvailable: Schema.optionalKey(Schema.Array(Schema.Unknown)),
        connectReserved: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
      run: () =>
        call("/v1/balance").pipe(
          Effect.map(({ data }) => {
            const balance = record(data);
            const amounts = (value: unknown) =>
              Array.isArray(value)
                ? value.map((entry) => ({ amount: record(entry)["amount"], currency: record(entry)["currency"] }))
                : [];
            return {
              livemode: balance["livemode"] === true,
              available: amounts(balance["available"]),
              pending: amounts(balance["pending"]),
              ...(Array.isArray(balance["instant_available"])
                ? { instantAvailable: amounts(balance["instant_available"]) }
                : {}),
              ...(Array.isArray(balance["connect_reserved"])
                ? { connectReserved: amounts(balance["connect_reserved"]) }
                : {}),
            };
          }),
        ),
    }),
  ];
}
