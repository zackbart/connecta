import { expect, it } from "vitest";
import {
  bindProviderResponse,
  dispatchProviderRequest,
  handoffProviderRequest,
  providerRequest,
  recordProviderResponse,
  renewedAfterUnauthorized,
  responseProviderRequest,
  takeProviderHandoff,
} from "../src/provider-call.js";
import type { ConnectorContext } from "../src/types.js";

it("INV-9: a sent request cannot be reset, changed, answered twice or dispatched again", () => {
  const request = providerRequest({} as ConnectorContext, false, "Tickets", { method: "GET" });
  dispatchProviderRequest(undefined, request, undefined, "POST");
  recordProviderResponse(request, 401);
  expect(request).toMatchObject({ dispatched: true, method: "POST", status: 401 });
  for (const [field, value] of [
    ["dispatched", false],
    ["method", "GET"],
    ["status", 200],
  ] as const) {
    expect(Reflect.set(request, field, value)).toBe(false);
    expect(Reflect.deleteProperty(request, field)).toBe(false);
  }
  expect(() => dispatchProviderRequest(undefined, request)).toThrow("already dispatched");
  expect(() => recordProviderResponse(request, 200)).toThrow("already answered");
  renewedAfterUnauthorized(request, "old", "old");
  expect(request.renewed).toBeUndefined();
  renewedAfterUnauthorized(request, "old", "fresh");
  renewedAfterUnauthorized(request, "old", "fresh");
  expect(Reflect.set(request, "renewed", false)).toBe(false);
  expect(request).toMatchObject({ dispatched: true, method: "POST", status: 401, renewed: true });
});

it("INV-9: a response identity cannot lend another guarded call its provenance", () => {
  const own = providerRequest({} as ConnectorContext, false, "Tickets");
  const other = providerRequest({} as ConnectorContext, false, "Tickets");
  const response = new Response(null, { status: 401 });
  bindProviderResponse(response, own, own);
  expect(responseProviderRequest(response, other)).toBeUndefined();
  expect(responseProviderRequest(response, own)).toBe(own);
});

it("INV-9: an unsent handoff is consumed once and cannot borrow a dispatched entry", () => {
  const request = providerRequest({} as ConnectorContext, false, "Tickets", { method: "POST" });
  const init = {};
  handoffProviderRequest(init, request);
  expect(takeProviderHandoff(init)).toBe(request);
  expect(takeProviderHandoff(init)).toBeUndefined();
  dispatchProviderRequest(undefined, request);
  expect(() => handoffProviderRequest(init, request)).toThrow("already dispatched");
  expect(takeProviderHandoff(init)).toBeUndefined();
});
