// Infisical's eight kit tools; step 1 preserves the catalog and identifier projections.
import { Effect, Schema } from "effect";
import { defined as compact, type ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { Integer, isMinChars } from "../../http/json-schema.js";
import { read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import { RESPONSE_CEILING_MESSAGE } from "./api.js";
import type { JsonSchema } from "../../types.js";
type ResourceRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};
type Json = Record<string, unknown>;
function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function segment(value: string) {
  return value === "." || value === ".."
    ? Effect.fail(
        new Refusal({ error: new ConnectorCallError("invalid_args", "A secret key cannot be a URL dot segment.") }),
      )
    : Effect.succeed(encodeURIComponent(value));
}
const pattern = (source: string) =>
  Schema.makeFilter((value: string) => new RegExp(source).test(value), { toJsonSchema: () => ({ pattern: source }) });

// These grammars constrain identifiers, not arbitrary human-authored metadata.
// UUIDs and legacy 24-hex IDs are accepted; unknown shapes are withheld.
const ID_PATTERN = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24})$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PATH_PATTERN = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254})*\/?)?$/;
const ISO_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const SECRET_TYPES = ["shared", "personal"];
// Infisical RequestState, not individual reviewers' ApprovalStatus.
const APPROVAL_STATES = ["open", "close"];
const PROJECT_TYPES = ["secret-manager"];

/** One checked projection for every value-free result. Never match secret values. */
class IdentifierProjection {
  omitted = false;

  record(value: unknown, fields: string[], ignored: string[] = []): Json {
    if (!value || typeof value !== "object" || Array.isArray(value)) this.omitted = true;
    const record = asRecord(value);
    if (Object.keys(record).some((key) => !fields.includes(key) && !ignored.includes(key))) this.omitted = true;
    return record;
  }

  array(value: unknown): unknown[] {
    if (value !== undefined && !Array.isArray(value)) this.omitted = true;
    return asArray(value);
  }

  text(value: unknown, pattern: RegExp): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string" && pattern.exec(value)?.[0] === value) return value;
    this.omitted = true;
    return undefined;
  }

  choice(value: unknown, allowed: string[]): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string" && allowed.includes(value)) return value;
    this.omitted = true;
    return undefined;
  }

  version(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
    this.omitted = true;
    return undefined;
  }

  finish(value: Json): Json {
    return this.omitted ? { ...value, metadataOmitted: true } : value;
  }
}

function projectProject(value: unknown, projection: IdentifierProjection): Json {
  // Infisical derives default slugs from free-text project names.
  const project = projection.record(value, ["id", "type", "environments", "createdAt", "updatedAt"]);
  return compact({
    id: projection.text(project["id"], ID_PATTERN),
    type: projection.choice(project["type"], PROJECT_TYPES),
    environments: projection.array(project["environments"]).map((env) => {
      const record = projection.record(env, ["slug", "id"]);
      return compact({
        slug: projection.text(record["slug"], SLUG_PATTERN),
        id: projection.text(record["id"], ID_PATTERN),
      });
    }),
    createdAt: projection.text(project["createdAt"], ISO_PATTERN),
    updatedAt: projection.text(project["updatedAt"], ISO_PATTERN),
  });
}

function projectSecretIdentifiers(value: unknown, projection: IdentifierProjection): Json {
  const secret = projection.record(
    value,
    ["id", "secretKey", "environment", "secretPath", "type", "version", "tags", "createdAt", "updatedAt"],
    ["secretValue", "secretValueHidden"],
  );
  return compact({
    id: projection.text(secret["id"], ID_PATTERN),
    key: projection.text(secret["secretKey"], KEY_PATTERN),
    environment: projection.text(secret["environment"], SLUG_PATTERN),
    path: projection.text(secret["secretPath"], PATH_PATTERN),
    type: projection.choice(secret["type"], SECRET_TYPES),
    version: projection.version(secret["version"]),
    tags: projection.array(secret["tags"]).flatMap((tag) => {
      const slug = projection.text(projection.record(tag, ["slug"])["slug"], SLUG_PATTERN);
      return slug === undefined ? [] : [slug];
    }),
    createdAt: projection.text(secret["createdAt"], ISO_PATTERN),
    updatedAt: projection.text(secret["updatedAt"], ISO_PATTERN),
  });
}

function projectSecret(value: unknown): Json {
  const secret = asRecord(value);
  return compact({
    id: secret["id"],
    key: secret["secretKey"],
    value: secret["secretValueHidden"] === true ? undefined : secret["secretValue"],
    valueHidden: secret["secretValueHidden"] === true ? true : undefined,
    comment: secret["secretComment"] || undefined,
    environment: secret["environment"],
    path: secret["secretPath"],
    type: secret["type"],
    version: secret["version"],
    tags: asArray(secret["tags"])
      .map((tag) => asRecord(tag)["slug"])
      .filter(Boolean),
    createdAt: secret["createdAt"],
    updatedAt: secret["updatedAt"],
  });
}

/** Join a folder path and a child name or walk-relative path into an absolute path. */
function joinPath(base: string, rest: string): string {
  const head = base.replace(/\/+$/, "");
  const tail = rest.replace(/^\/+/, "");
  return tail ? `${head}/${tail}` : head || "/";
}

/**
 * Infisical omits a path from flat listings and gives recursive ones a path
 * relative to the listed folder; both become absolute here.
 */
function projectFolder(value: unknown, projection: IdentifierProjection, parent?: string): Json {
  const folder = projection.record(value, ["id", "path", "version", "createdAt", "updatedAt"]);
  const name = typeof folder["name"] === "string" ? folder["name"] : undefined;
  const relative = typeof folder["relativePath"] === "string" ? folder["relativePath"] : undefined;
  const path =
    parent === undefined
      ? folder["path"]
      : relative !== undefined
        ? joinPath(parent, relative)
        : name !== undefined
          ? joinPath(parent, name)
          : undefined;
  return compact({
    id: projection.text(folder["id"], ID_PATTERN),
    path: projection.text(path, PATH_PATTERN),
    version: projection.version(folder["version"]),
    createdAt: projection.text(folder["createdAt"], ISO_PATTERN),
    updatedAt: projection.text(folder["updatedAt"], ISO_PATTERN),
  });
}

const LIST_PROJECTS_INPUT = Schema.Record(Schema.String, Schema.Never);
const LIST_PROJECTS_OUTPUT = Schema.Struct({
  "projects": Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        "id": Schema.optionalKey(
          Schema.String.check(
            pattern(
              "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24})$",
            ),
          ),
        ),
        "type": Schema.optionalKey(Schema.Literal("secret-manager")),
        "environments": Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              "slug": Schema.optionalKey(Schema.String.check(pattern("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"))),
              "id": Schema.optionalKey(
                Schema.String.check(
                  pattern(
                    "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24})$",
                  ),
                ),
              ),
            }),
          ),
        ),
        "createdAt": Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
        "updatedAt": Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
      }),
    ),
  ),
  "metadataOmitted": Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Free text, invalid identifiers or unavailable upstream metadata was withheld.",
    }),
  ),
});
const LIST_FOLDERS_INPUT = Schema.Struct({
  "projectId": Schema.String.check(isMinChars(1)).annotate({ description: "Project ID from list_projects." }),
  "environment": Schema.String.check(isMinChars(1)).annotate({
    description: "Environment slug, e.g. dev, staging, prod. list_projects shows each project's environments.",
  }),
  "path": Schema.optionalKey(
    Schema.String.check(pattern("^/")).annotate({
      description: "Absolute folder path beginning with /. Defaults to /.",
      default: "/",
    }),
  ),
  "recursive": Schema.optionalKey(Schema.Boolean.annotate({ description: "Include every nested folder below path." })),
});
const LIST_FOLDERS_OUTPUT = Schema.Struct({
  "folders": Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        "id": Schema.optionalKey(
          Schema.String.check(
            pattern(
              "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24})$",
            ),
          ),
        ),
        "path": Schema.optionalKey(
          Schema.String.check(
            pattern("^\\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}(?:\\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254})*\\/?)?$"),
          ),
        ),
        "version": Schema.optionalKey(Integer.check(Schema.isGreaterThanOrEqualTo(1))),
        "createdAt": Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
        "updatedAt": Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
      }),
    ),
  ),
  "metadataOmitted": Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Free text, invalid identifiers or unavailable upstream metadata was withheld.",
    }),
  ),
});
const LIST_SECRETS_INPUT = Schema.Struct({
  "projectId": Schema.String.check(isMinChars(1)).annotate({ description: "Project ID from list_projects." }),
  "environment": Schema.String.check(isMinChars(1)).annotate({
    description: "Environment slug, e.g. dev, staging, prod. list_projects shows each project's environments.",
  }),
  "secretPath": Schema.optionalKey(
    Schema.String.check(pattern("^/")).annotate({
      description: "Absolute folder path beginning with /. Defaults to /.",
      default: "/",
    }),
  ),
  "recursive": Schema.optionalKey(Schema.Boolean.annotate({ description: "Include secrets in every nested folder." })),
  "includeValues": Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Return secret values and comments. Defaults to false." }),
  ),
  "includeImports": Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Include secrets imported from other paths. Defaults to true." }),
  ),
  "expandReferences": Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Expand ${env.KEY} references in values. Defaults to true." }),
  ),
  "tagSlugs": Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Only secrets with these tag slugs." }),
  ),
});
const LIST_SECRETS_OUTPUT = Schema.Struct({
  "secrets": Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        "id": Schema.optionalKey(Schema.String),
        "key": Schema.optionalKey(Schema.String),
        "comment": Schema.optionalKey(Schema.String),
        "environment": Schema.optionalKey(Schema.String),
        "path": Schema.optionalKey(Schema.String),
        "type": Schema.optionalKey(Schema.String),
        "version": Schema.optionalKey(Schema.Finite),
        "tags": Schema.optionalKey(Schema.Array(Schema.String)),
        "createdAt": Schema.optionalKey(Schema.String),
        "updatedAt": Schema.optionalKey(Schema.String),
        "value": Schema.optionalKey(Schema.String),
        "valueHidden": Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  "imports": Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        "environment": Schema.optionalKey(Schema.String.check(pattern("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"))),
        "path": Schema.optionalKey(
          Schema.String.check(
            pattern("^\\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}(?:\\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254})*\\/?)?$"),
          ),
        ),
        "secrets": Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              "id": Schema.optionalKey(Schema.String),
              "key": Schema.optionalKey(Schema.String),
              "comment": Schema.optionalKey(Schema.String),
              "environment": Schema.optionalKey(Schema.String),
              "path": Schema.optionalKey(Schema.String),
              "type": Schema.optionalKey(Schema.String),
              "version": Schema.optionalKey(Schema.Finite),
              "tags": Schema.optionalKey(Schema.Array(Schema.String)),
              "createdAt": Schema.optionalKey(Schema.String),
              "updatedAt": Schema.optionalKey(Schema.String),
              "value": Schema.optionalKey(Schema.String),
              "valueHidden": Schema.optionalKey(Schema.Boolean),
            }),
          ),
        ),
      }),
    ),
  ),
  "metadataOmitted": Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Free text, invalid identifiers or unavailable upstream metadata was withheld.",
    }),
  ),
});
const GET_SECRET_INPUT = Schema.Struct({
  "projectId": Schema.String.check(isMinChars(1)).annotate({ description: "Project ID from list_projects." }),
  "environment": Schema.String.check(isMinChars(1)).annotate({
    description: "Environment slug, e.g. dev, staging, prod. list_projects shows each project's environments.",
  }),
  "secretName": Schema.String.check(isMinChars(1)).annotate({ description: "Secret key, e.g. DATABASE_URL." }),
  "secretPath": Schema.optionalKey(
    Schema.String.check(pattern("^/")).annotate({
      description: "Absolute folder path beginning with /. Defaults to /.",
      default: "/",
    }),
  ),
  "version": Schema.optionalKey(
    Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "A past version to read. Omit for the current one.",
    }),
  ),
  "type": Schema.optionalKey(
    Schema.Literals(["shared", "personal"]).annotate({
      description: "shared (default) or the caller's personal override.",
    }),
  ),
  "expandReferences": Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Expand ${env.KEY} references. Defaults to true." }),
  ),
});
const GET_SECRET_OUTPUT = Schema.Struct({
  "secret": Schema.optionalKey(
    Schema.Struct({
      "id": Schema.optionalKey(Schema.String),
      "key": Schema.optionalKey(Schema.String),
      "comment": Schema.optionalKey(Schema.String),
      "environment": Schema.optionalKey(Schema.String),
      "path": Schema.optionalKey(Schema.String),
      "type": Schema.optionalKey(Schema.String),
      "version": Schema.optionalKey(Schema.Finite),
      "tags": Schema.optionalKey(Schema.Array(Schema.String)),
      "createdAt": Schema.optionalKey(Schema.String),
      "updatedAt": Schema.optionalKey(Schema.String),
      "value": Schema.optionalKey(Schema.String),
      "valueHidden": Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const CREATE_SECRET_INPUT = Schema.Struct({
  "projectId": Schema.String.check(isMinChars(1)).annotate({ description: "Project ID from list_projects." }),
  "environment": Schema.String.check(isMinChars(1)).annotate({
    description: "Environment slug, e.g. dev, staging, prod. list_projects shows each project's environments.",
  }),
  "secretName": Schema.String.check(isMinChars(1)).annotate({ description: "Secret key, e.g. DATABASE_URL." }),
  "secretValue": Schema.String.annotate({
    description: "The value. May reference others as ${env.KEY}.",
    writeOnly: true,
  }),
  "secretPath": Schema.optionalKey(
    Schema.String.check(pattern("^/")).annotate({
      description: "Absolute folder path beginning with /. Defaults to /.",
      default: "/",
    }),
  ),
  "secretComment": Schema.optionalKey(
    Schema.String.annotate({ description: "Optional note shown beside the secret.", writeOnly: true }),
  ),
  "type": Schema.optionalKey(
    Schema.Literals(["shared", "personal"]).annotate({
      description: "shared (default) or the caller's personal override.",
    }),
  ),
});
const CREATE_SECRET_OUTPUT = Schema.Struct({
  "secret": Schema.optionalKey(
    Schema.Struct({
      "id": Schema.optionalKey(
        Schema.String.check(
          pattern("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24})$"),
        ),
      ),
      "key": Schema.optionalKey(Schema.String.check(pattern("^[A-Za-z_][A-Za-z0-9_.-]{0,255}$"))),
      "environment": Schema.optionalKey(Schema.String.check(pattern("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"))),
      "path": Schema.optionalKey(
        Schema.String.check(
          pattern("^\\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}(?:\\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254})*\\/?)?$"),
        ),
      ),
      "type": Schema.optionalKey(Schema.Literals(["shared", "personal"])),
      "version": Schema.optionalKey(Integer.check(Schema.isGreaterThanOrEqualTo(1))),
      "tags": Schema.optionalKey(Schema.Array(Schema.String.check(pattern("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")))),
      "createdAt": Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
      "updatedAt": Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
    }),
  ),
  "pendingApproval": Schema.optionalKey(
    Schema.Struct({
      "id": Schema.optionalKey(
        Schema.String.check(
          pattern("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24})$"),
        ),
      ),
      "status": Schema.optionalKey(Schema.Literals(["open", "close"])),
    }),
  ),
  "ok": Schema.optionalKey(Schema.Boolean),
  "metadataOmitted": Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Free text, invalid identifiers or unavailable upstream metadata was withheld.",
    }),
  ),
});
const UPDATE_SECRET_INPUT = Schema.Struct({
  "projectId": Schema.String.check(isMinChars(1)).annotate({ description: "Project ID from list_projects." }),
  "environment": Schema.String.check(isMinChars(1)).annotate({
    description: "Environment slug, e.g. dev, staging, prod. list_projects shows each project's environments.",
  }),
  "secretName": Schema.String.check(isMinChars(1)).annotate({ description: "Secret key, e.g. DATABASE_URL." }),
  "secretPath": Schema.optionalKey(
    Schema.String.check(pattern("^/")).annotate({
      description: "Absolute folder path beginning with /. Defaults to /.",
      default: "/",
    }),
  ),
  "secretValue": Schema.optionalKey(Schema.String.annotate({ description: "New value.", writeOnly: true })),
  "secretComment": Schema.optionalKey(Schema.String.annotate({ description: "New comment.", writeOnly: true })),
  "newSecretName": Schema.optionalKey(
    Schema.String.check(isMinChars(1)).annotate({ description: "Rename the secret to this key." }),
  ),
  "type": Schema.optionalKey(
    Schema.Literals(["shared", "personal"]).annotate({
      description: "shared (default) or the caller's personal override.",
    }),
  ),
});
const DELETE_SECRET_INPUT = Schema.Struct({
  "projectId": Schema.String.check(isMinChars(1)).annotate({ description: "Project ID from list_projects." }),
  "environment": Schema.String.check(isMinChars(1)).annotate({
    description: "Environment slug, e.g. dev, staging, prod. list_projects shows each project's environments.",
  }),
  "secretName": Schema.String.check(isMinChars(1)).annotate({ description: "Secret key, e.g. DATABASE_URL." }),
  "secretPath": Schema.optionalKey(
    Schema.String.check(pattern("^/")).annotate({
      description: "Absolute folder path beginning with /. Defaults to /.",
      default: "/",
    }),
  ),
  "type": Schema.optionalKey(
    Schema.Literals(["shared", "personal"]).annotate({
      description: "shared (default) or the caller's personal override.",
    }),
  ),
});
const CREATE_FOLDER_INPUT = Schema.Struct({
  "projectId": Schema.String.check(isMinChars(1)).annotate({ description: "Project ID from list_projects." }),
  "environment": Schema.String.check(isMinChars(1)).annotate({
    description: "Environment slug, e.g. dev, staging, prod. list_projects shows each project's environments.",
  }),
  "name": Schema.String.check(isMinChars(1)).annotate({ description: "Folder name." }),
  "path": Schema.optionalKey(
    Schema.String.check(pattern("^/")).annotate({
      description: "Absolute parent path beginning with /. Defaults to /.",
    }),
  ),
  "description": Schema.optionalKey(
    Schema.String.annotate({ description: "Optional folder description.", writeOnly: true }),
  ),
});
const CREATE_FOLDER_OUTPUT = Schema.Struct({
  "folder": Schema.optionalKey(
    Schema.Struct({
      "id": Schema.optionalKey(
        Schema.String.check(
          pattern("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24})$"),
        ),
      ),
      "path": Schema.optionalKey(
        Schema.String.check(
          pattern("^\\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}(?:\\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254})*\\/?)?$"),
        ),
      ),
      "version": Schema.optionalKey(Integer.check(Schema.isGreaterThanOrEqualTo(1))),
      "createdAt": Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
      "updatedAt": Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
    }),
  ),
  "pendingApproval": Schema.optionalKey(
    Schema.Struct({
      "id": Schema.optionalKey(
        Schema.String.check(
          pattern("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{24})$"),
        ),
      ),
      "status": Schema.optionalKey(Schema.Literals(["open", "close"])),
    }),
  ),
  "ok": Schema.optionalKey(Schema.Boolean),
  "metadataOmitted": Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Free text, invalid identifiers or unavailable upstream metadata was withheld.",
    }),
  ),
});
export function infisicalTools({ connection }: { connection: Connection }): ApiTool[] {
  const call = (request: ResourceRequest) =>
    connection
      .sendPath({
        method: request.method,
        path: request.path,
        template: request.path,
        ...(request.query
          ? {
              query: Object.entries(request.query)
                .filter(([, value]) => value !== undefined)
                .map(([name, value]) => [name, String(value)] as const),
            }
          : {}),
        ...(request.body === undefined ? {} : { json: JSON.stringify(request.body) }),
      })
      .pipe(
        Effect.map((answer) => answer.data),
        // The existing writes accept an unreadable successful body, then
        // return only the fixed acknowledgement; reads still require JSON.
        Effect.catchTag("UnreadableBody", (failure) =>
          request.method !== "GET" ? Effect.succeed(undefined) : Effect.fail(failure),
        ),
        Effect.catchTag("ResponseTooLarge", () =>
          Effect.fail(
            new Refusal({
              error: new ConnectorCallError("connector_call_failed", RESPONSE_CEILING_MESSAGE, { retryable: false }),
            }),
          ),
        ),
      );
  return [
    read(connection, {
      name: "list_projects",
      description: "List Infisical secret-manager projects with their IDs and environment slugs.",
      input: LIST_PROJECTS_INPUT,
      output: LIST_PROJECTS_OUTPUT,
      run: (_args) =>
        Effect.gen(function* () {
          const payload = yield* call({ method: "GET", path: "/v1/projects", query: { type: "secret-manager" } });
          const projection = new IdentifierProjection();
          const body = projection.record(payload, ["projects"]);
          return projection.finish({
            projects: projection.array(body["projects"]).map((project) => projectProject(project, projection)),
          });
        }),
    }),
    read(connection, {
      name: "list_folders",
      description: "List folders in an Infisical project environment at a path.",
      input: LIST_FOLDERS_INPUT,
      output: LIST_FOLDERS_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          const payload = yield* call({
            method: "GET",
            path: "/v2/folders",
            query: {
              projectId: args.projectId,
              environment: args.environment,
              path: args.path ?? "/",
              recursive: args.recursive,
            },
          });
          const parent = args.path ?? "/";
          const projection = new IdentifierProjection();
          const body = projection.record(payload, ["folders"]);
          return projection.finish({
            folders: projection.array(body["folders"]).map((folder) => projectFolder(folder, projection, parent)),
          });
        }),
    }),
    read(connection, {
      name: "list_secrets",
      description: "List Infisical secret identifiers. includeValues explicitly returns secret values and comments.",
      input: LIST_SECRETS_INPUT,
      output: LIST_SECRETS_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          const includeValues = args.includeValues === true;
          const payload = yield* call({
            method: "GET",
            path: "/v4/secrets",
            query: {
              projectId: args.projectId,
              environment: args.environment,
              secretPath: args.secretPath ?? "/",
              recursive: args.recursive,
              viewSecretValue: includeValues,
              expandSecretReferences: includeValues ? (args.expandReferences ?? true) : false,
              includeImports: args.includeImports ?? true,
              tagSlugs: args.tagSlugs?.length ? args.tagSlugs.join(",") : undefined,
            },
          });
          const projection = new IdentifierProjection();
          const body = projection.record(payload, ["secrets", "imports"]);
          const shape = (secret: unknown) =>
            includeValues ? projectSecret(secret) : projectSecretIdentifiers(secret, projection);
          const imports = projection.array(body["imports"]).map((entry) => {
            const record = projection.record(entry, ["environment", "secretPath", "secrets"]);
            return compact({
              environment: projection.text(record["environment"], SLUG_PATTERN),
              path: projection.text(record["secretPath"], PATH_PATTERN),
              secrets: projection.array(record["secrets"]).map(shape),
            });
          });
          return projection.finish(
            compact({
              secrets: projection.array(body["secrets"]).map(shape),
              imports: imports.length ? imports : undefined,
            }),
          );
        }),
    }),
    read(connection, {
      name: "get_secret",
      description: "Read one Infisical secret, including its value and comment, by key.",
      input: GET_SECRET_INPUT,
      output: GET_SECRET_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          const payload = yield* call({
            method: "GET",
            path: `/v4/secrets/${yield* segment(args.secretName)}`,
            query: {
              projectId: args.projectId,
              environment: args.environment,
              secretPath: args.secretPath ?? "/",
              version: args.version,
              type: args.type,
              expandSecretReferences: args.expandReferences ?? true,
            },
          });
          return { secret: projectSecret(asRecord(payload)["secret"]) };
        }),
    }),
    Object.assign(
      write(connection, {
        name: "create_secret",
        description: "Create a secret in an Infisical project environment and path.",
        input: CREATE_SECRET_INPUT,
        output: CREATE_SECRET_OUTPUT,
        destructive: false,
        run: (args) =>
          Effect.gen(function* () {
            const payload = asRecord(
              yield* call({
                method: "POST",
                path: `/v4/secrets/${yield* segment(args.secretName)}`,
                body: {
                  projectId: args.projectId,
                  environment: args.environment,
                  secretValue: args.secretValue,
                  secretPath: args.secretPath ?? "/",
                  secretComment: args.secretComment,
                  type: args.type,
                },
              }),
            );
            return writeResult(payload);
          }),
      }),
      { annotations: { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false } },
    ),
    Object.assign(
      write(connection, {
        name: "update_secret",
        description: "Update an Infisical secret's value, comment, or name. Only the fields passed change.",
        input: UPDATE_SECRET_INPUT,
        output: CREATE_SECRET_OUTPUT,
        destructive: true,
        run: (args) =>
          Effect.gen(function* () {
            // Checked here rather than with a schema anyOf, which would hide the
            // argument list from discovery.
            if (
              args.secretValue === undefined &&
              args.secretComment === undefined &&
              args.newSecretName === undefined
            ) {
              return yield* Effect.fail(
                new Refusal({
                  error: new ConnectorCallError("invalid_args", "Pass secretValue, secretComment, or newSecretName."),
                }),
              );
            }
            const payload = asRecord(
              yield* call({
                method: "PATCH",
                path: `/v4/secrets/${yield* segment(args.secretName)}`,
                body: {
                  projectId: args.projectId,
                  environment: args.environment,
                  secretPath: args.secretPath ?? "/",
                  secretValue: args.secretValue,
                  secretComment: args.secretComment,
                  newSecretName: args.newSecretName,
                  type: args.type,
                },
              }),
            );
            return writeResult(payload);
          }),
      }),
      { annotations: { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false } },
    ),
    Object.assign(
      write(connection, {
        name: "delete_secret",
        description: "Delete an Infisical secret from a project environment and path.",
        input: DELETE_SECRET_INPUT,
        output: CREATE_SECRET_OUTPUT,
        destructive: true,
        run: (args) =>
          Effect.gen(function* () {
            const payload = asRecord(
              yield* call({
                method: "DELETE",
                path: `/v4/secrets/${yield* segment(args.secretName)}`,
                body: {
                  projectId: args.projectId,
                  environment: args.environment,
                  secretPath: args.secretPath ?? "/",
                  type: args.type,
                },
              }),
            );
            return writeResult(payload);
          }),
      }),
      { annotations: { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false } },
    ),
    Object.assign(
      write(connection, {
        name: "create_folder",
        description: "Create a folder in an Infisical project environment.",
        input: CREATE_FOLDER_INPUT,
        output: CREATE_FOLDER_OUTPUT,
        destructive: false,
        run: (args) =>
          Effect.gen(function* () {
            const payload = yield* call({
              method: "POST",
              path: "/v2/folders",
              body: {
                projectId: args.projectId,
                environment: args.environment,
                name: args.name,
                path: args.path ?? "/",
                description: args.description,
              },
            });
            return writeResult(asRecord(payload), args.path ?? "/");
          }),
      }),
      { annotations: { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false } },
    ),
  ].map(legacyOutput);
}
/** Writes and pending approvals expose validated identifiers, never free text. */
function writeResult(payload: Json, folderParent?: string): Json {
  const projection = new IdentifierProjection();
  const body = projection.record(payload, ["approval", "secret", "folder"]);
  if (body["approval"] !== undefined) {
    const approval = projection.record(body["approval"], ["id", "status"]);
    return projection.finish({
      pendingApproval: compact({
        id: projection.text(approval["id"], ID_PATTERN),
        status: projection.choice(approval["status"], APPROVAL_STATES),
      }),
    });
  }
  if (folderParent !== undefined && body["folder"] !== undefined)
    return projection.finish({ folder: projectFolder(body["folder"], projection, folderParent) });
  if (folderParent === undefined && body["secret"] !== undefined)
    return projection.finish({ secret: projectSecretIdentifiers(body["secret"], projection) });
  // A successful unrecognized response must never be forwarded.
  return { ok: true, metadataOmitted: true };
}

/** Step-1 catalogs close every projected record. The Schemas retain the legacy field types. */
function legacyOutput(tool: ApiTool): ApiTool {
  const close = (schema: JsonSchema): JsonSchema => {
    if (typeof schema !== "object" || schema === null) return schema;
    const properties = schema.properties;
    return {
      ...schema,
      ...(properties
        ? {
            properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, close(value)])),
            additionalProperties: false,
          }
        : {}),
      ...(schema.items ? { items: close(schema.items as JsonSchema) } : {}),
    };
  };
  const input = tool.inputSchema as { properties: Record<string, Record<string, unknown>> };
  for (const [name, property] of Object.entries(input.properties)) {
    if (property.writeOnly) {
      const { description, writeOnly, ...rest } = property;
      input.properties[name] = { ...rest, writeOnly, description };
    }
    if (property.type === "array" && property.description) {
      const { description, ...rest } = property;
      input.properties[name] = { ...rest, description };
    }
  }
  tool.outputSchema = close(tool.outputSchema!);
  return tool;
}
