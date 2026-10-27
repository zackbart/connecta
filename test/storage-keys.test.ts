import { expect, it } from "vitest";
import {
  accessTokenKeys,
  catalogKeys,
  credentialKeys,
  kvCopyKeys,
  oauthConnectKeys,
  oauthFlowKeys,
  oauthHandoffKeys,
  oauthV2Keys,
  resultKeys,
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
    () => oauthV2Keys.value(oauthV2Keys.field.tokens, bad),
    () => oauthConnectKeys.used(bad),
    () => kvCopyKeys.cursor(bad),
  ];
  for (const build of builders) {
    expect(build).toThrow(/U\+0000 \(NUL\)/);
  }
});
