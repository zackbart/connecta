import { setImmediate } from "node:timers";

export const unsupportedAlias = () => new Promise<void>((resolve) => setImmediate(resolve));
