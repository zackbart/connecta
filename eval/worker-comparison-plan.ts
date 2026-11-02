/** Fixed before model trials; never select tasks from observed scores. */
import { COMPARISON_TASKS, ACTIVE_TASKS } from "./tasks/index.js";
import { workerRefusal } from "./deploy/targets.js";
export const WORKER_COMPARISON = [
  ...COMPARISON_TASKS.filter((task) => !workerRefusal(task)).map((task) => ({
    id: task.id,
    category: /join|supabase|revenuecat|connecta-read/.test(task.id)
      ? "reduction/join"
      : /paging|export/.test(task.id)
        ? "paging"
        : /write|stale-close|refusal/.test(task.id)
          ? "writes/recovery"
          : /absent|auth/.test(task.id)
            ? "discovery"
            : "known read",
  })),
  ...ACTIVE_TASKS.filter((task) => task.id.startsWith("pco-step2-")).map((task) => ({
    id: task.id,
    category: /join|filtered/.test(task.id)
      ? "reduction/join"
      : /paging/.test(task.id)
        ? "paging"
        : /once|recovery/.test(task.id)
          ? "writes/recovery"
          : "discovery",
    largeCatalog: true,
  })),
];
export const WORKER_DECISION_RULE =
  "Code earns its place if native beats native-no-code on pass rate, or on model turns or tokens on reduction/join/paging tasks without a pass-rate loss elsewhere. Six should stop being the default for bounded pools if native matches its pass rate with no extra duplicate writes and takes fewer turns. Anything short is inconclusive.";
