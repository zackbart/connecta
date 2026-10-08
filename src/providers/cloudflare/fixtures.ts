import { cloudflare } from "./index.js";
const options: Parameters<typeof cloudflare>[1] = { "purpose":"Audit fixture" };
export const fixture = {
  name: "cloudflare",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"empty-title","options":{"title":""}},{"label":"blank-title","options":{"title":" "}},{"label":"default","options":{}},{"label":"mcp","options":{"surface":"mcp"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof cloudflare>[1]> = {}) { return cloudflare(id, { ...options, ...overrides } as Parameters<typeof cloudflare>[1]); },
  conventions: {"verbs":["list","get","search","create","update","delete","add","bulk","purge","rollback","write","verify","upload","rename","retry","set","cloudflare"],"nestedDescriptionExceptions":["cloudflare_api_get.query[].name","cloudflare_api_get.query[].value","cloudflare_api_get.headers[].name","cloudflare_api_get.headers[].value","cloudflare_api_mutate.query[].name","cloudflare_api_mutate.query[].value","cloudflare_api_mutate.headers[].name","cloudflare_api_mutate.headers[].value","cloudflare_api_upload.query[].name","cloudflare_api_upload.query[].value","cloudflare_api_upload.headers[].name","cloudflare_api_upload.headers[].value","cloudflare_api_upload.fields[].name","cloudflare_api_upload.fields[].value","cloudflare_api_upload.fields[].contentType","cloudflare_api_upload.fields[].fileName","cloudflare_api_upload.files[].name","cloudflare_api_upload.files[].fileName","cloudflare_api_upload.files[].contentType","cloudflare_api_upload.files[].text","cloudflare_api_upload.files[].base64"],"auth":"credential"},
};
