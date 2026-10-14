// Reviewed subset of Mixpanel query, export and ingestion OpenAPI documents.
// Compiled with buildOperationIndex; source pins and manual review are in drift.json.
// Digest covers JSON.stringify of contracts.fixture.json; formatting changes no contract.
// The vendor publishes YAML, unsupported by providers:spec; no synthetic live JSON pin.
// source: https://docs.mixpanel.com/openapi/query.openapi.yaml
// revision: reviewed-2026-10-14
// digest: sha256:d9bbbbfa67f0a31f900b325932462b9cd541d287e55357d28e201df69a35e677
// options: {"depth":3,"descriptions":0,"maxEnum":30,"valueSafety":true}
// format: 4
import type { OpenApiData } from "../_shared/rest/operation-index.js";

export const openapi: OpenApiData = {
  source: "https://docs.mixpanel.com/openapi/query.openapi.yaml",
  revision: "reviewed-2026-10-14",
  digest: "sha256:d9bbbbfa67f0a31f900b325932462b9cd541d287e55357d28e201df69a35e677",
  version: "1.0.0",
  servers: ["query", "export", "app", "ingestion"],
  tags: ["Export", "Account", "Engage", "Funnels", "Insights", "Retention", "Activity Feed", "Events"],
  ops: [
    ["GET", "/api/2.0/export", "raw-event-export", "Download Data", 0, 1],
    ["GET", "/api/app/me", "service-account-me", "Service-account identity and reachable projects", 1, 2],
    ["POST", "/api/query/engage", "engage-query", "Query Profiles", 2],
    ["GET", "/api/query/funnels", "funnels-query", "Query Saved Report", 3],
    ["GET", "/api/query/funnels/list", "funnels-list-saved", "List Saved Funnels", 3],
    ["GET", "/api/query/insights", "insights-query", "Query Saved Report", 4],
    ["GET", "/api/query/retention", "retention-query", "Query Retention Report", 5],
    ["GET", "/api/query/stream/query", "activity-stream-query", "Profile Event Activity", 6],
    ["POST", "/import", "import-events", "Import Events", 7, 3],
  ],
  details:
    '{"d":[],"o":[[[["project_id","query",0,{"t":"integer"}],["from_date","query",1,{"t":"string"}],["to_date","query",1,{"t":"string"}],["limit","query",0,{"t":"integer"}],["event","query",0,{"t":"string"}],["where","query",0,{"t":"string"}],["time_in_ms","query",0,{"t":"boolean"}]],0],0,[[["project_id","query",1,{"t":"integer"}],["workspace_id","query",0,{"t":"integer"}]],["application/x-www-form-urlencoded",{"p":{"distinct_id":{"t":"string"},"distinct_ids":{"t":"string"},"data_group_id":{"t":"string"},"where":{"t":"string"},"output_properties":{"t":"array","i":{"t":"string"}},"session_id":{"t":"string"},"page":{"t":"integer"},"behaviors":{"t":"integer"},"as_of_timestamp":{"t":"integer"},"filter_by_cohort":{"t":"string"},"include_all_users":{"t":"boolean"}}}]],[[["project_id","query",1,{"t":"integer"}],["workspace_id","query",0,{"t":"integer"}],["funnel_id","query",1,{"t":"integer"}],["from_date","query",1,{"t":"string"}],["to_date","query",1,{"t":"string"}],["length","query",0,{"t":"integer"}],["length_unit","query",0,{"t":"string","e":["day","hour","minute","second"]}],["interval","query",0,{"t":"integer"}],["unit","query",0,{"t":"string","e":["day","week","month"]}],["on","query",0,{"t":"string"}],["where","query",0,{"t":"string"}],["limit","query",0,{"t":"integer"}]],0],[[["project_id","query",1,{"t":"integer"}],["workspace_id","query",0,{"t":"integer"}]],0],[[["project_id","query",1,{"t":"integer"}],["workspace_id","query",0,{"t":"integer"}],["bookmark_id","query",1,{"t":"integer"}]],0],[[["project_id","query",1,{"t":"integer"}],["workspace_id","query",0,{"t":"integer"}],["from_date","query",1,{"t":"string"}],["to_date","query",1,{"t":"string"}],["retention_type","query",0,{"t":"string","e":["birth","compounded"]}],["born_event","query",0,{"t":"string"}],["event","query",0,{"t":"string"}],["born_where","query",0,{"t":"string"}],["where","query",0,{"t":"string"}],["interval","query",0,{"t":"integer"}],["interval_count","query",0,{"t":"integer"}],["unit","query",0,{"t":"string","e":["day","week","month"]}],["unbounded_retention","query",0,{"t":"boolean"}],["on","query",0,{"t":"string"}],["limit","query",0,{"t":"integer"}]],0],[[["project_id","query",1,{"t":"integer"}],["workspace_id","query",0,{"t":"integer"}],["distinct_ids","query",1,{"t":"string"}],["from_date","query",1,{"t":"string"}],["to_date","query",1,{"t":"string"}]],0],[[["strict","query",1,{"t":"string","e":["0","1"]}],["project_id","query",1,{"t":"string"}]],["application/json",{"t":"array","i":{"t":"object","p":{"event":{"t":"string"},"properties":{"t":"object","p":{"time":{"t":"integer"},"distinct_id":{"t":"string"},"$insert_id":{"t":"string"}},"r":["time","$insert_id","distinct_id"],"m":{}}},"r":["event","properties"]}},1]]]}',
};
