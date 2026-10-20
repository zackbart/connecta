import { infisical } from "../../../src/providers/infisical/index.js";
import { defineGoldenSpec } from "../harness.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";
const FOLDER_ID = "44444444-4444-4444-8444-444444444444";
const NESTED_FOLDER_ID = "55555555-5555-4555-8555-555555555555";
const APPROVAL_ID = "66666666-6666-4666-8666-666666666666";
const ACCESS_TOKEN = "golden-access-token-7f3a9c";

const SECRET = {
  id: SECRET_ID,
  secretKey: "API_KEY",
  secretValue: "crm-api-value-123",
  secretValueHidden: false,
  secretComment: "Rotated quarterly",
  environment: "prod",
  secretPath: "/apps",
  type: "shared",
  version: 3,
  tags: [{ slug: "web" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const SECRET_IDENTIFIERS = {
  id: SECRET_ID,
  secretKey: "API_KEY",
  environment: "prod",
  secretPath: "/apps",
  type: "shared",
  version: 4,
  tags: [{ slug: "web" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

export default defineGoldenSpec({
  provider: "infisical",
  create: () => infisical("infisical", { purpose: "Deployment secrets for the crm and tickets services" }),
  credential: { clientId: "golden-client-id-4d2e81", clientSecret: "golden-client-secret-9b51f0" },
  secrets: { accessToken: ACCESS_TOKEN },
  auxiliary: [
    {
      name: "universal-auth-login",
      match: (request) => request.method === "POST" && request.url.pathname.endsWith("/v1/auth/universal-auth/login"),
      reply: { body: { accessToken: ACCESS_TOKEN, expiresIn: 3600, accessTokenMaxTTL: 0, tokenType: "Bearer" } },
    },
  ],
  failureReply: (status) => ({
    status,
    body: { reqId: "req-golden", statusCode: status, message: `Golden ${status} failure`, error: `Golden${status}` },
  }),
  calls: [
    {
      tool: "list_projects",
      replies: [
        {
          body: {
            projects: [
              {
                id: PROJECT_ID,
                type: "secret-manager",
                environments: [{ id: ENVIRONMENT_ID, slug: "prod" }],
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        },
      ],
    },
    {
      label: "list_projects free text withheld",
      tool: "list_projects",
      replies: [
        {
          body: {
            projects: [
              {
                id: PROJECT_ID,
                name: "Site",
                slug: "site",
                description: "",
                type: "secret-manager",
                kmsSecretManagerKeyId: "noise",
                environments: [{ id: ENVIRONMENT_ID, name: "Production", slug: "prod" }],
              },
            ],
          },
        },
      ],
    },
    {
      tool: "list_folders",
      args: { projectId: PROJECT_ID, environment: "prod", path: "/apps/" },
      replies: [
        {
          body: {
            folders: [
              {
                id: FOLDER_ID,
                name: "db",
                version: 1,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        },
      ],
    },
    {
      label: "list_folders recursive",
      tool: "list_folders",
      args: { projectId: PROJECT_ID, environment: "prod", path: "/apps", recursive: true },
      replies: [{ body: { folders: [{ id: NESTED_FOLDER_ID, name: "replica", relativePath: "/db/replica" }] } }],
    },
    {
      tool: "list_secrets",
      args: { projectId: PROJECT_ID, environment: "prod", secretPath: "/apps", tagSlugs: ["web", "api"] },
      replies: [
        {
          body: {
            secrets: [{ ...SECRET_IDENTIFIERS, version: 3, secretValue: "", secretValueHidden: true }],
            imports: [],
          },
        },
      ],
    },
    {
      label: "list_secrets includeValues with imports",
      tool: "list_secrets",
      args: { projectId: PROJECT_ID, environment: "prod", secretPath: "/apps", includeValues: true, recursive: true },
      replies: [
        {
          body: {
            secrets: [SECRET],
            imports: [
              {
                environment: "prod",
                secretPath: "/shared",
                secrets: [{ ...SECRET, id: NESTED_FOLDER_ID, secretKey: "SHARED_URL", secretPath: "/shared" }],
              },
            ],
          },
        },
      ],
    },
    {
      tool: "get_secret",
      args: { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY", secretPath: "/apps", version: 3 },
      replies: [{ body: { secret: SECRET } }],
    },
    {
      tool: "create_secret",
      args: {
        projectId: PROJECT_ID,
        environment: "prod",
        secretName: "API_KEY",
        secretValue: "new-crm-api-value-456",
        secretPath: "/apps",
        secretComment: "Issued for crm",
        type: "shared",
      },
      replies: [{ body: { secret: { ...SECRET_IDENTIFIERS, version: 1 } } }],
    },
    {
      tool: "update_secret",
      args: {
        projectId: PROJECT_ID,
        environment: "prod",
        secretName: "API_KEY",
        secretPath: "/apps",
        secretValue: "rotated-crm-api-value-789",
        newSecretName: "CRM_API_KEY",
      },
      replies: [{ body: { secret: { ...SECRET_IDENTIFIERS, secretKey: "CRM_API_KEY" } } }],
    },
    {
      label: "update_secret pending approval",
      tool: "update_secret",
      args: { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY", secretComment: "" },
      replies: [{ body: { approval: { id: APPROVAL_ID, status: "open" } } }],
    },
    {
      tool: "delete_secret",
      args: { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY", secretPath: "/apps" },
      replies: [{ body: { secret: SECRET_IDENTIFIERS } }],
    },
    {
      tool: "create_folder",
      args: { projectId: PROJECT_ID, environment: "prod", name: "db", path: "/apps", description: "Database secrets" },
      replies: [
        {
          body: {
            folder: {
              id: FOLDER_ID,
              name: "db",
              description: "Database secrets",
              version: 1,
              createdAt: "2026-01-02T03:04:05Z",
              updatedAt: "2026-01-02T03:04:05Z",
            },
          },
        },
      ],
    },
  ],
  failures: {
    read: {
      tool: "get_secret",
      args: { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY", secretPath: "/apps" },
    },
    write: {
      tool: "create_secret",
      args: {
        projectId: PROJECT_ID,
        environment: "prod",
        secretName: "API_KEY",
        secretValue: "new-crm-api-value-456",
        secretPath: "/apps",
      },
    },
  },
});
