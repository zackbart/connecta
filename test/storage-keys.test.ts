import { expect, it } from "vitest";
import {
  accessTokenKeys,
  catalogKeys,
  credentialKeys,
  oauthConnectKeys,
  oauthFlowKeys,
  oauthHandoffKeys,
  resultKeys,
  responseCacheKeys,
  scopes,
} from "../src/storage/keys.js";

it("rejects NUL in every unencoded key component, including identity scopes", () => {
  const bad = "a\0b";
  const builders = [
    () => scopes.principal(bad),
    () => scopes.subject(bad),
    () => scopes.connector(bad),
    () => resultKeys.chunk(bad, 0),
    () => resultKeys.chunk(bad, 1),
    () => catalogKeys.manifest(bad),
    () => catalogKeys.chunk(bad, "rev", 1),
    () => catalogKeys.chunk("svc", bad, 1),
    () => oauthHandoffKeys.handoff(bad, "hash"),
    () => oauthHandoffKeys.handoff("svc", bad),
    () => accessTokenKeys.record(bad),
    () => accessTokenKeys.lookup(bad),
    () => accessTokenKeys.agent(bad),
    () => credentialKeys.credential(bad),
    () => credentialKeys.credential("svc", bad),
    () => oauthFlowKeys.flow(bad),
    () => oauthConnectKeys.used(bad),
  ];
  for (const build of builders) {
    expect(build).toThrow(/U\+0000 \(NUL\)/);
  }
});

it("locates the same response cache entries as namespace plus entry", () => {
  for (const [id, config, generation, partition] of [
    ["crm", "config", "generation", "private"],
    ["crm:%_?'", "config::%_?'", "gen:%_?'", "owner:%_?'"],
    ["", "", "", ""],
  ] as const) {
    const prefix = responseCacheKeys.locatorPrefix(id, config);
    const expected = responseCacheKeys.entry(responseCacheKeys.namespace(id, config, generation), partition);
    expect(responseCacheKeys.locatedEntry(prefix, generation, partition)).toBe(expected);
    expect(prefix + generation + responseCacheKeys.locatorSeparator + partition).toBe(expected);
  }
});
