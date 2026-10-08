import { ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ConnectorCallError } from "../errors.js";
import { SkillsRegistry, type SkillsRegistryOptions } from "../skills.js";
import type { RegistryView } from "../registry.js";

/** Native Skills methods use the same request-view registry as both text readers. */
export function registerSkills(server: McpServer, view: RegistryView, baseUrl: string, options: SkillsRegistryOptions): void {
  // McpServer's resource constructor installs its static registry and turns
  // listChanged on. Declare the capability on the low-level server instead.
  server.server.registerCapabilities({ resources: {} });
  const registry = new SkillsRegistry(view, baseUrl, options);
  const listParams = z.object({ cursor: z.string().max(128).optional() });
  const getParams = z.object({ uri: z.string().min(1).max(32_768).startsWith("skill://") });
  const result = z.record(z.string(), z.unknown());
  const safely = async (read: () => Promise<Record<string, unknown>>) => {
    try { return await read(); }
    catch (error) {
      if (error instanceof ConnectorCallError && (error.code === "not_found" || error.code === "invalid_args")) {
        throw new ProtocolError(-32602, "Unknown skill/file or invalid skills cursor.");
      }
      // No raw downstream cause can become an SDK/operator diagnostic.
      throw new ProtocolError(-32603, "Skills are unavailable.");
    }
  };
  server.server.setRequestHandler("skills/list", { params: listParams, result }, params => safely(() => registry.list(params.cursor)));
  server.server.setRequestHandler("skills/get", { params: getParams, result }, params => safely(() => registry.get(params.uri)));
  server.server.setRequestHandler("resources/list", { params: listParams, result }, params => safely(() => registry.resources(params.cursor)));
  server.server.setRequestHandler("resources/read", { params: getParams, result }, params => safely(() => registry.read(params.uri)));
}
