import type { groupedSearchResult } from "../../src/catalog-service.js";
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

export type SearchResult = ReturnType<typeof groupedSearchResult>;
