// Effect declarations are the catalog and runtime decoder for every named Docs tool.
import { Schema } from "effect";
import { Integer, isMinChars, isMaxChars } from "../../../http/json-schema.js";
import { fieldsInput } from "../../../http/fields.js";
import { REQUEST_KINDS } from "./requests.js";
const matches = (pattern: string) =>
  Schema.makeFilter((value: string) => new RegExp(pattern).test(value), {
    expected: `a string matching ${pattern}`,
    toJsonSchema: () => ({ pattern }),
  });
const Request = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)).check(
  Schema.makeFilter(
    (value) =>
      Object.keys(value).length === 1 &&
      REQUEST_KINDS.includes(Object.keys(value)[0] as (typeof REQUEST_KINDS)[number]),
    {
      expected: "exactly one reviewed Docs request kind",
      toJsonSchema: () => ({ minProperties: 1, maxProperties: 1, propertyNames: { enum: [...REQUEST_KINDS] } }),
    },
  ),
);
export const GET_DOCUMENT_INPUT = Schema.Struct({
  "documentId": Schema.String.check(isMinChars(1), isMaxChars(256), matches("^[A-Za-z0-9_-]+$")).annotate({
    description: "Document id: the part after /d/ in its URL, or a Drive file id for a Google Doc.",
  }),
  "tabId": Schema.optionalKey(
    Schema.String.check(isMinChars(1), isMaxChars(128), matches("^[A-Za-z0-9._-]+$")).annotate({
      description: "Render only this tab (from a previous get_document); omit for every tab.",
    }),
  ),
  "maxChars": Schema.optionalKey(
    Integer.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1000000)).annotate({
      description:
        "Characters of text kept across all rendered tabs, 0 to 1000000; defaults to 20000. Connecta's cap. Longer text ends with a truncation marker. Above the default, call directly (call_tool, connecta.result to page): execute_code carries at most 256 KiB per result.",
    }),
  ),
  "withIndexes": Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Add each tab's elements: every paragraph, table, and table of contents with UTF-16 startIndex and endIndex, 64 KiB per page (connecta's cap); page with cursor.",
    }),
  ),
  "cursor": Schema.optionalKey(
    Schema.String.check(isMinChars(1)).annotate({
      description:
        "Opaque page.nextCursor from the previous indexed read; keep the same arguments and document revision.",
    }),
  ),
  "suggestions": Schema.optionalKey(
    Schema.Literals(["inline", "accepted", "rejected"]).annotate({
      description:
        "How suggested edits read: inline (editors' default; the indexes edits use), or a preview with all accepted or all rejected (indexes not valid for edits).",
    }),
  ),
  fields: Schema.optionalKey(
    fieldsInput("Dot paths to keep in the result. Page and truncation metadata are always returned."),
  ),
});
export const GET_DOCUMENT_OUTPUT = Schema.Struct({
  "documentId": Schema.optionalKey(Schema.String),
  "title": Schema.optionalKey(Schema.String),
  "revisionId": Schema.optionalKey(Schema.String),
  "url": Schema.optionalKey(Schema.String),
  "tabs": Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        "tabId": Schema.optionalKey(Schema.String),
        "title": Schema.optionalKey(Schema.String),
        "parentTabId": Schema.optionalKey(Schema.String),
        "nestingLevel": Schema.optionalKey(Integer),
        "endIndex": Schema.optionalKey(Integer),
        "text": Schema.optionalKey(Schema.String),
        "notRendered": Schema.optionalKey(
          Schema.Array(
            Schema.Literals(["headers", "footers", "positioned_objects", "suggestion_marks", "unknown_elements"]),
          ),
        ),
        "elements": Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              "type": Schema.optionalKey(Schema.Literals(["paragraph", "table", "table_of_contents"])),
              "startIndex": Schema.optionalKey(Integer),
              "endIndex": Schema.optionalKey(Integer),
              "style": Schema.optionalKey(Schema.String),
              "row": Schema.optionalKey(Integer),
              "column": Schema.optionalKey(Integer),
              "text": Schema.optionalKey(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
  "page": Schema.optionalKey(
    Schema.Struct({ "hasMore": Schema.optionalKey(Schema.Boolean), "nextCursor": Schema.optionalKey(Schema.String) }),
  ),
  "dropped": Schema.optionalKey(Schema.Array(Schema.String)),
  "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
});
export const CREATE_DOCUMENT_INPUT = Schema.Struct({
  "title": Schema.String.check(isMinChars(1), isMaxChars(1000), matches("^[^\\r\\n]*$")).annotate({
    description: "Document title, one line. Connecta's 1,000-character cap.",
  }),
  "text": Schema.optionalKey(
    Schema.String.check(isMinChars(1), isMaxChars(1000000)).annotate({
      description: "Optional plain-text body; \\n starts a new paragraph.",
    }),
  ),
});
export const CREATE_DOCUMENT_OUTPUT = Schema.Struct({
  "documentId": Schema.String,
  "title": Schema.optionalKey(Schema.String),
  "revisionId": Schema.optionalKey(Schema.String),
  "url": Schema.String,
  "dropped": Schema.optionalKey(Schema.Array(Schema.String)),
  "notice": Schema.optionalKey(Schema.String),
});
export const APPEND_TEXT_INPUT = Schema.Struct({
  "documentId": Schema.String.check(isMinChars(1), isMaxChars(256), matches("^[A-Za-z0-9_-]+$")).annotate({
    description: "Document id: the part after /d/ in its URL, or a Drive file id for a Google Doc.",
  }),
  "text": Schema.String.check(isMinChars(1), isMaxChars(1000000)).annotate({
    description: "Plain text; \\n starts a new paragraph. Google caps a document near 1.02 million characters.",
  }),
  "tabId": Schema.optionalKey(
    Schema.String.check(isMinChars(1), isMaxChars(128), matches("^[A-Za-z0-9._-]+$")).annotate({
      description: "Tab to append to; omit for the first tab.",
    }),
  ),
  "requiredRevisionId": Schema.optionalKey(
    Schema.String.check(isMinChars(1), isMaxChars(512), matches("^\\S+$")).annotate({
      description:
        "revisionId from get_document or a previous edit. If the document has changed since, the edit fails conflict and nothing is applied.",
    }),
  ),
});
export const APPEND_TEXT_OUTPUT = Schema.Struct({
  "documentId": Schema.String,
  "revisionId": Schema.optionalKey(Schema.String),
  "dropped": Schema.optionalKey(Schema.Array(Schema.String)),
  "notice": Schema.optionalKey(Schema.String),
});
export const INSERT_TEXT_INPUT = Schema.Struct({
  "documentId": Schema.String.check(isMinChars(1), isMaxChars(256), matches("^[A-Za-z0-9_-]+$")).annotate({
    description: "Document id: the part after /d/ in its URL, or a Drive file id for a Google Doc.",
  }),
  "index": Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10000000)).annotate({
    description:
      "UTF-16 index inside an existing paragraph, from get_document withIndexes; 1 is the body's start. Not a table's start index.",
  }),
  "text": Schema.String.check(isMinChars(1), isMaxChars(1000000)).annotate({
    description: "Plain text; \\n starts a new paragraph. Google caps a document near 1.02 million characters.",
  }),
  "tabId": Schema.optionalKey(
    Schema.String.check(isMinChars(1), isMaxChars(128), matches("^[A-Za-z0-9._-]+$")).annotate({
      description: "Tab the index belongs to; omit for the first tab.",
    }),
  ),
  "requiredRevisionId": Schema.optionalKey(
    Schema.String.check(isMinChars(1), isMaxChars(512), matches("^\\S+$")).annotate({
      description:
        "revisionId from get_document or a previous edit. If the document has changed since, the edit fails conflict and nothing is applied.",
    }),
  ),
});
export const INSERT_TEXT_OUTPUT = Schema.Struct({
  "documentId": Schema.String,
  "revisionId": Schema.optionalKey(Schema.String),
  "dropped": Schema.optionalKey(Schema.Array(Schema.String)),
  "notice": Schema.optionalKey(Schema.String),
});
export const REPLACE_ALL_TEXT_INPUT = Schema.Struct({
  "documentId": Schema.String.check(isMinChars(1), isMaxChars(256), matches("^[A-Za-z0-9_-]+$")).annotate({
    description: "Document id: the part after /d/ in its URL, or a Drive file id for a Google Doc.",
  }),
  "find": Schema.String.check(isMinChars(1), isMaxChars(10000)).annotate({
    description: "Text to find. With regex: true, a regular expression in Google's RE2 syntax.",
  }),
  "replaceWith": Schema.String.check(isMaxChars(1000000)).annotate({
    description: "Replacement text; an empty string deletes every match.",
  }),
  "matchCase": Schema.optionalKey(Schema.Boolean.annotate({ description: "Match case exactly. Defaults to false." })),
  "regex": Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Treat find as an RE2 regular expression. Defaults to false." }),
  ),
  "tabIds": Schema.optionalKey(
    Schema.Array(
      Schema.String.check(isMinChars(1), isMaxChars(128), matches("^[A-Za-z0-9._-]+$")).annotate({
        description: "Tab id from get_document.",
      }),
    )
      .check(Schema.isMinLength(1), Schema.isMaxLength(100))
      .annotate({ description: "Only these tabs; omit for every tab." }),
  ),
  "requiredRevisionId": Schema.optionalKey(
    Schema.String.check(isMinChars(1), isMaxChars(512), matches("^\\S+$")).annotate({
      description:
        "revisionId from get_document or a previous edit. If the document has changed since, the edit fails conflict and nothing is applied.",
    }),
  ),
});
export const REPLACE_ALL_TEXT_OUTPUT = Schema.Struct({
  "documentId": Schema.String,
  "occurrencesChanged": Integer,
  "revisionId": Schema.optionalKey(Schema.String),
  "dropped": Schema.optionalKey(Schema.Array(Schema.String)),
  "notice": Schema.optionalKey(Schema.String),
});
export const BATCH_UPDATE_DOCUMENT_INPUT = Schema.Struct({
  "documentId": Schema.String.check(isMinChars(1), isMaxChars(256), matches("^[A-Za-z0-9_-]+$")).annotate({
    description: "Document id: the part after /d/ in its URL, or a Drive file id for a Google Doc.",
  }),
  "requests": Schema.Array(Request).check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
    description: "Requests in order, 1 to 100 (connecta's cap). Later requests see earlier ones' index shifts.",
  }),
  "requiredRevisionId": Schema.String.check(isMinChars(1), isMaxChars(512), matches("^\\S+$")).annotate({
    description:
      "revisionId from get_document or a previous edit; required, so raw edits are planned against what was read. If the document has changed, it fails conflict and nothing is applied.",
  }),
});
export const BATCH_UPDATE_DOCUMENT_OUTPUT = Schema.Struct({
  "documentId": Schema.String,
  "revisionId": Schema.optionalKey(Schema.String),
  "replies": Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  "dropped": Schema.optionalKey(Schema.Array(Schema.String)),

  "notice": Schema.optionalKey(Schema.String),
  "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
});
