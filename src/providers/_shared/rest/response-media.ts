import type { OperationRef } from "../../../http/errors.js";

/** Match a reviewed non-JSON success media type only on its pinned operation. */
export function responseMedia(
  media: Readonly<Record<string, readonly string[]>>,
  status: number,
  operation: OperationRef,
  contentType = "",
): "text" | "binary" | undefined {
  if (status < 200 || status > 299) return undefined;
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const path = operation.template.replace(/:([^/]+)/g, "{$1}");
  if (
    !type ||
    !media[`${operation.method} ${path}`]?.some(
      (declared) => declared === type || (declared.endsWith("/*") && type.startsWith(declared.slice(0, -1))),
    )
  )
    return undefined;
  return /^text\/|\bxml\b|\bcsv\b|\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type) ? "text" : "binary";
}
