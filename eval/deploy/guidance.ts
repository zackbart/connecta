/** Eval-owned delivery interventions; never exported by the package. */
import type { Connecta } from "@zackbart/connecta";
import { PREREQUISITE_GUIDES } from "../fakes/prerequisites.js";

export const GUIDANCE_ARMS = ["pointer", "summary", "inline", "instruction-fetch"] as const;
export type GuidanceArm = (typeof GUIDANCE_ARMS)[number];
export function guidanceArm(): GuidanceArm | undefined {
  const arm = typeof process === "undefined" ? undefined : process.env.CONNECTA_EVAL_GUIDANCE;
  if (arm === undefined) return undefined;
  if (!GUIDANCE_ARMS.includes(arm as GuidanceArm)) throw new Error("Invalid CONNECTA_EVAL_GUIDANCE arm");
  return arm as GuidanceArm;
}

const guides: Record<string, string> = Object.fromEntries(
  Object.entries(PREREQUISITE_GUIDES).map(([id, content]) => [`connector:${id}`, content]),
);
export function guidanceValue(value: unknown, arm = guidanceArm()): unknown {
  if (!arm) return value;
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      return JSON.stringify(guidanceValue(JSON.parse(value), arm));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => guidanceValue(item, arm));
  if (!value || typeof value !== "object") return value;
  const row = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, guidanceValue(item, arm)]));
  if (typeof row.guide === "string" && guides[row.guide]) {
    if (arm !== "summary") delete row.guideSummary;
    if (arm === "inline") row.guideSummary = guides[row.guide];
  }
  if (arm === "instruction-fetch" && typeof row.instructions === "string") {
    row.instructions +=
      ' Before working with revenuecat or supabase, fetch its connector guide using skills({name:"connector:<id>"}) or connecta.skill("connector:<id>"). Follow it before data calls.';
  }
  return row;
}

/** Keep the actual transport, auth, dispatch and outcomes, changing only delivery. */
export function guidanceSurface(app: Connecta): Connecta {
  if (!guidanceArm()) return app;
  return {
    ...app,
    async fetch(request, env, ctx) {
      const response = await app.fetch(request, env, ctx);
      if (request.method !== "POST" || !response.ok) return response;
      const text = await response.text();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      const body = text.trimStart().startsWith("{")
        ? JSON.stringify(guidanceValue(JSON.parse(text)))
        : text
            .split("\n")
            .map((line) =>
              line.startsWith("data:") ? `data: ${JSON.stringify(guidanceValue(JSON.parse(line.slice(5))))}` : line,
            )
            .join("\n");
      return new Response(body, { status: response.status, headers });
    },
  };
}
