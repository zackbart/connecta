// The core's services, as Effect code sees them.
//
// A registry's storage programs read the deployment's KVStorage and Logger
// from their context rather than from arguments threaded through every call.
// Each Registry provides its own pair (`runOnPartition` in
// src/runtime/storage.ts), because a personal registry's storage is the
// root's namespaced to its principal. There is no per-Connecta runtime:
// createConnecta resolves its configuration into plain values once
// (src/config.ts), and the request pipeline runs on no runtime so `/health`
// and a closed deployment's 503 keep answering after `close()`.

import { Context } from "effect";
import type { KVStorage, Logger as LoggerShape } from "../types.js";

/**
 * A registry's KVStorage partition. Every adapter implements `list` and
 * `compareAndSet`.
 */
export class Storage extends Context.Service<Storage, KVStorage>()("connecta/Storage") {}

/**
 * Connecta's diagnostic logger, already resolved: the configured Logger, a
 * no-op for `"silent"`, or console output prefixed `[connecta]`. Effect's
 * own logger is never used (test/purity.node.test.ts), because it honors neither
 * `"silent"` nor the line format a deployment greps for.
 */
export class Logger extends Context.Service<Logger, LoggerShape>()("connecta/Logger") {}
