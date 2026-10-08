/** Small, deterministic contracts reproducing provider prerequisites, not live accounts. */
import { z } from "zod";
import type { FakeTool } from "./service.js";

const read = { readOnlyHint: true, idempotentHint: true };
// Valid 32x32 RGB PNG. The first baseline used a 1x1 image with a bad IDAT CRC.
export const LEGACY_BADGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
export const BADGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNQKXChKWIYtWDUglELRi0YtWDUglELRi0YtWDUglELhooFAL8KYC6q5AcJAAAAAElFTkSuQmCC";

export const PREREQUISITE_GUIDES = {
  mixpanel: "Start with List-Organizations, then Get-Projects with its organization_id. Resolve the project and workspace, read Get-Business-Context, and Get-Query-Schema before Run-Query. Never guess ids.",
  revenuecat: "Call list-projects first. list-subscriptions returns plain text, not JSON. Report gives_access rather than inferring access from status or expires_date.",
  supabase: "Call list_projects to resolve the exact project. execute_sql requires project_ref, not project_id. Never query a different project's database.",
} as const;

export function mixpanelTools(): FakeTool[] {
  let organizations = false, projects = false, context = false, schema = false;
  return [
    { name: "List-Organizations", description: "List organizations", input: z.object({}), annotations: read,
      run: () => { organizations = true; return { json: { organizations: [{ id: "org_eval", name: "Acme" }] } }; } },
    { name: "Get-Projects", description: "List an organization's projects and workspaces", input: z.object({ organization_id: z.string() }), annotations: read,
      run: args => {
        if (!organizations || args.organization_id !== "org_eval") return { error: "Resolve the organization first" };
        projects = true;
        return { json: { projects: [{ id: "mp_prod", name: "Production", workspace_id: "ws_prod" }, { id: "mp_test", name: "Sandbox", workspace_id: "ws_test" }] } };
      } },
    { name: "Get-Business-Context", description: "Read the project's metric definitions", input: z.object({ project_id: z.string() }), annotations: read,
      run: args => {
        if (!projects || args.project_id !== "mp_prod") return { error: "Resolve the Production project first" };
        context = true;
        return { json: { project_id: "mp_prod", metric: "activation", event: "Activation Completed", excludes: "internal accounts" } };
      } },
    { name: "Get-Query-Schema", description: "Get query requirements", input: z.object({ project_id: z.string() }), annotations: read,
      run: args => { schema = args.project_id === "mp_prod" && context; return schema ? { json: { event: "Activation Completed", workspace_id: "ws_prod" } } : { error: "Read business context first" }; } },
    { name: "Run-Query", description: "Read activation count for a resolved project and workspace", input: z.object({ project_id: z.string(), workspace_id: z.string(), event: z.string() }), annotations: read,
      run: args => schema && args.project_id === "mp_prod" && args.workspace_id === "ws_prod" && args.event === "Activation Completed"
        ? { json: { project_id: "mp_prod", activations: 137, window: "2026-10-01/2026-10-07", excludes: "internal accounts" } }
        : { error: "Bootstrap organization, project, context and query schema first" } },
  ];
}

export function revenuecatTools(): FakeTool[] {
  let resolved = false;
  return [
    { name: "list-projects", description: "List projects", input: z.object({}), annotations: read,
      run: () => { resolved = true; return { json: { projects: [{ project_id: "rc_prod", name: "Production" }] } }; } },
    { name: "list-subscriptions", description: "Plain-text subscription report; gives_access is authoritative", input: z.object({ project_id: z.string(), app_user_id: z.string() }), annotations: read,
      run: args => resolved && args.project_id === "rc_prod" && args.app_user_id === "user_42"
        ? { text: "RevenueCat Production rc_prod\napp_user_id: user_42\nsubscription: sub_grace_42\nstatus: expired\ngives_access: true\nreason: billing grace period" }
        : { error: "Resolve project_id with list-projects; use user_42" } },
  ];
}

export function supabaseTools(): FakeTool[] {
  let resolved = false;
  return [
    { name: "list_projects", description: "List project references", input: z.object({}), annotations: read,
      run: () => { resolved = true; return { json: { projects: [{ project_ref: "sb_prod_ref", name: "Production" }, { project_ref: "sb_test_ref", name: "Sandbox" }] } }; } },
    { name: "execute_sql", description: "Read-only SQL query for a project_ref", input: z.object({ project_ref: z.string(), query: z.literal("select count(*) as count from public.orders") }).strict(), annotations: read,
      run: args => resolved && args.project_ref === "sb_prod_ref" ? { json: { project_ref: "sb_prod_ref", rows: [{ count: 73 }] } } : { error: "Resolve the Production project_ref first" } },
  ];
}

export function assetTools(): FakeTool[] {
  return [
    { name: "get_badge", description: "Return the launch badge PNG and caption as JSON for program emission", input: z.object({}), annotations: read,
      run: () => ({ json: { data: BADGE_PNG, mimeType: "image/png", caption: "Launch badge: approved, revision 7" } }) },
    { name: "get_badge_image", description: "Return the launch badge as MCP text and image blocks", input: z.object({}), annotations: read,
      run: () => ({ content: [{ type: "text", text: "Launch badge: approved, revision 7" }, { type: "image", data: BADGE_PNG, mimeType: "image/png" }] }) },
  ];
}
