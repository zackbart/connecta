import { Effect } from "effect";
import { RequestSecrets } from "../../http/services.js";
import type { ConnectOptions } from "../../http/vendor.js";
import type { SafetyOptions } from "../../http/safety.js";
import { googleSafety } from "../_shared/google/kit.js";
import { pathWithholds } from "../_shared/rest/value-safety.js";
import type { Operation } from "../../http/vendor.js";

/** ImageProperties.contentUri delegates the requester's image access for 30 minutes.
 * Keep ordinary authored links/sourceUri, but withhold that vendor capability on
 * every document response, including tabs, headers and suggested image changes.
 */
export function docsSafety(operations: readonly Operation[]): SafetyOptions {
  const base = googleSafety("Google Docs", operations);
  return {
    ...base,
    reviewed: {
      ...base.reviewed!,
      redact: (data) => {
        const visit = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(visit);
          if (!value || typeof value !== "object") return value;
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              key === "imageProperties" && child && typeof child === "object" && !Array.isArray(child)
                ? Object.fromEntries(
                    Object.entries(child).map(([field, item]) => [
                      field,
                      field === "contentUri" ? "[redacted]" : visit(item),
                    ]),
                  )
                : visit(child),
            ]),
          );
        };
        return visit(data);
      },
      withholds: () => pathWithholds({ paths: ["imageProperties.contentUri"], anyDepth: true }),
    },
  };
}

/** Check the source lane across runs/paragraphs before either rendering or
 * hatch selection can split an echoed secret into individually short values. */
export const docsResult: NonNullable<ConnectOptions["result"]> = (data) =>
  RequestSecrets.use((secrets) =>
    Effect.sync(() => {
      const runs: Record<string, unknown>[] = [];
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const run = (value as Record<string, unknown>)["textRun"];
        if (run && typeof run === "object" && typeof (run as Record<string, unknown>)["content"] === "string")
          runs.push(run as Record<string, unknown>);
        for (const child of Object.values(value)) visit(child);
      };
      visit(data);
      const safe = secrets.parts(runs.map((run) => run["content"] as string));
      runs.forEach((run, index) => {
        run["content"] = safe[index];
      });
      return data;
    }),
  );
