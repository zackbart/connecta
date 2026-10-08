import type { ToolDef } from "./types.js";
import type { CallErrorDetails } from "./errors.js";

/** TypeScript notation for the JavaScript guest global; programs receive no arguments. */
export interface GuestApi {
  search(args?: CatalogSearchArgs): Promise<CatalogSearchResult>;
  describe(args?: CatalogDescribeArgs): Promise<{ tools: CatalogDescription[] }>;
  call(address: string, args?: unknown, options?: { timeoutMs?: number }): Promise<GuestResult>;
  call(request: { address: string; args?: unknown; timeoutMs?: number }): Promise<GuestResult>;
  read(uri: string): Promise<{ contents: Array<{ uri: string; mimeType?: string } & ({ text: string } | { blob: string })> }>;
  result(id: string, options?: { offset?: number; maxBytes?: number }): Promise<GuestResultPage>;
  skill(name: string): Promise<{ name: string; text: string; format: "text" }>;
  emit(block: GuestBlock): PromiseLike<void>;
}

export type GuestResult = { data: unknown; format: "json" } | { data: string; format: "text" };
export interface GuestResultPage {
  resultId: string;
  offset: number;
  bytes: number;
  totalBytes: number;
  hasMore: boolean;
  nextOffset?: number;
  format: "text";
  text: string;
}
export type GuestBlock = { type: "text"; text: string } |
  { type: "image" | "audio"; data: string; mimeType: string };

type SchemaFormat = "json" | "compact" | "typescript";

export interface CatalogSearchArgs {
  query?: string;
  connector?: string;
  safety?: "readOnly" | "approvalRequired" | "all";
  limit?: number;
  offset?: number;
  fullDescriptions?: boolean;
  includeSchemas?: SchemaFormat;
  includeSchemaKeys?: boolean;
}
export interface CatalogDescribeArgs {
  address?: unknown;
  addresses?: unknown;
  format?: SchemaFormat;
  fullDescriptions?: boolean;
}
type GuideRequiredReason = "connector_required" | "approval_required" | "schema_truncated";
interface CatalogFailureDetail {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}
interface CatalogDescriptionFailureDetail extends CatalogFailureDetail {
  configuredConnectors?: string[];
  nextAction?: NonNullable<CallErrorDetails["nextAction"]>;
  suggestions?: string[];
}
interface CatalogSearchFailure extends CatalogFailureDetail {
  connector: string;
  recovery?: CallErrorDetails["recovery"];
  nextAction?: Extract<NonNullable<CallErrorDetails["nextAction"]>, {
    tool: "authorize_connector";
  }>;
  retry?: string;
}
export interface CatalogSearchPage {
  catalogErrors: CatalogSearchFailure[];
  absence?: {
    service: string;
    message: string;
    configuredConnectors: string[];
  };
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  matchMode?: "partial";
  queryAnalysis?: {
    representedTerms: string[];
    otherResultTerms: string[];
    unmatchedTerms: string[];
    truncated?: true;
    connectorScope?: string;
    unknownConnector?: true;
    configuredConnectors?: string[];
    unavailableConnectorCount?: number;
    catalogError?: CatalogFailureDetail;
    guide?: string;
    guideSummary?: string;
    guideRequired?: true;
    guideRequiredReasons?: GuideRequiredReason[];
    guidance?: string;
  };
}
export type CatalogSearchResult = CatalogSearchPage & {
  tools: Array<CatalogSearchTool & {
    connectorTitle?: string;
    guide?: string;
    guideSummary?: string;
  }>;
};
export interface CatalogDescription {
  address: string;
  schemaFormat?: "json" | "text";
  name?: string;
  description?: string;
  guide?: string;
  guideSummary?: string;
  guideRequired?: true;
  guideRequiredReasons?: GuideRequiredReason[];
  inputSchema?: unknown;
  outputSchema?: unknown;
  signature?: string;
  outputSchemaSource?: "observed";
  inputSchemaTruncated?: true;
  outputSchemaTruncated?: true;
  annotations?: ToolDef["annotations"];
  error?: string;
  errorDetails?: CatalogDescriptionFailureDetail;
}
type CatalogSearchTool = {
  name: string;
  address: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  signature?: string;
  schemaFormat?: "json" | "text";
  outputSchemaSource?: "observed";
  inputSchemaTruncated?: true;
  outputSchemaTruncated?: true;
  inputKeys?: string[];
  requiredInputKeys?: string[];
  outputKeys?: string[];
  annotations?: ToolDef["annotations"];
  classification?: ToolDef["classification"];
  guideRequired?: true;
  guideRequiredReasons?: GuideRequiredReason[];
};

