/** Small, deterministic contracts reproducing provider prerequisites, not live accounts. */
import { z } from "zod";
import type { FakeTool } from "./service.js";

const read = { readOnlyHint: true, idempotentHint: true };
// Valid 32x32 RGB PNG. The first baseline used a 1x1 image with a bad IDAT CRC.
export const LEGACY_BADGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
export const BADGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNQKXChKWIYtWDUglELRi0YtWDUglELRi0YtWDUglELhooFAL8KYC6q5AcJAAAAAElFTkSuQmCC";

export const PREREQUISITE_GUIDES = {
  revenuecat:
    "Call list-projects first. list-subscriptions returns plain text, not JSON. Report gives_access rather than inferring access from status or expires_date.",
  supabase:
    "Call list_projects to resolve the exact project. execute_sql requires project_ref, not project_id. Never query a different project's database.",
} as const;

export function revenuecatTools(): FakeTool[] {
  let resolved = false;
  return [
    {
      name: "list-projects",
      description: "List projects",
      input: z.object({}),
      annotations: read,
      run: () => {
        resolved = true;
        return { json: { projects: [{ project_id: "rc_prod", name: "Production" }] } };
      },
    },
    {
      name: "list-subscriptions",
      description: "Plain-text subscription report; gives_access is authoritative",
      input: z.object({ project_id: z.string(), app_user_id: z.string() }),
      annotations: read,
      run: (args) =>
        resolved && args.project_id === "rc_prod" && args.app_user_id === "user_42"
          ? {
              text: "RevenueCat Production rc_prod\napp_user_id: user_42\nsubscription: sub_grace_42\nstatus: expired\ngives_access: true\nreason: billing grace period",
            }
          : { error: "Resolve project_id with list-projects; use user_42" },
    },
  ];
}

export function supabaseTools(): FakeTool[] {
  let resolved = false;
  return [
    {
      name: "list_projects",
      description: "List project references",
      input: z.object({}),
      annotations: read,
      run: () => {
        resolved = true;
        return {
          json: {
            projects: [
              { project_ref: "sb_prod_ref", name: "Production" },
              { project_ref: "sb_test_ref", name: "Sandbox" },
            ],
          },
        };
      },
    },
    {
      name: "execute_sql",
      description: "Read-only SQL query for a project_ref",
      input: z
        .object({ project_ref: z.string(), query: z.literal("select count(*) as count from public.orders") })
        .strict(),
      annotations: read,
      run: (args) =>
        resolved && args.project_ref === "sb_prod_ref"
          ? { json: { project_ref: "sb_prod_ref", rows: [{ count: 73 }] } }
          : { error: "Resolve the Production project_ref first" },
    },
  ];
}

export function assetTools(): FakeTool[] {
  return [
    {
      name: "get_badge",
      description: "Return the launch badge PNG and caption as JSON for program emission",
      input: z.object({}),
      annotations: read,
      run: () => ({ json: { data: BADGE_PNG, mimeType: "image/png", caption: "Launch badge: approved, revision 7" } }),
    },
    {
      name: "get_badge_image",
      description: "Return the launch badge as MCP text and image blocks",
      input: z.object({}),
      annotations: read,
      run: () => ({
        content: [
          { type: "text", text: "Launch badge: approved, revision 7" },
          { type: "image", data: BADGE_PNG, mimeType: "image/png" },
        ],
      }),
    },
  ];
}
