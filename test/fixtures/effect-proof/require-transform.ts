import * as server from "../../../src/server.js";

if (Reflect.get(server, "CONNECTA_PROOF_ROUTER_TRANSFORM") !== true) {
  throw new Error("Proof router candidate transform was not applied in this Vitest runtime");
}
