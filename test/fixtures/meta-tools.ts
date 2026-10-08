import type { flatSearchResult } from "../../src/catalog-service.js";
import {
  authConnector,
  brokenConnector,
  calcConnector,
  makeRegistry,
  remoteConnector,
  required,
} from "../helpers.js";

export const BASE = "https://connecta.test";

export function textOf(result: { content: { text: string }[] }): unknown {
  return JSON.parse(required(result.content[0]).text);
}

export function registry() {
  return makeRegistry([
    calcConnector,
    remoteConnector,
    brokenConnector,
    authConnector,
  ]);
}

export type SearchResult = ReturnType<typeof flatSearchResult>;

export function connectorIds(page: { tools: { address: string }[] }): string[] {
  return [...new Set(page.tools.map((tool) => tool.address.split(".")[0]!))];
}

export function toolsByConnector<T extends { address: string }>(page: { tools: T[] }): Record<string, { tools: T[] }> {
  return Object.fromEntries(connectorIds(page).map((id) => [id, {
    tools: page.tools.filter((tool) => tool.address.startsWith(`${id}.`)),
  }]));
}
