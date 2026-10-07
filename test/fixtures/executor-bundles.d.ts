declare module "virtual:connecta-minified-upstream" {
  export { DynamicWorkerExecutor } from "@cloudflare/codemode";
}
declare module "virtual:connecta-duplicate-worker" {
  export { workerExecutor } from "../../src/worker.js";
}
