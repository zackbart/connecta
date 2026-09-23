/**
 * The shipped Worker example, unmodified, behind the Access stand-in. Its own
 * configuration decides everything else: KV storage, the Dynamic Worker
 * executor, the vault, the operator UI, and its two connectors.
 */
import example from "../../examples/worker/src/index.js";
import { withAccess } from "./access-shim.js";

export default withAccess(example as unknown as Parameters<typeof withAccess>[0]);
