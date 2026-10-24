// Google Slides named input/output contracts. Effect schemas own decoding and catalog rendering.
import { Schema } from "effect";
import { Integer, isMinChars, isMaxChars } from "../../../http/json-schema.js";

const matchesPattern = (pattern: RegExp) =>
  Schema.makeFilter((value: string) => pattern.test(value), {
    expected: `a string matching ${pattern.source}`,
    toJsonSchema: () => ({ pattern: pattern.source }),
  });

export const get_presentation = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "limit": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
        "default": 20,
        "description": "Slides per page, 1 to 100; defaults to 20. A page also ends before ~192 KB.",
      }),
    ),
    "cursor": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(4096), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description":
          "Opaque page.nextCursor, or a textCursor-style cursor, this connection returned. Pass it back unchanged.",
      }),
    ),
    "maxCharsPerSlide": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(50000)).annotate({
        "description":
          "Text kept per slide (notes apart), 0 to 50000; defaults to 4000. A cut gives a get_page cursor for the rest.",
      }),
    ),
  }),
  output: Schema.Struct({
    "presentationId": Schema.optionalKey(Schema.String),
    "title": Schema.optionalKey(Schema.String),
    "revisionId": Schema.optionalKey(Schema.String),
    "url": Schema.optionalKey(Schema.String),
    "locale": Schema.optionalKey(Schema.String),
    "canvasSize": Schema.optionalKey(
      Schema.Struct({
        "width": Schema.optionalKey(
          Schema.Struct({ "magnitude": Schema.optionalKey(Schema.Finite), "unit": Schema.optionalKey(Schema.String) }),
        ),
        "height": Schema.optionalKey(
          Schema.Struct({ "magnitude": Schema.optionalKey(Schema.Finite), "unit": Schema.optionalKey(Schema.String) }),
        ),
      }),
    ),
    "slideCount": Schema.optionalKey(Integer),
    "notesMasterId": Schema.optionalKey(Schema.String),
    "layouts": Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          "objectId": Schema.optionalKey(Schema.String),
          "kind": Schema.optionalKey(Schema.Literals(["master", "layout"])),
          "name": Schema.optionalKey(Schema.String),
          "displayName": Schema.optionalKey(Schema.String),
          "masterId": Schema.optionalKey(Schema.String),
          "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    ),
    "layoutsCursor": Schema.optionalKey(Schema.String),
    "slides": Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          "objectId": Schema.optionalKey(Schema.String),
          "index": Schema.optionalKey(Integer),
          "layout": Schema.optionalKey(Schema.String),
          "layoutId": Schema.optionalKey(Schema.String),
          "skipped": Schema.optionalKey(Schema.Boolean),
          "title": Schema.optionalKey(Schema.String),
          "elements": Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                "objectId": Schema.optionalKey(Schema.String),
                "kind": Schema.optionalKey(
                  Schema.Literals(["shape", "table", "wordArt", "image", "video", "chart", "line", "other"]),
                ),
                "placeholder": Schema.optionalKey(Schema.String),
                "text": Schema.optionalKey(Schema.String),
                "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
                "textCursor": Schema.optionalKey(Schema.String),
                "altText": Schema.optionalKey(Schema.String),
                "spreadsheetId": Schema.optionalKey(Schema.String),
              }),
            ),
          ),
          "omittedElements": Schema.optionalKey(Integer),
          "elementsCursor": Schema.optionalKey(Schema.String),
          "notesPageId": Schema.optionalKey(Schema.String),
          "notes": Schema.optionalKey(Schema.String),
          "notesCursor": Schema.optionalKey(Schema.String),
          "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    ),
    "page": Schema.optionalKey(
      Schema.Struct({ "hasMore": Schema.optionalKey(Schema.Boolean), "nextCursor": Schema.optionalKey(Schema.String) }),
    ),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const get_page = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "pageObjectId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_][A-Za-z0-9_:-]*$")),
    ).annotate({ "description": "A slide's, layout's, master's, or notes page's objectId." }),
    "limit": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)).annotate({
        "default": 50,
        "description": "Elements per page, 1 to 500; defaults to 50. A page also ends before ~192 KB.",
      }),
    ),
    "cursor": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(4096), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description":
          "Opaque page.nextCursor, or a textCursor-style cursor, this connection returned. Pass it back unchanged.",
      }),
    ),
  }),
  output: Schema.Struct({
    "presentationId": Schema.optionalKey(Schema.String),
    "pageObjectId": Schema.optionalKey(Schema.String),
    "revisionId": Schema.optionalKey(Schema.String),
    "pageType": Schema.optionalKey(Schema.String),
    "layoutId": Schema.optionalKey(Schema.String),
    "masterId": Schema.optionalKey(Schema.String),
    "notesPageId": Schema.optionalKey(Schema.String),
    "skipped": Schema.optionalKey(Schema.Boolean),
    "speakerNotesObjectId": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "displayName": Schema.optionalKey(Schema.String),
    "elementCount": Schema.optionalKey(Integer),
    "properties": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    "elements": Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          "objectId": Schema.optionalKey(Schema.String),
          "kind": Schema.optionalKey(
            Schema.Literals(["shape", "table", "wordArt", "image", "video", "chart", "line", "other"]),
          ),
          "groupId": Schema.optionalKey(Schema.String),
          "placeholder": Schema.optionalKey(Schema.String),
          "placeholderIndex": Schema.optionalKey(Integer),
          "placeholderParentId": Schema.optionalKey(Schema.String),
          "text": Schema.optionalKey(Schema.String),
          "textOffset": Schema.optionalKey(Integer),
          "textLength": Schema.optionalKey(Integer),
          "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
          "altText": Schema.optionalKey(Schema.String),
          "spreadsheetId": Schema.optionalKey(Schema.String),
        }),
      ),
    ),
    "page": Schema.optionalKey(
      Schema.Struct({ "hasMore": Schema.optionalKey(Schema.Boolean), "nextCursor": Schema.optionalKey(Schema.String) }),
    ),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const list_layouts = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "limit": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)).annotate({
        "default": 100,
        "description": "Masters and layouts per page, 1 to 500; defaults to 100. A page also ends before ~192 KB.",
      }),
    ),
    "cursor": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(4096), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description":
          "Opaque page.nextCursor, or a textCursor-style cursor, this connection returned. Pass it back unchanged.",
      }),
    ),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "notesMasterId": Schema.optionalKey(Schema.String),
    "page": Schema.Struct({
      "hasMore": Schema.Boolean,
      "nextCursor": Schema.optionalKey(Schema.String),
      "total": Schema.optionalKey(Integer),
    }),
    "items": Schema.Array(
      Schema.Struct({
        "objectId": Schema.optionalKey(Schema.String),
        "kind": Schema.optionalKey(Schema.Literals(["master", "layout"])),
        "name": Schema.optionalKey(Schema.String),
        "displayName": Schema.optionalKey(Schema.String),
        "masterId": Schema.optionalKey(Schema.String),
        "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const list_comments = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "pageObjectId": Schema.optionalKey(
      Schema.String.check(
        isMinChars(1),
        isMaxChars(256),
        matchesPattern(new RegExp("^[A-Za-z0-9_][A-Za-z0-9_:-]*$")),
      ).annotate({ "description": "Only this slide's or notes page's threads; omit for the whole deck." }),
    ),
    "limit": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)).annotate({
        "default": 50,
        "description": "Threads per page, 1 to 500; defaults to 50. A page also ends before ~192 KB.",
      }),
    ),
    "cursor": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(4096), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description":
          "Opaque page.nextCursor, or a textCursor-style cursor, this connection returned. Pass it back unchanged.",
      }),
    ),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "pageObjectId": Schema.optionalKey(Schema.String),
    "revisionId": Schema.optionalKey(Schema.String),
    "page": Schema.Struct({
      "hasMore": Schema.Boolean,
      "nextCursor": Schema.optionalKey(Schema.String),
      "total": Schema.optionalKey(Integer),
    }),
    "items": Schema.Array(
      Schema.Struct({
        "commentId": Schema.optionalKey(Schema.String),
        "anchorId": Schema.optionalKey(Schema.String),
        "status": Schema.optionalKey(Schema.String),
        "pageObjectIds": Schema.optionalKey(Schema.Array(Schema.String)),
        "objectIds": Schema.optionalKey(Schema.Array(Schema.String)),
        "replyCount": Schema.optionalKey(Integer),
        "quote": Schema.optionalKey(Schema.String),
        "quoteOffset": Schema.optionalKey(Integer),
        "quoteLength": Schema.optionalKey(Integer),
        "headPost": Schema.optionalKey(
          Schema.Struct({
            "postId": Schema.optionalKey(Schema.String),
            "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
            "author": Schema.optionalKey(
              Schema.Struct({
                "user": Schema.optionalKey(Schema.String),
                "displayName": Schema.optionalKey(Schema.String),
                "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
                "me": Schema.optionalKey(Schema.Boolean),
                "anonymous": Schema.optionalKey(Schema.Boolean),
              }),
            ),
            "content": Schema.optionalKey(Schema.String),
            "contentOffset": Schema.optionalKey(Integer),
            "contentLength": Schema.optionalKey(Integer),
            "commentAction": Schema.optionalKey(Schema.String),
            "assigneeEmail": Schema.optionalKey(Schema.String),
            "createTime": Schema.optionalKey(Schema.String),
            "updateTime": Schema.optionalKey(Schema.String),
            "deleted": Schema.optionalKey(Schema.Boolean),
            "imported": Schema.optionalKey(Schema.Boolean),
          }),
        ),
        "replies": Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              "postId": Schema.optionalKey(Schema.String),
              "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
              "author": Schema.optionalKey(
                Schema.Struct({
                  "user": Schema.optionalKey(Schema.String),
                  "displayName": Schema.optionalKey(Schema.String),
                  "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
                  "me": Schema.optionalKey(Schema.Boolean),
                  "anonymous": Schema.optionalKey(Schema.Boolean),
                }),
              ),
              "content": Schema.optionalKey(Schema.String),
              "contentOffset": Schema.optionalKey(Integer),
              "contentLength": Schema.optionalKey(Integer),
              "commentAction": Schema.optionalKey(Schema.String),
              "assigneeEmail": Schema.optionalKey(Schema.String),
              "createTime": Schema.optionalKey(Schema.String),
              "updateTime": Schema.optionalKey(Schema.String),
              "deleted": Schema.optionalKey(Schema.Boolean),
              "imported": Schema.optionalKey(Schema.Boolean),
            }),
          ),
        ),
        "repliesOffset": Schema.optionalKey(Integer),
        "continued": Schema.optionalKey(Schema.Boolean),
        "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
        "idsNotShown": Schema.optionalKey(Schema.Boolean),
      }),
    ),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const get_slide_thumbnail = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "slideObjectId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_][A-Za-z0-9_:-]*$")),
    ).annotate({ "description": "Slide objectId from get_presentation." }),
    "size": Schema.optionalKey(
      Schema.Literals(["SMALL", "MEDIUM", "LARGE", "WIDTH2000_PX"]).annotate({
        "description":
          "Width: SMALL 200px, MEDIUM 800px, LARGE 1600px, WIDTH2000_PX 2000px; Slides chooses when omitted.",
      }),
    ),
  }),
  output: Schema.Struct({
    "contentUrl": Schema.optionalKey(Schema.String),
    "width": Schema.optionalKey(Integer),
    "height": Schema.optionalKey(Integer),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const create_presentation = {
  input: Schema.Struct({
    "title": Schema.String.check(isMinChars(1), isMaxChars(1000), matchesPattern(new RegExp("^[^\\r\\n]*$"))).annotate({
      "description": "The deck's title, as Drive shows it.",
    }),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "title": Schema.optionalKey(Schema.String),
    "url": Schema.optionalKey(Schema.String),
    "slideObjectIds": Schema.optionalKey(Schema.Array(Schema.String)),
    "slideObjectIdsNotShown": Schema.optionalKey(Integer),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const create_slide = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "layout": Schema.optionalKey(
      Schema.Literals([
        "BLANK",
        "CAPTION_ONLY",
        "TITLE",
        "TITLE_AND_BODY",
        "TITLE_AND_TWO_COLUMNS",
        "TITLE_ONLY",
        "SECTION_HEADER",
        "SECTION_TITLE_AND_DESCRIPTION",
        "ONE_COLUMN_TEXT",
        "MAIN_POINT",
        "BIG_NUMBER",
      ]).annotate({
        "description": "Predefined layout; the deck's theme must have it. Omit both layout and layoutId for BLANK.",
      }),
    ),
    "layoutId": Schema.optionalKey(
      Schema.String.check(
        isMinChars(1),
        isMaxChars(256),
        matchesPattern(new RegExp("^[A-Za-z0-9_][A-Za-z0-9_:-]*$")),
      ).annotate({ "description": "A layouts[].objectId from get_presentation, instead of layout." }),
    ),
    "insertionIndex": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100000)).annotate({
        "description": "0-based position, as get_presentation numbers slides; omit to append.",
      }),
    ),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "slideObjectId": Schema.String,
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const replace_all_text = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "replacements": Schema.Array(
      Schema.Struct({
        "find": Schema.String.check(isMinChars(1), isMaxChars(1000)).annotate({
          "description": "Literal text to find.",
        }),
        "replace": Schema.String.check(isMaxChars(10000)).annotate({
          "description": "Replacement; empty deletes the match.",
        }),
        "matchCase": Schema.optionalKey(
          Schema.Boolean.annotate({ "description": "Case-sensitive; defaults to true." }),
        ),
      }).annotate({ "description": "One find-and-replace." }),
    )
      .check(Schema.isMinLength(1), Schema.isMaxLength(50))
      .annotate({ "description": "Applied in order, 1 to 50 (connecta's bound)." }),
    "slideObjectIds": Schema.optionalKey(
      Schema.Array(
        Schema.String.check(
          isMinChars(1),
          isMaxChars(256),
          matchesPattern(new RegExp("^[A-Za-z0-9_][A-Za-z0-9_:-]*$")),
        ).annotate({ "description": "A slide objectId." }),
      )
        .check(Schema.isMinLength(1), Schema.isMaxLength(500))
        .annotate({ "description": "Limit to these slides; omit for every slide." }),
    ),
    "requiredRevisionId": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(512), matchesPattern(new RegExp("^[^\\s]+$"))).annotate({
        "description": "revisionId from get_presentation; the write is refused, unapplied, if the deck changed since.",
      }),
    ),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "occurrencesChanged": Integer,
    "replacements": Schema.Array(
      Schema.Struct({ "find": Schema.optionalKey(Schema.String), "occurrencesChanged": Schema.optionalKey(Integer) }),
    ),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const create_comment = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "objectId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_][A-Za-z0-9_:-]*$")),
    ).annotate({ "description": "The page or element to comment on: the shape or table, for text or a cell." }),
    "content": Schema.String.check(isMinChars(1), isMaxChars(2048)).annotate({
      "description": "Plain text; Slides' cap is 2048 UTF-8 bytes.",
    }),
    "textRange": Schema.optionalKey(
      Schema.Struct({
        "startIndex": Integer.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10000000)).annotate({
          "description": "First character.",
        }),
        "endIndex": Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10000000)).annotate({
          "description": "One past the last.",
        }),
      }).annotate({ "description": "Anchor to this text of the shape, or of the cell: 0-based, end exclusive." }),
    ),
    "cell": Schema.optionalKey(
      Schema.Struct({
        "rowIndex": Integer.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100000)).annotate({
          "description": "Row.",
        }),
        "columnIndex": Integer.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100000)).annotate({
          "description": "Column.",
        }),
      }).annotate({ "description": "A table cell, 0-based: with textRange, that text in it; else the whole cell." }),
    ),
    "assigneeEmail": Schema.optionalKey(
      Schema.String.check(isMinChars(3), isMaxChars(320), matchesPattern(new RegExp("^[^\\s@]+@[^\\s@]+$"))).annotate({
        "description": "Assign the thread to this address; Slides notifies them.",
      }),
    ),
    "requiredRevisionId": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(512), matchesPattern(new RegExp("^[^\\s]+$"))).annotate({
        "description": "Refuse, unapplied, if the deck changed since this revision.",
      }),
    ),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "commentUpdateState": Schema.optionalKey(Schema.String),
    "note": Schema.optionalKey(Schema.String),
    "commentId": Schema.optionalKey(Schema.String),
    "anchorId": Schema.optionalKey(Schema.String),
    "status": Schema.optionalKey(Schema.String),
    "quote": Schema.optionalKey(Schema.String),
    "headPost": Schema.optionalKey(
      Schema.Struct({
        "postId": Schema.optionalKey(Schema.String),
        "author": Schema.optionalKey(
          Schema.Struct({
            "user": Schema.optionalKey(Schema.String),
            "displayName": Schema.optionalKey(Schema.String),
            "me": Schema.optionalKey(Schema.Boolean),
            "anonymous": Schema.optionalKey(Schema.Boolean),
          }),
        ),
        "content": Schema.optionalKey(Schema.String),
        "contentOffset": Schema.optionalKey(Integer),
        "contentLength": Schema.optionalKey(Integer),
        "commentAction": Schema.optionalKey(Schema.String),
        "assigneeEmail": Schema.optionalKey(Schema.String),
        "createTime": Schema.optionalKey(Schema.String),
        "updateTime": Schema.optionalKey(Schema.String),
        "deleted": Schema.optionalKey(Schema.Boolean),
        "imported": Schema.optionalKey(Schema.Boolean),
      }),
    ),
    "replies": Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          "postId": Schema.optionalKey(Schema.String),
          "author": Schema.optionalKey(
            Schema.Struct({
              "user": Schema.optionalKey(Schema.String),
              "displayName": Schema.optionalKey(Schema.String),
              "me": Schema.optionalKey(Schema.Boolean),
              "anonymous": Schema.optionalKey(Schema.Boolean),
            }),
          ),
          "content": Schema.optionalKey(Schema.String),
          "contentOffset": Schema.optionalKey(Integer),
          "contentLength": Schema.optionalKey(Integer),
          "commentAction": Schema.optionalKey(Schema.String),
          "assigneeEmail": Schema.optionalKey(Schema.String),
          "createTime": Schema.optionalKey(Schema.String),
          "updateTime": Schema.optionalKey(Schema.String),
          "deleted": Schema.optionalKey(Schema.Boolean),
          "imported": Schema.optionalKey(Schema.Boolean),
        }),
      ),
    ),
    "idsNotShown": Schema.optionalKey(Schema.Boolean),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const create_comment_reply = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "commentId": Schema.String.check(isMinChars(1), isMaxChars(1024), matchesPattern(new RegExp("^\\S+$"))).annotate({
      "description": "commentId from list_comments or create_comment.",
    }),
    "content": Schema.String.check(isMinChars(1), isMaxChars(2048)).annotate({
      "description": "Plain text, up to 2048 UTF-8 bytes.",
    }),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "commentUpdateState": Schema.optionalKey(Schema.String),
    "note": Schema.optionalKey(Schema.String),
    "commentId": Schema.String,
    "post": Schema.optionalKey(
      Schema.Struct({
        "postId": Schema.optionalKey(Schema.String),
        "author": Schema.optionalKey(
          Schema.Struct({
            "user": Schema.optionalKey(Schema.String),
            "displayName": Schema.optionalKey(Schema.String),
            "me": Schema.optionalKey(Schema.Boolean),
            "anonymous": Schema.optionalKey(Schema.Boolean),
          }),
        ),
        "content": Schema.optionalKey(Schema.String),
        "contentOffset": Schema.optionalKey(Integer),
        "contentLength": Schema.optionalKey(Integer),
        "commentAction": Schema.optionalKey(Schema.String),
        "assigneeEmail": Schema.optionalKey(Schema.String),
        "createTime": Schema.optionalKey(Schema.String),
        "updateTime": Schema.optionalKey(Schema.String),
        "deleted": Schema.optionalKey(Schema.Boolean),
        "imported": Schema.optionalKey(Schema.Boolean),
      }),
    ),
    "idsNotShown": Schema.optionalKey(Schema.Boolean),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const update_comment_thread = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "commentId": Schema.String.check(isMinChars(1), isMaxChars(1024), matchesPattern(new RegExp("^\\S+$"))).annotate({
      "description": "commentId from list_comments or create_comment.",
    }),
    "status": Schema.optionalKey(
      Schema.Literals(["RESOLVED", "OPEN"]).annotate({ "description": "Resolve the thread, or reopen it." }),
    ),
    "assigneeEmail": Schema.optionalKey(
      Schema.String.check(isMinChars(3), isMaxChars(320), matchesPattern(new RegExp("^[^\\s@]+@[^\\s@]+$"))).annotate({
        "description": "Reassign an assigned thread instead; needs content.",
      }),
    ),
    "content": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(2048)).annotate({
        "description": "Note posted with it, up to 2048 UTF-8 bytes; required to reassign.",
      }),
    ),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "commentUpdateState": Schema.optionalKey(Schema.String),
    "note": Schema.optionalKey(Schema.String),
    "commentId": Schema.String,
    "post": Schema.optionalKey(
      Schema.Struct({
        "postId": Schema.optionalKey(Schema.String),
        "author": Schema.optionalKey(
          Schema.Struct({
            "user": Schema.optionalKey(Schema.String),
            "displayName": Schema.optionalKey(Schema.String),
            "me": Schema.optionalKey(Schema.Boolean),
            "anonymous": Schema.optionalKey(Schema.Boolean),
          }),
        ),
        "content": Schema.optionalKey(Schema.String),
        "contentOffset": Schema.optionalKey(Integer),
        "contentLength": Schema.optionalKey(Integer),
        "commentAction": Schema.optionalKey(Schema.String),
        "assigneeEmail": Schema.optionalKey(Schema.String),
        "createTime": Schema.optionalKey(Schema.String),
        "updateTime": Schema.optionalKey(Schema.String),
        "deleted": Schema.optionalKey(Schema.Boolean),
        "imported": Schema.optionalKey(Schema.Boolean),
      }),
    ),
    "idsNotShown": Schema.optionalKey(Schema.Boolean),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const update_comment_post = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "commentId": Schema.String.check(isMinChars(1), isMaxChars(1024), matchesPattern(new RegExp("^\\S+$"))).annotate({
      "description": "commentId from list_comments or create_comment.",
    }),
    "postId": Schema.String.check(isMinChars(1), isMaxChars(1024), matchesPattern(new RegExp("^\\S+$"))).annotate({
      "description": "postId of the post, from list_comments.",
    }),
    "content": Schema.String.check(isMinChars(1), isMaxChars(2048)).annotate({
      "description": "The new plain text, up to 2048 UTF-8 bytes.",
    }),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "commentUpdateState": Schema.optionalKey(Schema.String),
    "note": Schema.optionalKey(Schema.String),
    "commentId": Schema.String,
    "postId": Schema.String,
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const delete_comment = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "commentId": Schema.String.check(isMinChars(1), isMaxChars(1024), matchesPattern(new RegExp("^\\S+$"))).annotate({
      "description": "commentId from list_comments or create_comment.",
    }),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "commentUpdateState": Schema.optionalKey(Schema.String),
    "note": Schema.optionalKey(Schema.String),
    "commentId": Schema.String,
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const delete_comment_reply = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "commentId": Schema.String.check(isMinChars(1), isMaxChars(1024), matchesPattern(new RegExp("^\\S+$"))).annotate({
      "description": "commentId from list_comments or create_comment.",
    }),
    "postId": Schema.String.check(isMinChars(1), isMaxChars(1024), matchesPattern(new RegExp("^\\S+$"))).annotate({
      "description": "postId of the reply, from list_comments.",
    }),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "commentUpdateState": Schema.optionalKey(Schema.String),
    "note": Schema.optionalKey(Schema.String),
    "commentId": Schema.String,
    "postId": Schema.String,
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const batch_update_presentation = {
  input: Schema.Struct({
    "presentationId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Presentation id: the part after /presentation/d/ in its URL, or from Drive." }),
    "requiredRevisionId": Schema.String.check(
      isMinChars(1),
      isMaxChars(512),
      matchesPattern(new RegExp("^[^\\s]+$")),
    ).annotate({
      "description": "revisionId from get_presentation; the write is refused, unapplied, if the deck changed since.",
    }),
    "requests": Schema.Array(
      Schema.Record(Schema.String, Schema.Unknown)
        .check(
          Schema.makeFilter((value: Readonly<Record<string, unknown>>) => Object.keys(value).length >= 1, {
            expected: "minProperties 1",
            toJsonSchema: () => ({ minProperties: 1 }),
          }),
          Schema.makeFilter((value: Readonly<Record<string, unknown>>) => Object.keys(value).length <= 1, {
            expected: "maxProperties 1",
            toJsonSchema: () => ({ maxProperties: 1 }),
          }),
        )
        .annotate({
          "description": 'One Request with one key, as the Slides reference defines it: {"insertText": {...}}.',
        }),
    )
      .check(Schema.isMinLength(1), Schema.isMaxLength(100))
      .annotate({
        "description":
          "Slides Request objects, applied in order, all or none but comments; 1 to 100 (connecta's bound).",
      }),
  }),
  output: Schema.Struct({
    "presentationId": Schema.String,
    "revisionId": Schema.optionalKey(Schema.String),
    "replies": Schema.Array(Schema.Struct({ "truncated": Schema.optionalKey(Schema.Array(Schema.String)) })),
    "commentUpdateState": Schema.optionalKey(Schema.String),
    "note": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
  }),
};

export const LayoutRow = list_layouts.output.fields.items.value;
export const CommentRow = list_comments.output.fields.items.value;
